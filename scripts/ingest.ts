import { createHash } from "node:crypto";
import { connect } from "../src/db/client.ts";
import { enumerateChunks, type Chunk } from "../src/corpus/chunks.ts";
import { EMBEDDING_MODEL, ollamaEmbedder } from "../src/embed/provider.ts";
import { toVectorLiteral } from "../src/retrieve/search.ts";

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const started = Date.now();
const chunks = await enumerateChunks();
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
    for (let i = 0; i < needed.length; i += BATCH) {
      const group = needed.slice(i, i + BATCH);
      const embedded = await embedder.embedDocuments(group.map((c) => c.text));
      group.forEach((chunk, j) => vectors.set(chunk.id, embedded[j]!));
      process.stderr.write(`\rembedded ${Math.min(i + BATCH, needed.length)}/${needed.length}`);
    }
    process.stderr.write("\n");
  }

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

  const deleted = await client.query("DELETE FROM chunks WHERE id <> ALL($1::text[])", [
    chunks.map((c) => c.id),
  ]);

  const counts = await client.query<{ rows: string; embedded: string }>(
    "SELECT count(*) AS rows, count(embedding) AS embedded FROM chunks",
  );
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `embedded ${vectors.size}, skipped ${chunks.length - needed.length}, ` +
      `deleted ${deleted.rowCount ?? 0} in ${elapsed}s`,
  );
  console.log(`chunks: ${counts.rows[0]?.rows} rows, ${counts.rows[0]?.embedded} embedded`);
} finally {
  await client.end();
}
