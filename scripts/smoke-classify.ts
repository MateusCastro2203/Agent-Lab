import { generateObject } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { z } from "zod";
import { GOLDEN_TYPES } from "../src/evals/golden.ts";
import { ollamaUrl } from "../src/embed/provider.ts";

const CANDIDATES = ["qwen3:8b", "llama3.1:8b"];

// One question per class. These are smoke-test inputs, not golden rows, and
// they are never scored — the only question is whether the model returns a
// value inside the enum at all.
const PROBES = [
  { question: "How do I add a description that shows up next to an endpoint in the docs?", expect: "how_to" },
  { question: "Why does the framework validate the response as well as the request?", expect: "concept" },
  { question: "How do I add a custom middleware in Express?", expect: "out_of_scope" },
];

const schema = z.object({ label: z.enum(GOLDEN_TYPES) });
const provider = createOllama({ baseURL: `${ollamaUrl()}/api` });

for (const candidate of CANDIDATES) {
  console.log(`\n=== ${candidate}`);
  let ok = true;
  for (const probe of PROBES) {
    try {
      const { object } = await generateObject({
        model: provider(candidate),
        schema,
        system: "Label the question with exactly one of: how_to, concept, out_of_scope.",
        prompt: probe.question,
        temperature: 0,
      });
      // Schema validity is the pass criterion. Agreement with `expect` is
      // printed because it is useful to see, but a disagreement is a
      // classification result, not a format failure, and does not fail the
      // smoke test — that is what the eval measures.
      const agree = object.label === probe.expect ? "agrees" : `says ${object.label}, expected ${probe.expect}`;
      console.log(`  ok   schema-valid, ${agree}  <- ${probe.question}`);
    } catch (error) {
      ok = false;
      console.log(`  FAIL ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (ok) {
    console.log(`\nPINNED: ${candidate} returned a schema-valid label for all three classes.`);
    process.exit(0);
  }
  console.log(`  -> ${candidate} rejected`);
}

console.error(`\nNo candidate held the enum. Do not measure. Candidates tried: ${CANDIDATES.join(", ")}`);
process.exit(1);
