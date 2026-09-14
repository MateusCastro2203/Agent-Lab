import { test } from "node:test";
import assert from "node:assert/strict";
import type { GoldenRow, GoldenType } from "./golden.ts";
import { scoreAccuracy, summarize, EXPECTED_ROWS } from "./accuracy.ts";

function rows(labels: GoldenType[]): GoldenRow[] {
  return labels.map((type, i) => ({
    id: `q${String(i + 1).padStart(3, "0")}`,
    question: `question ${i + 1}`,
    type,
    sections: [],
    note: "n",
    line: i + 1,
  }));
}

const TEN = <T>(v: T): T[] => new Array<T>(10).fill(v);
const THIRTY = rows([...TEN<GoldenType>("how_to"), ...TEN<GoldenType>("concept"), ...TEN<GoldenType>("out_of_scope")]);

function predict(fn: (row: GoldenRow) => GoldenType): Map<string, GoldenType> {
  return new Map(THIRTY.map((r) => [r.id, fn(r)]));
}

test("a perfect run scores 1", () => {
  const report = scoreAccuracy(THIRTY, predict((r) => r.type));
  assert.equal(report.accuracy, 1);
  assert.equal(report.correct, 30);
  assert.equal(report.total, 30);
  for (const cls of report.perClass) assert.equal(cls.accuracy, 1);
});

test("a run that always says how_to scores 10/30 and only that class", () => {
  const report = scoreAccuracy(THIRTY, predict(() => "how_to"));
  assert.equal(report.correct, 10);
  assert.ok(Math.abs(report.accuracy - 1 / 3) < 1e-9);
  const byLabel = new Map(report.perClass.map((c) => [c.label, c]));
  assert.equal(byLabel.get("how_to")!.accuracy, 1);
  assert.equal(byLabel.get("concept")!.accuracy, 0);
  assert.equal(byLabel.get("out_of_scope")!.accuracy, 0);
});

test("per-class support is ten each and rows carry both labels", () => {
  const report = scoreAccuracy(THIRTY, predict(() => "concept"));
  for (const cls of report.perClass) assert.equal(cls.total, 10);
  const row = report.rows.find((r) => r.id === "q001")!;
  assert.equal(row.expected, "how_to");
  assert.equal(row.predicted, "concept");
  assert.equal(row.correct, false);
});

// A wrong denominator means the golden set changed, so the number is no longer
// comparable to earlier runs.
test("a denominator other than thirty throws", () => {
  assert.throws(
    () => scoreAccuracy(THIRTY.slice(0, 29), predict((r) => r.type)),
    new RegExp(`29 rows, expected ${EXPECTED_ROWS}`),
  );
});

// Tolerating a missing prediction reports a number that is quietly measuring
// twenty-nine rows.
test("a missing prediction throws naming the row", () => {
  const partial = predict((r) => r.type);
  partial.delete("q017");
  assert.throws(() => scoreAccuracy(THIRTY, partial), /q017/);
});

test("summarize reports min, median and max across runs", () => {
  const a = scoreAccuracy(THIRTY, predict((r) => r.type));                       // 1.0
  const b = scoreAccuracy(THIRTY, predict(() => "how_to"));                      // 1/3
  const c = scoreAccuracy(THIRTY, predict((r) => (r.type === "concept" ? "how_to" : r.type))); // 20/30
  const s = summarize([a, b, c]);
  assert.ok(Math.abs(s.overall.min - 1 / 3) < 1e-9);
  assert.ok(Math.abs(s.overall.median - 2 / 3) < 1e-9);
  assert.equal(s.overall.max, 1);
  assert.equal(s.perClass.how_to.min, 1);
  assert.equal(s.perClass.concept.min, 0);
});

test("summarize refuses an empty list", () => {
  assert.throws(() => summarize([]), /at least one run/);
});

test("summarize throws if a report lacks a perClass entry for a label", () => {
  const report = scoreAccuracy(THIRTY, predict((r) => r.type));
  // Remove the "concept" entry from perClass
  const incomplete = {
    ...report,
    perClass: report.perClass.filter((c) => c.label !== "concept"),
  };
  assert.throws(() => summarize([incomplete]), /no perClass entry for label concept/);
});
