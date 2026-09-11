import { mkdir, writeFile } from "node:fs/promises";
import { connect, fail } from "../src/db/client.ts";
import { EMBEDDING_MODEL, ollamaEmbedder } from "../src/embed/provider.ts";
import { topK } from "../src/retrieve/search.ts";
import { loadGolden } from "../src/evals/golden.ts";
import { validateGolden } from "../src/evals/validate.ts";
import { enumerateSections } from "../src/corpus/sections.ts";
import { scoreRecall } from "../src/evals/recall.ts";

const K = 5;

const client = await connect();
try {
  // Preconditions first. A half-ingested table produces a number that looks
  // real and is not, so refuse to score instead of publishing it.
  const state = await client.query<{ rows: string; embedded: string; models: string }>(
    "SELECT count(*) AS rows, count(embedding) AS embedded, count(DISTINCT model) AS models FROM chunks",
  );
  const sections = await enumerateSections();
  const expected = sections.length;
  const rows = Number(state.rows[0]?.rows ?? 0);
  const embedded = Number(state.rows[0]?.embedded ?? 0);
  const models = Number(state.rows[0]?.models ?? 0);
  if (rows !== expected || embedded !== expected || models !== 1) {
    fail(
      `the chunks table is not ready to score.\n` +
        `  rows ${rows} (expected ${expected}), embedded ${embedded}, distinct models ${models} (expected 1)\n\n` +
        `Run:\n  npm run ingest\n`,
    );
  }

  const golden = await loadGolden();
  const problems = validateGolden(golden, sections, { enforceCounts: true })
    .filter((p) => p.fatal);
  if (problems.length > 0) {
    fail(
      `the golden set does not validate, so it will not be scored:\n` +
        problems.map((p) => `  golden.jsonl:${p.line ?? "-"} [${p.kind}] ${p.message}`).join("\n"),
    );
  }

  const inScope = golden.filter((row) => row.type !== "out_of_scope");
  const embedder = ollamaEmbedder();
  const retrieved = new Map<string, string[]>();
  for (const row of inScope) {
    const vector = await embedder.embedQuery(row.question);
    const hits = await topK(client, vector, K, EMBEDDING_MODEL);
    retrieved.set(row.id, hits.map((h) => h.id));
  }

  const report = scoreRecall(golden, retrieved, K);

  const timestamp = new Date().toISOString();
  await mkdir("evals/results", { recursive: true });
  const artifact = {
    timestamp,
    embeddingModel: EMBEDDING_MODEL,
    prefixes: true,
    chunks: rows,
    k: report.k,
    recallAt5: report.recallAt5,
    hits: report.hits,
    total: report.total,
    rows: report.rows,
  };
  const path = `evals/results/${timestamp.replace(/[:.]/g, "-")}.json`;
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`);

  console.log(`\nrecall@${K} = ${report.recallAt5.toFixed(2)}  (${report.hits}/${report.total})`);
  console.log(`model ${EMBEDDING_MODEL}, ${rows} chunks, prefixes on`);

  const missed = report.rows.filter((r) => !r.hit);
  if (missed.length > 0) {
    console.log(`\n${missed.length} missed:`);
    for (const row of missed) {
      console.log(`\n  ${row.id}  ${row.question}`);
      console.log(`    gold: ${row.gold.join(", ")}`);
      console.log(`    gold rank: ${row.goldRank ?? "not in any result"}`);
      for (const [i, id] of row.retrieved.entries()) console.log(`    ${i + 1}. ${id}`);
    }
  }
  console.log(`\nwrote ${path}`);
} finally {
  await client.end();
}
