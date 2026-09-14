import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGolden, normalizeQuestion, GOLDEN_TYPES } from "../evals/golden.ts";
import { FEW_SHOT, renderSystem, promptHash } from "./prompt.ts";

function tokens(text: string): Set<string> {
  return new Set(normalizeQuestion(text).split(" ").filter((t) => t !== ""));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

const golden = await loadGolden();

// A few-shot example drawn from the ruler measures the model on questions it
// was shown. Chunk 2c found seven defective golden rows written under rules
// their author had written, so this is a test rather than a discipline.
test("no few-shot example is a golden question", () => {
  const goldenNormalized = new Map(golden.map((r) => [normalizeQuestion(r.question), r.id]));
  for (const example of FEW_SHOT) {
    const collision = goldenNormalized.get(normalizeQuestion(example.question));
    assert.equal(collision, undefined, `"${example.question}" is ${collision}`);
  }
});

// Equality is weak: "query parameter" and "query param" are the same question
// and differ exactly. The threshold is a tripwire, not a metric.
test("no few-shot example overlaps a golden question past 0.5", () => {
  let worst = { score: 0, example: "", row: "" };
  for (const example of FEW_SHOT) {
    const a = tokens(example.question);
    for (const row of golden) {
      const score = jaccard(a, tokens(row.question));
      if (score > worst.score) worst = { score, example: example.question, row: row.id };
    }
  }
  assert.ok(
    worst.score < 0.5,
    `closest pair scored ${worst.score.toFixed(2)}: "${worst.example}" vs ${worst.row}`,
  );
  console.log(`prompt.test.ts: closest few-shot/golden pair ${worst.score.toFixed(2)} (${worst.row})`);
});

// An unbalanced example set shifts the model's prior, and then per-class
// accuracy measures the prompt's shape rather than the model.
test("few-shot is balanced two per class", () => {
  for (const label of GOLDEN_TYPES) {
    assert.equal(FEW_SHOT.filter((e) => e.label === label).length, 2, label);
  }
  assert.equal(FEW_SHOT.length, 6);
});

test("the system prompt carries every example and names every label", () => {
  const system = renderSystem();
  for (const example of FEW_SHOT) assert.ok(system.includes(example.question), example.question);
  for (const label of GOLDEN_TYPES) assert.ok(system.includes(label), label);
});

test("the prompt hash is stable and 64 hex characters", () => {
  assert.match(promptHash(), /^[0-9a-f]{64}$/);
  assert.equal(promptHash(), promptHash());
});
