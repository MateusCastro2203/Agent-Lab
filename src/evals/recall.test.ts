import { test } from "node:test";
import assert from "node:assert/strict";
import type { GoldenRow } from "./golden.ts";
import { scoreRecall } from "./recall.ts";

function row(over: Partial<GoldenRow> = {}): GoldenRow {
  return {
    id: "q001",
    question: "How do I make a query parameter optional?",
    type: "how_to",
    sections: ["a#1"],
    url: "https://example.com/a/#1",
    note: "n",
    line: 1,
    ...over,
  };
}

/** 20 in-scope rows with distinct ids and golds, so the denominator is valid. */
function twentyInScope(): GoldenRow[] {
  return Array.from({ length: 20 }, (_, i) =>
    row({
      id: `q${String(i + 1).padStart(3, "0")}`,
      question: `question ${i}`,
      sections: [`s${i}#g`],
    }),
  );
}

function allHit(rows: GoldenRow[]): Map<string, string[]> {
  return new Map(rows.map((r) => [r.id, [r.sections[0]!]]));
}

test("a gold at rank k counts as a hit", () => {
  const rows = twentyInScope();
  const retrieved = allHit(rows);
  const first = rows[0]!;
  retrieved.set(first.id, ["x#1", "x#2", "x#3", "x#4", first.sections[0]!]);
  const report = scoreRecall(rows, retrieved, 5);
  assert.equal(report.rows.find((r) => r.id === first.id)!.hit, true);
  assert.equal(report.rows.find((r) => r.id === first.id)!.goldRank, 5);
});

test("a gold at rank k+1 does not count, but its rank is still recorded", () => {
  const rows = twentyInScope();
  const retrieved = allHit(rows);
  const first = rows[0]!;
  retrieved.set(first.id, ["x#1", "x#2", "x#3", "x#4", "x#5", first.sections[0]!]);
  const report = scoreRecall(rows, retrieved, 5);
  const result = report.rows.find((r) => r.id === first.id)!;
  assert.equal(result.hit, false);
  assert.equal(result.goldRank, 6);
  assert.equal(report.hits, 19);
  assert.equal(report.recallAt5, 0.95);
});

test("a multi-entry gold hits on any member", () => {
  const rows = twentyInScope();
  rows[0]!.sections = ["s0#g", "s0#alt"];
  const retrieved = allHit(rows);
  retrieved.set(rows[0]!.id, ["x#1", "s0#alt"]);
  const report = scoreRecall(rows, retrieved, 5);
  assert.equal(report.rows[0]!.hit, true);
  assert.equal(report.rows[0]!.goldRank, 2);
});

test("multi-entry gold takes the best rank, not the first listed", () => {
  const rows = twentyInScope();
  rows[0]!.sections = ["s0#late", "s0#early"];
  const retrieved = allHit(rows);
  retrieved.set(rows[0]!.id, ["x#1", "s0#early", "x#3", "x#4", "x#5", "s0#late"]);
  const report = scoreRecall(rows, retrieved, 5);
  // "s0#early" is at rank 2, "s0#late" at rank 6. Math.min picks rank 2.
  // If Math.min were replaced with ranks[0], goldRank would be 6 and hit would be false.
  assert.equal(report.rows[0]!.goldRank, 2);
  assert.equal(report.rows[0]!.hit, true);
});

test("goldRank is null when no gold appears at all", () => {
  const rows = twentyInScope();
  const retrieved = allHit(rows);
  retrieved.set(rows[0]!.id, ["x#1", "x#2"]);
  const report = scoreRecall(rows, retrieved, 5);
  assert.equal(report.rows[0]!.goldRank, null);
  assert.equal(report.rows[0]!.hit, false);
});

test("out_of_scope rows are excluded from the report entirely", () => {
  const rows = [
    ...twentyInScope(),
    row({ id: "q021", question: "django?", type: "out_of_scope", sections: [], url: undefined }),
  ];
  const report = scoreRecall(rows, allHit(rows), 5);
  assert.equal(report.total, 20);
  assert.equal(report.rows.length, 20);
  assert.deepEqual(report.rows.filter((r) => r.id === "q021"), []);
});

test("a denominator other than 20 throws", () => {
  const rows = twentyInScope().slice(0, 19);
  assert.throws(() => scoreRecall(rows, allHit(rows), 5), /19 in-scope rows, expected 20/);
});

test("a row with no retrieval entry throws rather than scoring as a miss", () => {
  const rows = twentyInScope();
  const retrieved = allHit(rows);
  retrieved.delete(rows[3]!.id);
  assert.throws(() => scoreRecall(rows, retrieved, 5), /no retrieval recorded for q004/);
});

test("all hits gives recall 1, none gives 0", () => {
  const rows = twentyInScope();
  assert.equal(scoreRecall(rows, allHit(rows), 5).recallAt5, 1);
  const none = new Map(rows.map((r) => [r.id, ["nope#1"]]));
  assert.equal(scoreRecall(rows, none, 5).recallAt5, 0);
});
