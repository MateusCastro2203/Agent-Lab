# Retrieval and recall@5 — Design

**Date:** 2026-09-11
**Status:** Approved, not yet implemented
**Scope:** Embed the corpus, retrieve the top 5 sections for a question, and print the first real
recall@5. No LLM, no graph, no Postgres.

## Why this chunk, and why it is this small

The golden set exists but nothing has been measured. The README's results table is empty.

The roadmap treats `v1: three nodes + two numbers` as one item. This chunk takes a slice of it,
because **recall@5 needs no language model at all** — it is embedding, cosine, and arithmetic.
Classification accuracy needs the `classify` node and one model call per question; answer quality
needs the third node and is not measured by either number. Splitting the work this way produces a
real score in a fraction of the effort, and it isolates the variable: if recall@5 comes out absurd,
the fault is in the golden set or the chunking, not in a retriever that does not exist yet. That is
much cheaper to discover now than after three graph nodes are built on top of it.

## Where this sits

| chunk | delivers | needs a model? | number it produces |
| --- | --- | --- | --- |
| **2 (this one)** | ingest, retrieve, `npm run eval` | embeddings only | **recall@5** |
| 3 | `classify` node, minimal LangGraph graph | yes | classification accuracy → the v1 row |
| 4 | `answer` node with citations and abstention; state persisted in Postgres | yes | none — unmeasured |
| 5 | critic node | yes | none, or a third metric |
| 6 | `interrupt()` for ambiguous questions | yes | — |
| 7 | second embedding model, compared | embeddings only | recall@5 × 2 |
| 8 | promptfoo in CI | — | — |

Chunk 4 is deliberately placed after both numbers exist: neither metric measures the `answer` node,
so building it earlier would add unmeasured surface area.

## What the probe established

A throwaway probe ran before this spec was written. Its findings are facts here, not assumptions:

- `POST /api/embed` on a running Ollama accepts `input` as an array and returns `embeddings`, so
  batching is native. Model `nomic-embed-text` is installed; nothing needs provisioning.
- **Vector dimension is 768.**
- **Vectors come back L2-normalized** — the norm is 1.0 within float32 rounding across inputs from
  1 character to 28 KB. So for this model cosine similarity equals the plain dot product.
- **Unrelated texts score about 0.32, not 0.** Useful similarity lives in a compressed band of
  roughly 0.3 to 0.8, and the gap between the right section and a merely similar one can be 0.05.
  Absolute scores therefore mean little; only the ranking is trustworthy. This is why the metric is
  recall@5 and not "similarity above a threshold".
- On q001 ("make a query parameter optional") the gold section ranked **first** against four
  same-page distractors.
- On q013 (`async def`) the gold section ranked **third**, beaten by
  `tutorial/dependencies/index.md#to-async-or-not-to-async` — the section whose heading matches the
  question's central term and whose body repeats `async def`, but which explicitly declines to
  answer and then dead-links to the unvendored `async.md`. The golden set predicted this row would
  be hard and the README says so; the probe confirms the prediction rather than contradicting it.
- The `search_document:` / `search_query:` prefixes nomic documents had a **small and inconsistent**
  effect: they moved q013's gold up one rank and slightly narrowed q001's margin. An earlier draft
  of this design claimed they were worth 10–20pp; that claim was wrong and is withdrawn.

## Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Retrieval | Ollama `nomic-embed-text` via the AI SDK | Local, free, offline; already installed |
| Model access | `ai` + `ollama-ai-provider-v2` | One path to models for chunks 2–8, rather than raw `fetch` now and an SDK later |
| Chunk text | heading path + section prose | 8 gold sections are page intros with little text; the path supplies context and disambiguates homonymous anchors |
| Section extent | heading to the next heading of **any** level | The rule the golden-set spec settled; sections never nest |
| Task prefixes | always on in this chunk, recorded in the artifact and the vector header | The model's documented contract, and they helped the hard case — but the effect is small, so it is recorded rather than believed |
| Vector storage | `data/embeddings.jsonl`, git-ignored, cached by content hash | 944 × 768 floats is roughly 15 MB of JSON — too large to commit |
| Similarity | normalize at ingest, dot product at query time | Correctness does not depend on the model's undocumented normalization, and search stays a dot product |
| Vector store | a flat file, not Postgres | 944 vectors; pgvector would add Docker to the critical path and buy nothing at this size |
| Scoring | recall@5 over the 20 in-scope rows only | An `out_of_scope` row has no correct section to retrieve |
| Output | `evals/results/<iso>.json` plus stdout | Chunk 7 compares two models and needs durable history |

## Layout

```
src/corpus/chunks.ts        # extent: a section's text, with its heading path
src/embed/provider.ts       # AI SDK + Ollama wiring; model id, dimension, prefixes
src/embed/store.ts          # data/embeddings.jsonl read/write, content hashing
src/retrieve/search.ts      # normalize, dot product, top-k
src/evals/recall.ts         # recall@5 — pure, no I/O
scripts/ingest.ts           # npm run ingest
scripts/eval.ts             # npm run eval
```

Modified: `src/corpus/sections.ts` (one new field), `package.json`, `.gitignore`, `README.md`.

## The one real risk: duplicating the fence scanner

`sections.ts` owns a fence state machine that took a review round to get right — it is what keeps
Dockerfile comments inside ``` blocks from becoming sections. `chunks.ts` needs the same scan to
know where a section *ends*.

Copying that loop would be verbatim duplication of a logic block, and the two copies would drift.
Instead, `Section` gains one field:

```ts
line: number;   // 0-based index of the heading's line in its file
```

`parseSections` already walks every line, so this is a field, not a second parser. `chunks.ts` then
slices the markdown between consecutive headings. One parser, one fence machine.

This modifies a reviewed file, but the change is additive and no existing behaviour moves.

## Chunking

A chunk's body runs from its heading to the next heading of any level, per the golden-set spec.
Consequence, already known: the eight gold rows that cite their file's H1 (q002, q003, q004, q005,
q006, q008, q011, q020) become short chunks — the page's opening prose only.

The embedded text is the heading path followed by the body:

```
Query Parameters > Optional parameters

<section prose>
```

The heading path is built from ancestor headings of strictly decreasing level, walking backwards
from the section. A chunk's id is the section's id, unchanged — `<path>#<anchor>`. This is what lets
a golden row's `sections` entry be compared directly against a retrieval result.

Interface:

```ts
export interface Chunk {
  id: string;            // same as Section.id
  path: string;
  slug: string;
  headingPath: string[]; // ancestors, then the section's own heading
  text: string;          // headingPath.join(" > ") + "\n\n" + body
}
export function buildChunks(relPath: string, markdown: string): Chunk[];
export function enumerateChunks(corpusRoot?: string): Promise<Chunk[]>;
```

`enumerateChunks` defaults `corpusRoot` to `"corpus"` and must return one chunk per section that
`enumerateSections()` returns — 944 of them, same ids, same order.

## Embedding

```ts
export const EMBEDDING_MODEL = "nomic-embed-text";
export const EMBEDDING_DIM = 768;
export const DOCUMENT_PREFIX = "search_document: ";
export const QUERY_PREFIX = "search_query: ";

export interface Embedder {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
export function ollamaEmbedder(): Embedder;
```

`ollamaEmbedder` wraps the AI SDK's `embedMany`. It applies the prefixes itself, so no caller can
forget one or apply the wrong one. Prefixes are **unconditionally on** in this chunk — there is no
flag to disable them. The `prefixes` field exists in the vector header and the result artifact so
that a later chunk which varies them cannot be confused with this one, not so that this chunk can
turn them off. Measuring prefixes on versus off is explicitly not attempted here: at n=20 the eval
cannot resolve an effect that small, and pretending otherwise is the error the README warns about. It asserts every returned vector has `EMBEDDING_DIM` components
and throws naming the offending index otherwise — a silent dimension change would corrupt every
score.

Dependencies, at the versions checked on 2026-09-11: `ai@^7.0.97`, `ollama-ai-provider-v2@^4.0.1`,
and `zod@^4.0.16` (a peer of the provider). These are the project's first runtime dependencies.
`ollama-ai-provider@1.2.0` is for AI SDK v4 and must not be used.

The provider's exact text-embedding accessor is the one thing the probe did not pin down. The
implementation's first step resolves it against the installed package and records the answer.

**Ollama not running** is the expected failure. Both scripts must catch a connection error and exit
with a message naming the port and how to start the server — not a raw stack trace.

## Storage

`data/embeddings.jsonl`. The first line is a header record, then one record per chunk:

```jsonc
{"model":"nomic-embed-text","dim":768,"prefixes":true,"count":944}
{"id":"tutorial/query-params.md#optional-parameters","hash":"<sha256 of chunk text>","vector":[...]}
```

Vectors are stored **already normalized**, so search never divides.

Interface:

```ts
export interface VectorHeader {
  model: string; dim: number; prefixes: boolean; count: number;
}
export interface StoredVector {
  id: string;       // the chunk / section id
  hash: string;     // SHA-256 of the embedded text
  vector: number[]; // length EMBEDDING_DIM, already normalized
}
export function hashText(text: string): string;
export function loadVectors(path?: string): Promise<{ header: VectorHeader; vectors: StoredVector[] }>;
export function saveVectors(header: VectorHeader, vectors: StoredVector[], path?: string): Promise<void>;
```

`loadVectors` defaults `path` to `"data/embeddings.jsonl"` and returns an empty vector list with a
`count` of 0 when the file does not exist, so a first `ingest` is not a special case.

`hash` is the SHA-256 of the chunk's embedded text, via `node:crypto`. Re-running `npm run ingest`
re-embeds only chunks whose hash changed, and drops records whose id no longer exists.

The header is a cache key: if `model`, `dim` or `prefixes` differ from the current configuration,
the whole file is invalid and every chunk is re-embedded. Chunk 7 swaps the model, and this is what
stops it from silently mixing two models' vectors in one file.

`.gitignore` gains `data/`.

## Search

```ts
export interface Hit { id: string; score: number }
export function normalize(vector: number[]): number[];
export function topK(query: number[], vectors: StoredVector[], k: number): Hit[];
```

`normalize` divides by the L2 norm and throws on a zero vector. `topK` takes the dot product against
every stored vector and returns the k highest, sorted descending, breaking ties by id so results are
deterministic. 944 dot products of 768 components is about 725k multiplications — microseconds, no
index needed.

## Scoring

```ts
export interface RowResult {
  id: string; question: string; hit: boolean;
  gold: string[]; retrieved: string[];   // top k, in rank order
  goldRank: number | null;               // 1-based rank of the best gold hit, or null
}
export interface RecallReport {
  k: number; hits: number; total: number; recallAt5: number; rows: RowResult[];
}
export function scoreRecall(
  rows: GoldenRow[], retrievedByRowId: Map<string, string[]>, k: number,
): RecallReport;
```

`scoreRecall` is pure and does no I/O. It filters to in-scope rows (`type !== "out_of_scope"`),
counts a row as a hit when any id in `gold` appears in the first `k` retrieved ids, and computes
`recallAt5 = hits / total`. `total` must be 20; the function throws if it is not, because a different
denominator means the golden set changed and the number is not comparable to earlier runs.

`goldRank` is recorded even when it exceeds k — knowing a miss ranked 7th rather than 400th is the
difference between a tuning problem and a corpus problem.

Purity is what keeps Ollama out of the test suite: tests pass a hand-built map.

## Output

`evals/results/<ISO-8601>.json`:

```jsonc
{
  "timestamp": "2026-09-11T14:02:11.482Z",
  "embeddingModel": "nomic-embed-text",
  "prefixes": true,
  "chunks": 944,
  "k": 5,
  "recallAt5": 0.65,
  "hits": 13,
  "total": 20,
  "rows": [ /* RowResult per in-scope row */ ]
}
```

Stdout prints the aggregate and then **every missed row**, with its gold id, the gold's actual rank,
and the top 5 that beat it. A bare aggregate is not actionable; the misses are where the information
is.

`evals/results/` **is committed to git**, unlike `data/`. Each file is a few KB, and the point of
the artifact is a comparable history across runs and across models — git-ignoring it would leave
chunk 7 with nothing to compare against. `data/embeddings.jsonl` is ignored because it is 15 MB of
regenerable derived data; a result is neither large nor regenerable, since re-running it later with
a different model answers a different question.

The README's results table stays hand-edited. A measurement script that rewrites documentation can
corrupt it, and the artifact already holds the durable record.

## Testing

The suite must not require Ollama. Every test either uses fixtures or injects vectors.

- `chunks.ts` against fixtures: an H1 body stops at the first H2; nested levels; `#`-prefixed lines
  inside ``` and ~~~ fences never start or end a chunk; the heading path skips same-level siblings.
- **Every id `enumerateSections()` returns has exactly one chunk from `enumerateChunks()`, and the
  id sets are equal.** This is the guard against identity and extent drifting apart, which would
  make a golden row unreachable without any test failing.
- **Every in-scope golden row's gold section has a chunk**, asserted against the committed
  `evals/golden.jsonl`.
- `normalize`: a known vector, and a zero vector throwing.
- `topK`: orthogonal scores 0, identical scores 1, ranking order, deterministic tie-break, and
  `k` larger than the corpus.
- `scoreRecall`: a gold at rank k counts, at k+1 does not; multi-entry `gold` hits on any member;
  `out_of_scope` rows excluded; a wrong denominator throws; `goldRank` correct past k.
- `store.ts`: a round trip; a changed hash re-embeds; a header mismatch invalidates the file.

`scripts/ingest.ts` and `scripts/eval.ts` are verified by running them, not by unit tests.

## Not in this chunk

No Postgres, no pgvector, no LangGraph, no `classify`, no `answer`, no classification accuracy, no
state persistence, no second embedding model. `npm run ask` still does not exist.

## What this chunk cannot tell you

Everything the README already records about the instrument applies, and matters more once there is a
number to over-read:

- **Resolution.** recall@5 has 20 rows: one row flipping moves it 5pp, and the standard error is
  roughly 10pp. Treat anything under about 15pp as noise. The first score is a baseline, not a
  target to tune against.
- **Coverage.** The gold sections fall out as `tutorial` 17, `advanced` 2, `deployment` 1, `how-to`
  0, so roughly 35% of the corpus only ever serves as a distractor. This score is evidence about
  `tutorial/` far more than about the corpus.
- **q013 is expected to be hard** for a documented reason — its topic-owning page was never
  vendored. The probe already saw a distractor beat it. A miss there is a corpus boundary, not a
  retriever regression.
