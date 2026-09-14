import { GOLDEN_TYPES, type GoldenRow, type GoldenType } from "./golden.ts";

export interface ClassRow {
  id: string;
  question: string;
  expected: GoldenType;
  predicted: GoldenType;
  correct: boolean;
}

export interface ClassBreakdown {
  label: GoldenType;
  correct: number;
  total: number;
  accuracy: number;
}

export interface AccuracyReport {
  accuracy: number;
  correct: number;
  total: number;
  perClass: ClassBreakdown[];
  rows: ClassRow[];
}

export interface Spread {
  min: number;
  median: number;
  max: number;
}

export interface RunSummary {
  runs: number;
  overall: Spread;
  perClass: Record<GoldenType, Spread>;
}

export const EXPECTED_ROWS = 30;

export function scoreAccuracy(
  rows: GoldenRow[],
  predictions: Map<string, GoldenType>,
): AccuracyReport {
  // A different denominator means the golden set changed, so the number is no
  // longer comparable to earlier runs. Fail rather than publish it.
  if (rows.length !== EXPECTED_ROWS) {
    throw new Error(`golden set has ${rows.length} rows, expected ${EXPECTED_ROWS}`);
  }

  const results: ClassRow[] = rows.map((row) => {
    const predicted = predictions.get(row.id);
    if (predicted === undefined) {
      throw new Error(`no prediction recorded for ${row.id}`);
    }
    return {
      id: row.id,
      question: row.question,
      expected: row.type,
      predicted,
      correct: predicted === row.type,
    };
  });

  const perClass: ClassBreakdown[] = GOLDEN_TYPES.map((label) => {
    const of = results.filter((r) => r.expected === label);
    const correct = of.filter((r) => r.correct).length;
    return { label, correct, total: of.length, accuracy: of.length === 0 ? 0 : correct / of.length };
  });

  const correct = results.filter((r) => r.correct).length;
  return { accuracy: correct / results.length, correct, total: results.length, perClass, rows: results };
}

function spread(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { min: sorted[0]!, median, max: sorted[sorted.length - 1]! };
}

// temperature 0 does not make a local model bit-reproducible. Without the
// spread, the first difference between two future measurements is
// unattributable: a better prompt and the model breathing look identical.
export function summarize(reports: AccuracyReport[]): RunSummary {
  if (reports.length === 0) throw new Error("summarize needs at least one run");

  const perClass = {} as Record<GoldenType, Spread>;
  for (const label of GOLDEN_TYPES) {
    perClass[label] = spread(
      reports.map((r) => r.perClass.find((c) => c.label === label)?.accuracy ?? 0),
    );
  }

  return {
    runs: reports.length,
    overall: spread(reports.map((r) => r.accuracy)),
    perClass,
  };
}
