import type { GoldenRow } from "./golden.ts";

export interface RowResult {
  id: string;
  question: string;
  hit: boolean;
  gold: string[];
  /** The top k retrieved ids, in rank order. */
  retrieved: string[];
  /** 1-based rank of the best gold hit, recorded even when it exceeds k. */
  goldRank: number | null;
}

export interface RecallReport {
  k: number;
  hits: number;
  total: number;
  recallAt5: number;
  rows: RowResult[];
}

export const EXPECTED_IN_SCOPE = 20;

export function scoreRecall(
  rows: GoldenRow[],
  retrievedByRowId: Map<string, string[]>,
  k: number,
): RecallReport {
  const inScope = rows.filter((row) => row.type !== "out_of_scope");

  // A different denominator means the golden set changed, so the number is no
  // longer comparable to earlier runs. Fail rather than publish it.
  if (inScope.length !== EXPECTED_IN_SCOPE) {
    throw new Error(
      `golden set has ${inScope.length} in-scope rows, expected ${EXPECTED_IN_SCOPE}`,
    );
  }

  const results: RowResult[] = inScope.map((row) => {
    const retrieved = retrievedByRowId.get(row.id);
    if (retrieved === undefined) {
      throw new Error(`no retrieval recorded for ${row.id}`);
    }

    // Rank over everything retrieved, so a miss still reports how far off it
    // was — 7th and 400th are different problems.
    const ranks = row.sections
      .map((gold) => retrieved.indexOf(gold))
      .filter((index) => index >= 0)
      .map((index) => index + 1);
    const goldRank = ranks.length > 0 ? Math.min(...ranks) : null;

    return {
      id: row.id,
      question: row.question,
      hit: goldRank !== null && goldRank <= k,
      gold: row.sections,
      retrieved: retrieved.slice(0, k),
      goldRank,
    };
  });

  const hits = results.filter((r) => r.hit).length;
  return { k, hits, total: results.length, recallAt5: hits / results.length, rows: results };
}
