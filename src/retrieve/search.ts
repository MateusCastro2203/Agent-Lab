import type { Client } from "pg";
import { EMBEDDING_DIM } from "../embed/provider.ts";

export interface Hit {
  id: string;
  score: number;
}

/** pgvector parses `[0.1,-0.2,3]`, which is exactly JSON's array form. */
export function toVectorLiteral(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIM) {
    throw new Error(`vector has ${vector.length} dimensions, expected ${EMBEDDING_DIM}`);
  }
  return JSON.stringify(vector);
}

export async function topK(
  client: Client,
  queryVector: number[],
  k: number,
  model: string,
): Promise<Hit[]> {
  // `<=>` is pgvector's cosine distance, so similarity is 1 - distance and
  // there is no application-side normalization to get wrong. The id tiebreaker
  // makes equal scores deterministic. Filtering on model means a partial
  // ingest shows up as fewer candidates, not as silently wrong scores.
  const result = await client.query<{ id: string; score: string }>(
    `SELECT id, 1 - (embedding <=> $1::vector) AS score
     FROM chunks
     WHERE embedding IS NOT NULL AND model = $2
     ORDER BY embedding <=> $1::vector, id
     LIMIT $3`,
    [toVectorLiteral(queryVector), model, k],
  );
  return result.rows.map((row) => ({ id: row.id, score: Number(row.score) }));
}
