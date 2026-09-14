import { createHash } from "node:crypto";
import { connect, fail } from "../src/db/client.ts";
import { enumerateChunks, type Chunk } from "../src/corpus/chunks.ts";
import { EMBEDDING_MODEL, EmbeddingFailedError, ollamaEmbedder } from "../src/embed/provider.ts";
import { toVectorLiteral } from "../src/retrieve/search.ts";

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const started = Date.now();
const chunks = await enumerateChunks();

// An empty result means nothing downstream makes sense: the delete step below
// removes any row whose id is not in `chunks`, so an empty `chunks` would wipe
// the entire table. Refuse before opening a database connection at all.
if (chunks.length === 0) {
  fail(
    "enumerateChunks() returned no chunks — refusing to continue.\n" +
      "  An empty corpus would make the delete step wipe every stored row.\n" +
      "  Check that corpus/ is populated (expected 944 sections over 106 files).",
  );
}

const hashes = new Map(chunks.map((c) => [c.id, hashText(c.text)]));
console.log(`corpus: ${chunks.length} chunks`);

const client = await connect();
try {
  const existing = await client.query<{ id: string; hash: string; model: string | null }>(
    "SELECT id, hash, model FROM chunks",
  );
  const stored = new Map(existing.rows.map((r) => [r.id, r]));

  // A chunk needs embedding when it is new, its text changed, or it was
  // embedded by a different model. Storing the model is what makes a model
  // swap invalidate every row instead of mixing two models in one column.
  const needed: Chunk[] = chunks.filter((chunk) => {
    const prior = stored.get(chunk.id);
    return (
      prior === undefined ||
      prior.hash !== hashes.get(chunk.id) ||
      prior.model !== EMBEDDING_MODEL
    );
  });
  console.log(`to embed: ${needed.length}, skipping ${chunks.length - needed.length}`);

  const vectors = new Map<string, number[]>();
  if (needed.length > 0) {
    const embedder = ollamaEmbedder();
    const BATCH = 64;
    try {
      for (let i = 0; i < needed.length; i += BATCH) {
        const group = needed.slice(i, i + BATCH);
        const embedded = await embedder.embedDocuments(group.map((c) => c.text));
        group.forEach((chunk, j) => vectors.set(chunk.id, embedded[j]!));
        process.stderr.write(`\rembedded ${Math.min(i + BATCH, needed.length)}/${needed.length}`);
      }
    } catch (error) {
      if (error instanceof EmbeddingFailedError) fail(error.message);
      throw error;
    }
    process.stderr.write("\n");
  }

  // The upserts and the delete are one transaction. Autocommitted, a crash
  // part-way through a *re*-ingest leaves 944 rows, 944 embedded, one model —
  // every eval precondition satisfied — over a mix of old and new chunk text,
  // which is scoreable and wrong. A first ingest is caught by the row count
  // coming up short; a re-ingest is not. This also closes the window where
  // the delete has landed and the upserts have not.
  let deleted = 0;
  await client.query("BEGIN");
  try {
    for (const chunk of chunks) {
      const vector = vectors.get(chunk.id);
      if (vector === undefined) continue; // skipped: its stored row is still valid
      await client.query(
        `INSERT INTO chunks (id, path, slug, heading_path, text, hash, embedding, model, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, now())
         ON CONFLICT (id) DO UPDATE SET
           path = excluded.path, slug = excluded.slug, heading_path = excluded.heading_path,
           text = excluded.text, hash = excluded.hash, embedding = excluded.embedding,
           model = excluded.model, updated_at = now()`,
        [
          chunk.id,
          chunk.path,
          chunk.slug,
          chunk.headingPath,
          chunk.text,
          hashes.get(chunk.id),
          toVectorLiteral(vector),
          EMBEDDING_MODEL,
        ],
      );
    }

    const result = await client.query("DELETE FROM chunks WHERE id <> ALL($1::text[])", [
      chunks.map((c) => c.id),
    ]);
    deleted = result.rowCount ?? 0;
    await client.query("COMMIT");
  } catch (error) {
    // A failed ROLLBACK must not replace the real error: if the connection is
    // already gone the server aborts the transaction for us either way.
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }

  const counts = await client.query<{ rows: string; embedded: string }>(
    "SELECT count(*) AS rows, count(embedding) AS embedded FROM chunks",
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `embedded ${vectors.size}, skipped ${chunks.length - needed.length}, ` +
      `deleted ${deleted} in ${elapsed}s`,
  );
  console.log(`chunks: ${counts.rows[0]?.rows} rows, ${counts.rows[0]?.embedded} embedded`);
} finally {
  await client.end();
}
