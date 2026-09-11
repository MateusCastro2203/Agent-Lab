# Retrieval and recall@5 — Design

**Date:** 2026-09-11 (revised the same day, for pgvector)
**Status:** Approved, not yet implemented
**Scope:** Embed the corpus into Postgres, retrieve the top 5 sections for a question, and print the
first real recall@5. No LLM generation, no graph.

## Why this chunk, and why it is this small

The golden set exists but nothing has been measured. The README's results table is empty.

The roadmap treats `v1: three nodes + two numbers` as one item. This chunk takes a slice of it,
because **recall@5 needs no generating model at all** — it is embedding, a distance operator, and
arithmetic. Classification accuracy needs the `classify` node and one model call per question;
answer quality needs the third node and is measured by neither number. Splitting the work this way
produces a real score in a fraction of the effort, and it isolates the variable: if recall@5 comes
out absurd, the fault is in the golden set or the chunking, not in a retriever that does not exist
yet. That is much cheaper to discover now than after three graph nodes are built on top of it.

## Where this sits

| chunk | delivers | needs a generating model? | number it produces |
| --- | --- | --- | --- |
| 2a (done) | Postgres + pgvector, `db:setup` / `db:check` / `db:reset` | no | none |
| **2b (this one)** | ingest, retrieve, `npm run eval` | no | **recall@5** |
| 3 | `classify` node, minimal LangGraph graph | yes | classification accuracy → the v1 row |
| 4 | `answer` node with citations and abstention; run state persisted | yes | none — unmeasured |
| 5 | critic node | yes | none, or a third metric |
| 6 | `interrupt()` for ambiguous questions | yes | — |
| 7 | second embedding model, compared | no | recall@5 × 2 |
| 8 | promptfoo in CI | — | — |

Chunk 4 is deliberately placed after both numbers exist: neither metric measures the `answer` node,
so building it earlier would add unmeasured surface area.

## What already exists

From chunk 2a, merged:

- `docker-compose.yml` — Postgres 17.11 with pgvector 0.8.6, host port 5433, pinned image.
- `db/schema.sql` — the `vector` extension, `schema_meta`, and:
  ```sql
  chunks (
    id text PRIMARY KEY, path text, slug text, heading_path text[],
    text text, hash text, embedding vector(768), model text, updated_at timestamptz
  )
  ```
  **No vector index**, deliberately: HNSW and IVFFlat are approximate, and at 944 rows there is no
  scan cost to win while the exactness they trade away is what recall@5 measures.
- `scripts/db.ts` — `db:setup`, `db:check`, `db:reset`, a schema fingerprint that makes drift fail
  loudly, and an unreachable-database message that unwraps `AggregateError` (connecting to
  `localhost` tries IPv6 and IPv4, and the aggregate's own message is empty).
- `.env.example` with `DATABASE_URL` and `OLLAMA_URL`; the scripts fall back to the same defaults.

From the golden-set chunk: `enumerateSections()` yielding **944 sections**, every anchor declared
upstream; `evals/golden.jsonl` with 30 rows; `validateGolden`.

## What the probe established

A throwaway probe ran before this spec. Its findings are facts here, not assumptions:

- `POST /api/embed` on a running Ollama accepts `input` as an array and returns `embeddings`, so
  batching is native. `nomic-embed-text` is installed; nothing needs provisioning.
- **Vector dimension is 768**, matching the column the schema already declares.
- **Vectors come back L2-normalized** — norm 1.0 within float32 rounding, across inputs from 1
  character to 28 KB.
- **Unrelated texts score about 0.32, not 0.** Useful similarity lives in a compressed band of
  roughly 0.3 to 0.8, and the gap between the right section and a merely similar one can be 0.05.
  Absolute scores therefore mean little; only the ranking is trustworthy. This is why the metric is
  recall@5 and not "similarity above a threshold".
- Throughput on the host is **42ms per section — about 39s for the full corpus.**
- On q001 ("make a query parameter optional") the gold section ranked **first** against four
  same-page distractors.
- On q013 (`async def`) the gold ranked **third**, beaten by
  `tutorial/dependencies/index.md#to-async-or-not-to-async` — the section whose heading matches the
  question's central term and whose body repeats `async def`, but which explicitly declines to
  answer and then dead-links to the unvendored `async.md`. The golden set predicted this row would
  be hard and the README says so; the probe confirms the prediction.
- The `search_document:` / `search_query:` prefixes had a **small and inconsistent** effect: they
  moved q013's gold up one rank and slightly narrowed q001's margin. An earlier draft of this design
  claimed they were worth 10–20pp; that claim was wrong and is withdrawn.

## Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Embeddings | Ollama `nomic-embed-text` on the host | Local, free, already installed; Metal does not reach a container on macOS |
| Model access | `ai` + `ollama-ai-provider-v2` | One path to models for chunks 2b–8, rather than raw `fetch` now and an SDK later |
| Chunk text | heading path + section prose | 8 gold sections are page intros with little text; the path supplies context and disambiguates homonymous anchors |
| Section extent | heading to the next heading of **any** level | The rule the golden-set spec settled; sections never nest |
| Task prefixes | always on, recorded in the artifact | The model's documented contract, and they helped the hard case — the effect is small, so it is recorded rather than believed |
| Vector storage | the `chunks` table | Already provisioned; Postgres is promised for run state anyway, so a file store would have been written twice |
| Similarity | pgvector's `<=>` cosine distance | Cosine by definition, so there is no application-side normalization step to get wrong |
| Ingest caching | content hash per chunk, plus the model name | Re-ingest embeds only what changed; a model change invalidates every row |
| Scoring | recall@5 over the 20 in-scope rows only | An `out_of_scope` row has no correct section to retrieve |
| Output | `evals/results/<iso>.json`, committed, plus stdout | Chunk 7 compares two models and needs durable history |

## Layout

```
src/db/client.ts            # connection + the unreachable-database message
src/corpus/chunks.ts        # extent: a section's text, with its heading path
src/embed/provider.ts       # AI SDK + Ollama; model id, dimension, prefixes, batching
src/retrieve/search.ts      # the top-k query
src/evals/recall.ts         # recall@5 — pure, no I/O
scripts/ingest.ts           # npm run ingest
scripts/eval.ts             # npm run eval
```

Modified: `src/corpus/sections.ts` (one new field), `scripts/db.ts` (use the shared client),
`package.json`, `README.md`.

## Two reuse points, both load-bearing

**The fence scanner.** `sections.ts` owns a fence state machine that took a review round to get
right — it is what keeps Dockerfile comments inside ``` blocks from becoming sections. `chunks.ts`
needs the same scan to know where a section *ends*. Copying that loop would be verbatim duplication
of a logic block, and the copies would drift. Instead `Section` gains one field:

```ts
line: number;   // 0-based index of the heading's line in its file
```

`parseSections` already walks every line, so this is a field, not a second parser. `chunks.ts` then
slices the markdown between consecutive headings. One parser, one fence machine.

**The database connection.** `scripts/db.ts` already contains the connection logic, including the
`AggregateError` unwrapping that took a fix to get right, and the message telling the reader to start
the container. `ingest` and `eval` need exactly that. Extract it to `src/db/client.ts` and have
`scripts/db.ts` import it, so the error path has one implementation:

```ts
import type { Client } from "pg";                    // `Client` throughout this spec is pg's

export function databaseUrl(): string;               // DATABASE_URL, else the local default
export function describe(error: unknown): string;    // unwraps AggregateError
export async function connect(): Promise<Client>;    // exits with the start-the-container message
```

Both changes touch reviewed files. Both are additive, and no existing behaviour moves.

## Chunking

A chunk's body runs from its heading to the next heading of any level. Consequence, already known:
the eight gold rows that cite their file's H1 (q002, q003, q004, q005, q006, q008, q011, q020)
become short chunks — the page's opening prose only.

The embedded text is the heading path followed by the body:

```
Query Parameters > Optional parameters

<section prose>
```

The heading path is built from ancestor headings of strictly decreasing level, walking backwards
from the section. A chunk's id **is** the section's id, unchanged — `<path>#<anchor>` — which is what
lets a golden row's `sections` entry be compared against a retrieval result with no translation.

```ts
export interface Chunk {
  id: string;            // identical to Section.id
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
export const BATCH_SIZE = 64;

export interface Embedder {
  readonly model: string;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}
export function ollamaEmbedder(): Embedder;
```

`ollamaEmbedder` wraps the AI SDK's `embedMany`. It applies the prefixes itself, so no caller can
forget one or apply the wrong one, and it batches `embedDocuments` in groups of `BATCH_SIZE` rather
than sending 944 inputs in a single request.

Prefixes are **unconditionally on**; there is no flag to disable them. The `prefixes` field in the
result artifact exists so that a later chunk which varies them cannot be confused with this one, not
so that this chunk can turn them off. Measuring prefixes on versus off is explicitly not attempted
here: at n=20 the eval cannot resolve an effect that small, and pretending otherwise is the error the
README warns about.

Every returned vector is asserted to have `EMBEDDING_DIM` components, throwing and naming the
offending index otherwise. A silent dimension change would corrupt every score — and would also
collide with the `vector(768)` column, so this check fails earlier and more legibly than Postgres
would.

Dependencies, at versions checked on 2026-09-11: `ai@^7.0.97`, `ollama-ai-provider-v2@^4.0.1`, and
`zod@^4.0.16` (a peer of the provider). `ollama-ai-provider@1.2.0` targets AI SDK v4 and must not be
used. The provider's exact text-embedding accessor is the one thing the probe did not pin down; the
implementation's first step resolves it against the installed package and records the answer.

**Ollama not running** is an expected failure. Both scripts catch the connection error and exit
naming the URL and how to start the server — the same treatment `db.ts` already gives Postgres, and
for the same reason: a stack trace does not tell the reader what to do.

## Ingest

`npm run ingest`:

1. `enumerateChunks()` — 944 chunks.
2. `SELECT id, hash, model FROM chunks` into a map.
3. A chunk needs embedding when its id is absent, its `hash` differs, or its `model` differs from
   `EMBEDDING_MODEL`. Everything else is skipped.
4. Embed the needed texts in batches, reporting progress on stderr (`embedded 128/944`).
5. Upsert every chunk:
   ```sql
   INSERT INTO chunks (id, path, slug, heading_path, text, hash, embedding, model, updated_at)
   VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, now())
   ON CONFLICT (id) DO UPDATE SET
     path = excluded.path, slug = excluded.slug, heading_path = excluded.heading_path,
     text = excluded.text, hash = excluded.hash, embedding = excluded.embedding,
     model = excluded.model, updated_at = now()
   ```
   The vector is passed as the string pgvector expects: `JSON.stringify(vector)` already produces
   `[0.1,0.2,…]`, cast with `$7::vector`.
6. Delete rows whose id is no longer in the corpus, reporting how many.
7. Print a summary — embedded, skipped, deleted, elapsed.

`hash` is the SHA-256 of the chunk's embedded text, via `node:crypto`. Storing `model` alongside is
what makes a model swap in chunk 7 invalidate every row instead of silently mixing two models'
vectors in one column.

A first full ingest embeds 944 chunks at roughly 42ms each — expect about 40 seconds. A re-ingest
over an unchanged corpus embeds nothing.

## Search

```ts
export interface Hit { id: string; score: number }
export async function topK(
  client: Client, queryVector: number[], k: number, model: string,
): Promise<Hit[]>;
```

```sql
SELECT id, 1 - (embedding <=> $1::vector) AS score
FROM chunks
WHERE embedding IS NOT NULL AND model = $2
ORDER BY embedding <=> $1::vector, id
LIMIT $3
```

`<=>` is pgvector's cosine distance, so `1 - distance` is cosine similarity and there is no
application-side normalization to get wrong. The `id` tiebreaker makes results deterministic when
two chunks score identically. Filtering on `model` means a partially-completed ingest surfaces as
fewer candidates rather than as silently wrong scores.

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
counts a row as a hit when any id in `gold` appears among the first `k` retrieved ids, and computes
`recallAt5 = hits / total`. `total` must be 20; the function throws otherwise, because a different
denominator means the golden set changed and the number is no longer comparable to earlier runs.

`goldRank` is recorded even when it exceeds `k` — knowing a miss ranked 7th rather than 400th is the
difference between a tuning problem and a corpus problem.

Purity is what keeps both Ollama and Postgres out of this module's tests.

## Eval

`npm run eval`:

1. **Preconditions, checked before any embedding.** The table must hold exactly 944 rows, all
   embedded, all with `model = EMBEDDING_MODEL`. Anything else exits reporting what it found and
   pointing at `npm run ingest`. A half-ingested table would produce a number that looks real and is
   not.
2. `loadGolden()`, then `validateGolden` with `enforceCounts: true`. A golden set that does not
   validate is not scored.
3. Embed the 20 in-scope questions with `QUERY_PREFIX`. No caching — 20 embeddings take under a
   second.
4. `topK(…, k = 5)` per question.
5. `scoreRecall`.
6. Write the artifact, print the summary and every missed row.

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
  "rows": [ /* one RowResult per in-scope row */ ]
}
```

`evals/results/` **is committed to git.** Each file is a few KB, and the point of the artifact is a
history comparable across runs and across models — chunk 7 would have nothing to compare against
otherwise.

Stdout prints the aggregate and then **every missed row**, with its gold id, the gold's actual rank,
and the top 5 that beat it. A bare aggregate is not actionable; the misses carry the information.

The README's results table stays hand-edited. A measurement script that rewrites documentation can
corrupt it, and the artifact already holds the durable record.

## Testing

`npm test` must pass on a fresh clone with neither Docker nor Ollama running. So:

- **Pure modules get real unit tests.** `chunks.ts` against fixtures: an H1 body stops at the first
  H2; nested levels; `#`-prefixed lines inside ``` and ~~~ fences never start or end a chunk; the
  heading path skips same-level siblings. `scoreRecall`: a gold at rank `k` counts and at `k+1` does
  not; a multi-entry `gold` hits on any member; `out_of_scope` rows are excluded; a wrong denominator
  throws; `goldRank` is correct past `k`.
- **Two cross-checks that catch silent breakage.** The id set of `enumerateChunks()` must equal the
  id set of `enumerateSections()` — otherwise identity and extent have drifted apart and a golden row
  becomes unreachable with no test failing. And every in-scope golden row's gold section must have a
  chunk, asserted against the committed `evals/golden.jsonl`.
- **Database-dependent tests skip, loudly.** `search.ts` needs Postgres. Its tests probe the
  connection once and, when it is unavailable, skip with `SKIPPED (no database at <url>)` visible in
  the output — never silently. When the database is up they run for real: insert three known vectors
  into the live `chunks` table inside a `BEGIN`/`ROLLBACK`, assert the ranking and the `id`
  tiebreaker, and let the rollback undo them. The live table rather than a temporary one on purpose:
  a temporary copy would exercise its own columns, not the real `vector(768)` column and the real
  `model` filter that `topK` depends on — which is most of what there is to get wrong here. The
  rollback is what makes that safe, and the fixtures are `test::`-prefixed, so a full suite run
  leaves the table at exactly 944 rows / 944 embedded with no residue.
- `provider.ts` gets no unit test. Its behaviour is the AI SDK's plus two string prefixes, and a test
  worth having would need Ollama. Its dimension assertion is exercised by `ingest` itself.

`scripts/ingest.ts` and `scripts/eval.ts` are verified by running them.

## Not in this chunk

No LangGraph, no `classify`, no `answer`, no classification accuracy, no run-state persistence, no
second embedding model, no vector index. `npm run ask` still does not exist.

## What this chunk cannot tell you

Everything the README records about the instrument applies, and matters more once there is a number
to over-read:

- **Resolution.** recall@5 has 20 rows: one row flipping moves it 5pp, and the standard error is
  roughly 10pp. Treat anything under about 15pp as noise. The first score is a baseline, not a target
  to tune against.
- **Coverage.** The gold sections fall out as `tutorial` 17, `advanced` 2, `deployment` 1, `how-to`
  0, so roughly 35% of the corpus only ever serves as a distractor. This score is evidence about
  `tutorial/` far more than about the corpus as a whole.
- **q013 is expected to be hard** for a documented reason — its topic-owning page was never vendored,
  and the probe already saw a distractor beat it. A miss there is a corpus boundary, not a retriever
  regression.
