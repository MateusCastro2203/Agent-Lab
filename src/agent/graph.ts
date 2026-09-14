import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import type { GoldenType } from "../evals/golden.ts";
import type { Classifier } from "./classifier.ts";

export interface RetrievedSection {
  id: string;
  score: number;
}

export type Retrieve = (question: string) => Promise<RetrievedSection[]>;

export const AgentState = Annotation.Root({
  question: Annotation<string>,
  label: Annotation<GoldenType | null>({ reducer: (_, y) => y, default: () => null }),
  sections: Annotation<RetrievedSection[]>({ reducer: (_, y) => y, default: () => [] }),
});

export type AgentStateType = typeof AgentState.State;

// Returned as a plain function on purpose. scripts/eval-classify.ts calls this
// directly, with no graph runtime and no database — which is what keeps the
// classification ruler independent of the retrieval one.
export function makeClassifyNode(classifier: Classifier) {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => ({
    label: await classifier.classify(state.question),
  });
}

export function makeRetrieveNode(retrieve: Retrieve) {
  return async (state: AgentStateType): Promise<Partial<AgentStateType>> => ({
    sections: await retrieve(state.question),
  });
}

// The reason `classify` exists: a question the documentation cannot answer is
// never retrieved for.
export function route(state: AgentStateType): "retrieve" | typeof END {
  return state.label === "out_of_scope" ? END : "retrieve";
}

// Dependencies are parameters so the routing test runs against stubs.
export function buildGraph(deps: { classifier: Classifier; retrieve: Retrieve }) {
  return new StateGraph(AgentState)
    .addNode("classify", makeClassifyNode(deps.classifier))
    .addNode("retrieve", makeRetrieveNode(deps.retrieve))
    .addEdge(START, "classify")
    .addConditionalEdges("classify", route, { retrieve: "retrieve", [END]: END })
    .compile();
}
