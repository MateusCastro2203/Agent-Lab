import { embed, embedMany } from "ai";
import { createOllama } from "ollama-ai-provider-v2";

export const EMBEDDING_MODEL = "nomic-embed-text";
export const EMBEDDING_DIM = 768;

// nomic-embed-text is trained with task prefixes. They are unconditionally on:
// the measured effect is small and inconsistent, but they are the model's
// documented contract, and a flag would only create a way to get it wrong.
export const DOCUMENT_PREFIX = "search_document: ";
export const QUERY_PREFIX = "search_query: ";

export const BATCH_SIZE = 64;

const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";

export function ollamaUrl(): string {
  const url = process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL;
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

export function batch<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error(`batch size must be positive, got ${size}`);
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    groups.push(items.slice(i, i + size));
  }
  return groups;
}

export class DimensionMismatchError extends Error {}

export function assertDimensions(vectors: number[][]): void {
  for (const [index, vector] of vectors.entries()) {
    if (vector.length !== EMBEDDING_DIM) {
      throw new DimensionMismatchError(
        `embedding at index ${index} has ${vector.length} dimensions, expected ${EMBEDDING_DIM}` +
          ` — the chunks.embedding column is vector(${EMBEDDING_DIM}), so this would not store`,
      );
    }
  }
}

export interface Embedder {
  readonly model: string;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

function handleEmbedFailure(error: unknown): never {
  if (error instanceof DimensionMismatchError) throw error;
  const reason = error instanceof Error ? error.message : String(error);
  console.error(
    `Embedding failed against ${ollamaUrl()}\n` +
      `  ${reason}\n\n` +
      `If Ollama is not running, start it and make sure the model is pulled:\n` +
      `  ollama serve\n` +
      `  ollama pull ${EMBEDDING_MODEL}\n`,
  );
  process.exit(1);
}

export function ollamaEmbedder(): Embedder {
  // baseURL needs the /api suffix; OLLAMA_URL does not carry it. Verified
  // against the running server.
  const provider = createOllama({ baseURL: `${ollamaUrl()}/api` });
  const model = provider.textEmbeddingModel(EMBEDDING_MODEL);

  return {
    model: EMBEDDING_MODEL,

    async embedDocuments(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      for (const group of batch(texts, BATCH_SIZE)) {
        try {
          const { embeddings } = await embedMany({
            model,
            values: group.map((t) => `${DOCUMENT_PREFIX}${t}`),
          });
          assertDimensions(embeddings);
          out.push(...embeddings);
        } catch (error) {
          handleEmbedFailure(error);
        }
      }
      return out;
    },

    async embedQuery(text: string): Promise<number[]> {
      try {
        const { embedding } = await embed({ model, value: `${QUERY_PREFIX}${text}` });
        assertDimensions([embedding]);
        return embedding;
      } catch (error) {
        handleEmbedFailure(error);
      }
    },
  };
}
