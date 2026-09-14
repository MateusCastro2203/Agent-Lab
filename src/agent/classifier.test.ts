import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { classifierWith, ClassifyFailedError, AGENT_MODEL } from "./classifier.ts";
import { renderSystem } from "./prompt.ts";

function replying(text: string, calls = { n: 0 }): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      calls.n++;
      return {
        content: [{ type: "text" as const, text }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
}

test("a valid label round-trips", async () => {
  const model = replying(JSON.stringify({ label: "concept" }));
  assert.equal(await classifierWith(model).classify("Why does this exist?"), "concept");
});

// The seam that matters: the question must reach the model, and the rendered
// system prompt must go with it. Without this a refactor could silently send
// the question with no examples and nothing would fail.
test("the question and the rendered system prompt reach the model at temperature 0", async () => {
  const model = replying(JSON.stringify({ label: "how_to" }));
  await classifierWith(model).classify("How do I do the thing?");

  const call = model.doGenerateCalls[0]!;
  assert.equal(call.temperature, 0);
  const serialized = JSON.stringify(call.prompt);
  assert.ok(serialized.includes("How do I do the thing?"), serialized.slice(0, 200));
  assert.ok(serialized.includes(renderSystem().slice(0, 40)), "system prompt missing");
});

test("a label outside the enum is rejected rather than returned", async () => {
  const model = replying(JSON.stringify({ label: "maybe" }));
  await assert.rejects(() => classifierWith(model).classify("q"), ClassifyFailedError);
});

// One retry, then abort. Counting a format failure as a wrong answer would
// fold "cannot classify" and "cannot emit JSON" into one number.
test("it retries exactly once before failing", async () => {
  const calls = { n: 0 };
  const model = replying("not json at all", calls);
  await assert.rejects(() => classifierWith(model).classify("q"), ClassifyFailedError);
  assert.equal(calls.n, 2, `expected 2 attempts, got ${calls.n}`);
});

test("the second attempt is allowed to succeed", async () => {
  let n = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      n++;
      return {
        content: [{ type: "text" as const, text: n === 1 ? "garbage" : JSON.stringify({ label: "out_of_scope" }) }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  assert.equal(await classifierWith(model).classify("q"), "out_of_scope");
  assert.equal(n, 2);
});

test("AGENT_MODEL is pinned to a non-empty constant", () => {
  assert.ok(AGENT_MODEL.length > 0);
});
