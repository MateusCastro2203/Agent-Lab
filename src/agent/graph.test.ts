import { test } from "node:test";
import assert from "node:assert/strict";
import type { GoldenType } from "../evals/golden.ts";
import type { Classifier } from "./classifier.ts";
import { buildGraph, makeClassifyNode, type RetrievedSection } from "./graph.ts";

function stubClassifier(label: GoldenType): Classifier {
  return { model: "stub", classify: async () => label };
}

function stubRetrieve() {
  const calls: string[] = [];
  const retrieve = async (question: string): Promise<RetrievedSection[]> => {
    calls.push(question);
    return [{ id: "tutorial/query-params.md#optional-parameters", score: 0.81 }];
  };
  return { retrieve, calls };
}

// The load-bearing claim of this whole design: the eval calls this without a
// graph runtime and without a database. If a node ever needs the runtime, the
// two rulers become coupled.
test("a node is callable on its own, with no graph and no database", async () => {
  const node = makeClassifyNode(stubClassifier("concept"));
  const out = await node({ question: "Why does this exist?", label: null, sections: [] });
  assert.equal(out.label, "concept");
});

for (const label of ["how_to", "concept"] as const) {
  test(`${label} routes to retrieve`, async () => {
    const r = stubRetrieve();
    const graph = buildGraph({ classifier: stubClassifier(label), retrieve: r.retrieve });
    const out = await graph.invoke({ question: "How do I X?", label: null, sections: [] });
    assert.deepEqual(r.calls, ["How do I X?"]);
    assert.equal(out.sections.length, 1);
    assert.equal(out.sections[0]!.id, "tutorial/query-params.md#optional-parameters");
  });
}

// Asserted against a stub that records whether it was called at all. Checking
// only that `sections` is empty would pass even if retrieve ran and returned
// nothing.
test("out_of_scope never reaches retrieve", async () => {
  const r = stubRetrieve();
  const graph = buildGraph({ classifier: stubClassifier("out_of_scope"), retrieve: r.retrieve });
  const out = await graph.invoke({ question: "Who won in 2018?", label: null, sections: [] });
  assert.deepEqual(r.calls, [], "retrieve was called for an out-of-scope question");
  assert.deepEqual(out.sections, []);
  assert.equal(out.label, "out_of_scope");
});
