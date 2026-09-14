import { createHash } from "node:crypto";
import { GOLDEN_TYPES, type GoldenType } from "../evals/golden.ts";

export interface FewShotExample {
  question: string;
  label: GoldenType;
}

export const SYSTEM_PROMPT = `You label one question about the FastAPI documentation with exactly one of three labels.

how_to — asks for the steps or the syntax to accomplish a task.
concept — asks what something is, why it exists, or how it behaves.
out_of_scope — cannot be answered from the FastAPI documentation covered here, which is only the tutorial, the advanced user guide, the how-to guides, and deployment. It is about a different library or framework, about something unrelated to web APIs, or about any other part of FastAPI or its documentation that falls outside those four sections.

Answer with the label only.`;

// Written for this prompt and absent from evals/golden.jsonl, which
// prompt.test.ts proves rather than asserts. Two per class: out_of_scope has
// internal structure the golden set is built on — adjacent but absent, off
// domain, and in domain but outside the vendored slice — and one example
// cannot carry it.
export const FEW_SHOT: readonly FewShotExample[] = [
  { question: "How do I add a description that shows up next to an endpoint in the docs?", label: "how_to" },
  { question: "How do I return a plain text response instead of JSON?", label: "how_to" },
  { question: "What does the `Annotated` type actually add to a parameter declaration?", label: "concept" },
  { question: "Why does the framework validate the response as well as the request?", label: "concept" },
  { question: "How do I add a custom middleware in Express?", label: "out_of_scope" },
  { question: "Which FastAPI version added support for Pydantic v2?", label: "out_of_scope" },
];

export function renderSystem(): string {
  const labels = GOLDEN_TYPES.join(", ");
  const examples = FEW_SHOT.map((e) => `Q: ${e.question}\nA: ${e.label}`).join("\n\n");
  return `${SYSTEM_PROMPT}\n\nThe labels are: ${labels}\n\nExamples:\n\n${examples}`;
}

// Same device as chunk 2a's schema fingerprint: without it an edited prompt
// produces a new number and leaves no trace that anything changed. Array order
// is part of the hash because reordering examples can change the result.
export function promptHash(): string {
  return createHash("sha256")
    .update(SYSTEM_PROMPT)
    .update(JSON.stringify(FEW_SHOT))
    .digest("hex");
}
