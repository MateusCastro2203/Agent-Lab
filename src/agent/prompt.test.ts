import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGolden, normalizeQuestion, GOLDEN_TYPES } from "../evals/golden.ts";
import { FEW_SHOT, SYSTEM_PROMPT, renderSystem, promptHash } from "./prompt.ts";

function tokens(text: string): Set<string> {
  return new Set(normalizeQuestion(text).split(" ").filter((t) => t !== ""));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

// Adjacent word pairs, both longer than 3 characters. Short words ("is",
// "not", "the") pair up by chance across unrelated text; this is a tripwire
// for phrasing distinctive enough to matter.
function bigrams(text: string): Set<string> {
  const words = normalizeQuestion(text).split(" ").filter((t) => t !== "");
  const pairs = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) {
    const a = words[i];
    const b = words[i + 1];
    if (a !== undefined && b !== undefined && a.length > 3 && b.length > 3) {
      pairs.add(`${a} ${b}`);
    }
  }
  return pairs;
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

// The first leakage guard compared FEW_SHOT questions against golden
// questions, which is the golden set's wording. It could not catch a leak in
// the label definitions themselves, which live in SYSTEM_PROMPT and can echo
// a golden `note` — where the ruler's reasoning lives — instead of a
// question. The rule: the system prompt must not contain phrasing distinctive
// to a single golden row's adjudication. A bigram shared with two or more
// notes is ordinary English, not an answer key, so only a bigram that
// appears in exactly one note is checked against the prompt.
test("the system prompt names no phrasing distinctive to a single golden row", () => {
  const systemBigrams = bigrams(SYSTEM_PROMPT);

  const rowsByBigram = new Map<string, string[]>();
  for (const row of golden) {
    for (const pair of bigrams(row.note)) {
      const rows = rowsByBigram.get(pair) ?? [];
      rows.push(row.id);
      rowsByBigram.set(pair, rows);
    }
  }

  const offenders: string[] = [];
  for (const [pair, rows] of rowsByBigram) {
    if (rows.length === 1 && systemBigrams.has(pair)) {
      offenders.push(`"${pair}" (${rows[0]})`);
    }
  }

  assert.equal(offenders.length, 0, `distinctive phrasing leaked into the system prompt: ${offenders.join(", ")}`);
});

test("the prompt hash is stable and 64 hex characters", () => {
  assert.match(promptHash(), /^[0-9a-f]{64}$/);
  assert.equal(promptHash(), promptHash());
});
