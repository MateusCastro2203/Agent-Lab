import { mkdir, writeFile } from "node:fs/promises";
import { fail } from "../src/cli.ts";
import { loadGolden } from "../src/evals/golden.ts";
import type { GoldenType } from "../src/evals/golden.ts";
import { validateGolden } from "../src/evals/validate.ts";
import { enumerateSections } from "../src/corpus/sections.ts";
import { AGENT_MODEL, TEMPERATURE, ClassifyFailedError, ollamaClassifier } from "../src/agent/classifier.ts";
import { makeClassifyNode } from "../src/agent/graph.ts";
import { FEW_SHOT, promptHash } from "../src/agent/prompt.ts";
import { scoreAccuracy, summarize, type AccuracyReport } from "../src/evals/accuracy.ts";

const RUNS = 3;

// Preconditions before any model call. This eval never touches the database —
// that is why it is a separate script from `npm run eval`, which refuses to
// start without 944 embedded rows.
const golden = await loadGolden();
const sections = await enumerateSections();
const problems = validateGolden(golden, sections, { enforceCounts: true }).filter((p) => p.fatal);
if (problems.length > 0) {
  fail(
    `the golden set does not validate, so it will not be scored:\n` +
      problems.map((p) => `  golden.jsonl:${p.line ?? "-"} [${p.kind}] ${p.message}`).join("\n"),
  );
}

const hash = promptHash();
// The graph node, called directly. No graph runtime, no database — this is the
// property that lets the two rulers stay independent, exercised in production
// code rather than only in a test.
const classifyNode = makeClassifyNode(ollamaClassifier());
const reports: AccuracyReport[] = [];

for (let run = 1; run <= RUNS; run++) {
  const predictions = new Map<string, GoldenType>();
  for (const row of golden) {
    try {
      const { label } = await classifyNode({ question: row.question, label: null, sections: [] });
      if (label === null || label === undefined) {
        fail(`run ${run}, ${row.id}: the classify node returned no label`);
      }
      predictions.set(row.id, label);
    } catch (error) {
      if (error instanceof ClassifyFailedError) {
        fail(`run ${run}, ${row.id}: ${error.message}\n\nNo number is reported from a torn run.`);
      }
      throw error;
    }
  }
  const report = scoreAccuracy(golden, predictions);
  reports.push(report);
  console.log(`run ${run}/${RUNS}: ${report.accuracy.toFixed(3)}  (${report.correct}/${report.total})`);
}

// All three runs must share one prompt. If the prompt could change mid-eval
// the spread would be measuring two different instruments.
if (promptHash() !== hash) fail("the prompt changed during the run");

const summary = summarize(reports);
const timestamp = new Date().toISOString();
await mkdir("evals/results-classify", { recursive: true });
const artifact = {
  timestamp,
  agentModel: AGENT_MODEL,
  temperature: TEMPERATURE,
  fewShot: FEW_SHOT.length,
  promptHash: hash,
  runs: RUNS,
  summary,
  reports,
};
const path = `evals/results-classify/${timestamp.replace(/[:.]/g, "-")}.json`;
await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
console.log(`\nclassification accuracy  median ${pct(summary.overall.median)}` +
  `  (min ${pct(summary.overall.min)}, max ${pct(summary.overall.max)})`);
console.log(`model ${AGENT_MODEL}, temperature ${TEMPERATURE}, ${FEW_SHOT.length} few-shot, ${RUNS} runs`);
console.log(`prompt ${hash.slice(0, 12)}`);

console.log(`\nper class (10 rows each):`);
for (const label of Object.keys(summary.perClass) as GoldenType[]) {
  const s = summary.perClass[label];
  console.log(`  ${label.padEnd(13)} median ${pct(s.median)}  (min ${pct(s.min)}, max ${pct(s.max)})`);
}

// Rows the last run got wrong. Printed because a label the model never
// reaches is more useful than the aggregate.
const missed = reports[reports.length - 1]!.rows.filter((r) => !r.correct);
if (missed.length > 0) {
  console.log(`\n${missed.length} wrong in the last run:`);
  for (const row of missed) {
    console.log(`  ${row.id}  expected ${row.expected}, said ${row.predicted}  <- ${row.question}`);
  }
}
console.log(`\nwrote ${path}`);
