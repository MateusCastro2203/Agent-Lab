# Retrieval and recall@5 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed the 944-section corpus into pgvector, retrieve the top 5 sections per question, and print the project's first real recall@5.

**Architecture:** `sections.ts` already gives each section an identity; this chunk adds *extent* (`chunks.ts`) so a section becomes embeddable text, embeds it through the AI SDK against a host Ollama, stores it in the `chunks` table that chunk 2a provisioned, and scores the 20 in-scope golden rows. Retrieval is `ORDER BY embedding <=> $1::vector` — pgvector's cosine distance — so no application-side normalization exists. The scoring module is pure, which is what keeps both Ollama and Postgres out of most of the test suite.

**Tech Stack:** TypeScript run natively by Node 25 (type stripping), `node:test`, Postgres 17.11 + pgvector 0.8.6 in Docker, Ollama `nomic-embed-text` on the host, `ai@^7` with `ollama-ai-provider-v2@^4`, `pg@^8`.

**Spec:** `docs/superpowers/specs/2026-09-11-retrieval-recall-design.md`

## Global Constraints

- Node >= 22.18 (native TypeScript type stripping). This machine runs v25.9.0.
- `package.json` has `"type": "module"`. All relative imports carry the explicit `.ts` extension.
- `tsconfig.json` is strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`. `npm run typecheck` must stay clean. Do not edit `tsconfig.json`.
- Dependencies are already installed and committed: `ai@^7.0.97`, `ollama-ai-provider-v2@^4.0.1`, `zod@^4.6.2`, `pg@^8.23.0`, `@types/pg`. **Add no others.**
- `EMBEDDING_MODEL = "nomic-embed-text"`, `EMBEDDING_DIM = 768`, `BATCH_SIZE = 64`.
- Prefixes: `DOCUMENT_PREFIX = "search_document: "`, `QUERY_PREFIX = "search_query: "`. Unconditionally on; no flag disables them.
- Ollama provider wiring, verified against the running server on 2026-09-11:
  ```ts
  createOllama({ baseURL: `${ollamaUrl()}/api` }).textEmbeddingModel(EMBEDDING_MODEL)
  ```
  The `/api` suffix is required and `OLLAMA_URL` does not carry it.
- `DATABASE_URL` default: `postgres://agentlab:agentlab@localhost:5433/agentlab`. `OLLAMA_URL` default: `http://127.0.0.1:11434`.
- The corpus yields exactly **944 sections over 106 files**, every anchor declared upstream. `evals/golden.jsonl` holds **30 rows: 10 how_to, 10 concept, 10 out_of_scope**, and **20 in-scope rows**.
- `npm test` must pass on a fresh clone with neither Docker nor Ollama running. Database-dependent tests skip with a visible `SKIPPED` line — never silently.
- Section id format, unchanged and load-bearing: `<path relative to corpus/>#<anchor>`. A chunk's id **is** its section's id.
- Every commit message ends with this trail, exactly:
  ```
  🤖 Generated with Claude Code

  Co-Authored-By: Claude <noreply@anthropic.com>
  AI-Assisted: yes
  AI-Tool: claude-code
  ```

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/db/client.ts` | **Create.** Connection URL, `AggregateError` unwrapping, connect-or-exit |
| `scripts/db.ts` | **Modify.** Import the above instead of owning it |
| `src/corpus/sections.ts` | **Modify.** `Section` gains `line` |
| `src/corpus/chunks.ts` | **Create.** Section extent → embeddable text with heading path |
| `src/embed/provider.ts` | **Create.** AI SDK wiring, prefixes, batching, dimension assertion |
| `src/retrieve/search.ts` | **Create.** The top-k query |
| `src/evals/recall.ts` | **Create.** recall@5, pure |
| `scripts/ingest.ts` | **Create.** `npm run ingest` |
| `scripts/eval.ts` | **Create.** `npm run eval` |
| `tests/fixtures/chunk-*.md` | **Create.** Fixtures for extent tests |

---

### Task 1: Shared database client

**Files:**
- Create: `src/db/client.ts`
- Modify: `scripts/db.ts` (delete its `describe`/`unreachable`/`connect`/`url`, import them)
- Test: `src/db/client.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export function databaseUrl(): string;
  export function describe(error: unknown): string;
  export function fail(message: string): never;
  export async function connect(): Promise<import("pg").Client>;
  ```

Why this task exists: `scripts/db.ts` already owns connection logic whose `AggregateError` unwrapping took a bug fix to get right. `ingest` and `eval` need exactly that behaviour, and copying it would leave three implementations to drift.

- [ ] **Step 1: Write the failing test**

`src/db/client.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { databaseUrl, describe } from "./client.ts";

test("describe unwraps an AggregateError with an empty message", () => {
  const aggregate = new AggregateError([
    new Error("connect ECONNREFUSED ::1:5433"),
    new Error("connect ECONNREFUSED 127.0.0.1:5433"),
  ]);
  assert.equal(aggregate.message, "");
  assert.equal(
    describe(aggregate),
    "connect ECONNREFUSED ::1:5433; connect ECONNREFUSED 127.0.0.1:5433",
  );
});

test("describe collapses duplicate causes", () => {
  const aggregate = new AggregateError([new Error("same"), new Error("same")]);
  assert.equal(describe(aggregate), "same");
});

test("describe falls back to a plain Error's message", () => {
  assert.equal(describe(new Error("plain")), "plain");
});

test("describe stringifies a non-Error", () => {
  assert.equal(describe("just a string"), "just a string");
});

test("databaseUrl prefers DATABASE_URL and falls back to the local default", () => {
  const original = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = "postgres://example/db";
    assert.equal(databaseUrl(), "postgres://example/db");
    delete process.env.DATABASE_URL;
    assert.equal(databaseUrl(), "postgres://agentlab:agentlab@localhost:5433/agentlab");
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/db/client.test.ts`
Expected: FAIL — cannot resolve module `./client.ts`.

- [ ] **Step 3: Write the implementation**

`src/db/client.ts`:

```ts
import { Client } from "pg";

const DEFAULT_URL = "postgres://agentlab:agentlab@localhost:5433/agentlab";

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_URL;
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// Connecting to `localhost` tries IPv6 and IPv4, and the failure arrives as an
// AggregateError whose own `message` is empty — the causes are in `.errors`.
// Reading only `.message` printed a blank reason, so unwrap the aggregate.
export function describe(error: unknown): string {
  if (error instanceof AggregateError) {
    const causes = error.errors.map(describe).filter((m) => m !== "");
    const unique = [...new Set(causes)];
    if (unique.length > 0) return unique.join("; ");
  }
  if (error instanceof Error && error.message !== "") return error.message;
  return String(error);
}

export async function connect(): Promise<Client> {
  const url = databaseUrl();
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    fail(
      `Cannot reach Postgres at ${url}\n` +
        `  ${describe(error)}\n\n` +
        `Is the container up? Start it and wait for the healthcheck:\n` +
        `  docker compose up -d\n` +
        `  docker compose ps        # db should read "healthy"\n`,
    );
  }
  return client;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/db/client.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Rewrite `scripts/db.ts` to use it**

Delete `DEFAULT_URL`, `url`, `fail`, `describe`, `unreachable` and `connect` from `scripts/db.ts`. Add at the top:

```ts
import { connect, databaseUrl, fail } from "../src/db/client.ts";
```

Then replace every bare `url` reference in that file with `databaseUrl()`. There are five, in: `setup`'s success line, `check`'s drift message (none — it uses `SCHEMA_PATH`), `reset`'s refusal message, and the two `fail` calls that name the URL. Search for `${url}` and replace each with `${databaseUrl()}`.

- [ ] **Step 6: Verify the database scripts still behave**

Run: `npm run typecheck`
Expected: clean.

Run: `npm run db:check`
Expected: `postgres 17.11, pgvector 0.8.6` / `chunks: 0 rows, 0 embedded` / `schema: … (matches)` / `db OK`.

Run: `npm run db:reset`
Expected: refuses without `--force`, and its message names the URL — proving `databaseUrl()` is wired in.

- [ ] **Step 7: Run the full suite and commit**

Run: `npm test`
Expected: 43 passing (38 existing + 5 new).

```bash
git add src/db/client.ts src/db/client.test.ts scripts/db.ts
git commit -m "$(cat <<'EOF'
refactor: extract the database client for reuse

ingest and eval need the same connect-or-explain behaviour scripts/db.ts
already had, including the AggregateError unwrapping that took a fix to
get right. Three copies would drift, so it moves to src/db/client.ts and
db.ts imports it.

The unwrapping is now unit-tested, which it could not be while it lived
inside a script.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

### Task 2: `Section` gains a line index

**Files:**
- Modify: `src/corpus/sections.ts`
- Test: `src/corpus/sections.test.ts` (add one test)

**Interfaces:**
- Consumes: nothing.
- Produces: `Section.line: number` — the 0-based index of the heading's line within its file. Task 3 slices markdown between consecutive `line` values.

Why a field and not a second parser: `chunks.ts` must know where a section *ends*, which means knowing where the next heading starts. `parseSections` already walks every line with a fence state machine that took a review round to get right. Re-implementing that scan in `chunks.ts` would be verbatim duplication of a logic block, and the copies would drift.

- [ ] **Step 1: Write the failing test**

Add to `src/corpus/sections.test.ts`:

```ts
test("records the 0-based line index of each heading", async () => {
  const sections = parseSections("f.md", await fixture("declared-anchors.md"));
  // Verified against tests/fixtures/declared-anchors.md: the three headings sit
  // on 0-based lines 0, 4 and 8.
  assert.deepEqual(
    sections.map((s) => [s.slug, s.line]),
    [
      ["query-parameters", 0],
      ["optional-parameters", 4],
      ["no-spaces-in-braces", 8],
    ],
  );
});

test("line indexes skip fenced content, matching the sections found", async () => {
  const sections = parseSections("f.md", await fixture("fenced-code.md"));
  const lines = (await fixture("fenced-code.md")).split("\n");
  for (const section of sections) {
    assert.match(lines[section.line] ?? "", /^#{1,6} /, `line ${section.line} is not a heading`);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/corpus/sections.test.ts`
Expected: FAIL — `line` is `undefined`, so the `deepEqual` mismatches.

- [ ] **Step 3: Add the field**

In `src/corpus/sections.ts`, add to the `Section` interface, after `level`:

```ts
  level: number;
  /** 0-based index of this heading's line in its file. Lets chunks.ts find
   *  where the section ends without re-walking the fence state machine. */
  line: number;
```

In `parseSections`, change the loop to track the index. Replace:

```ts
  for (const line of markdown.split("\n")) {
```

with:

```ts
  const allLines = markdown.split("\n");
  for (let lineNo = 0; lineNo < allLines.length; lineNo += 1) {
    const line = allLines[lineNo]!;
```

and add `line: lineNo,` to the pushed object, after `level`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test src/corpus/sections.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean; 45 passing.

```bash
git add src/corpus/sections.ts src/corpus/sections.test.ts
git commit -m "$(cat <<'EOF'
feat: record each section's heading line index

chunks.ts needs to know where a section ends, which means knowing where
the next heading begins. parseSections already walks every line behind a
fence state machine, so this is one more field rather than a second
parser — the alternative was duplicating that scan and letting the two
copies drift.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

### Task 3: Chunking — section extent and embeddable text

**Files:**
- Create: `src/corpus/chunks.ts`
- Create: `tests/fixtures/chunk-extent.md`
- Test: `src/corpus/chunks.test.ts`

**Interfaces:**
- Consumes: `Section` (with `line`), `parseSections`, `enumerateSections` from `src/corpus/sections.ts`.
- Produces:
  ```ts
  export interface Chunk {
    id: string;            // identical to Section.id
    path: string;
    slug: string;
    headingPath: string[]; // ancestors of strictly decreasing level, then the section's own heading
    text: string;          // headingPath.join(" > ") + "\n\n" + body
  }
  export function buildChunks(relPath: string, markdown: string): Chunk[];
  export function enumerateChunks(corpusRoot?: string): Promise<Chunk[]>;
  ```
  `enumerateChunks` defaults `corpusRoot` to `"corpus"` and returns one chunk per section, same ids, same order.

- [ ] **Step 1: Write the fixture**

`tests/fixtures/chunk-extent.md`:

`````markdown
# Top Page { #top-page }

Intro prose that belongs to the H1 and stops at the first H2.

## First Section { #first-section }

Body of the first section.

```python
# not a heading
print("hi")
```

### Nested Under First { #nested-under-first }

Deeper body.

## Second Section { #second-section }

~~~bash
## also not a heading
~~~

Last body.
`````

- [ ] **Step 2: Write the failing test**

`src/corpus/chunks.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { enumerateSections } from "./sections.ts";
import { buildChunks, enumerateChunks } from "./chunks.ts";
import { loadGolden } from "../evals/golden.ts";

const fixture = (name: string) => readFile(`tests/fixtures/${name}`, "utf8");

test("an H1 body stops at the first H2", async () => {
  const chunks = buildChunks("f.md", await fixture("chunk-extent.md"));
  const top = chunks[0]!;
  assert.equal(top.slug, "top-page");
  assert.match(top.text, /Intro prose that belongs to the H1/);
  assert.doesNotMatch(top.text, /Body of the first section/);
});

test("heading path carries ancestors of strictly decreasing level", async () => {
  const chunks = buildChunks("f.md", await fixture("chunk-extent.md"));
  const byslug = new Map(chunks.map((c) => [c.slug, c]));
  assert.deepEqual(byslug.get("top-page")!.headingPath, ["Top Page"]);
  assert.deepEqual(byslug.get("first-section")!.headingPath, ["Top Page", "First Section"]);
  assert.deepEqual(byslug.get("nested-under-first")!.headingPath, [
    "Top Page",
    "First Section",
    "Nested Under First",
  ]);
  // Second Section is a sibling of First Section, so First must not appear.
  assert.deepEqual(byslug.get("second-section")!.headingPath, ["Top Page", "Second Section"]);
});

test("text is the heading path then a blank line then the body", async () => {
  const chunks = buildChunks("f.md", await fixture("chunk-extent.md"));
  const first = chunks.find((c) => c.slug === "first-section")!;
  assert.ok(first.text.startsWith("Top Page > First Section\n\n"), first.text.slice(0, 60));
});

test("hash-prefixed lines inside fences stay in the body and start no chunk", async () => {
  const chunks = buildChunks("f.md", await fixture("chunk-extent.md"));
  assert.deepEqual(chunks.map((c) => c.slug), [
    "top-page",
    "first-section",
    "nested-under-first",
    "second-section",
  ]);
  const first = chunks.find((c) => c.slug === "first-section")!;
  assert.match(first.text, /# not a heading/);
  const second = chunks.find((c) => c.slug === "second-section")!;
  assert.match(second.text, /## also not a heading/);
});

test("a chunk id equals its section id", async () => {
  const chunks = buildChunks("tutorial/query-params.md", await fixture("chunk-extent.md"));
  assert.equal(chunks[1]!.id, "tutorial/query-params.md#first-section");
});

test("the real corpus yields one chunk per section, with identical id sets", async () => {
  const [sections, chunks] = await Promise.all([enumerateSections(), enumerateChunks()]);
  assert.equal(chunks.length, sections.length, `${chunks.length} chunks vs ${sections.length} sections`);
  const sectionIds = new Set(sections.map((s) => s.id));
  const chunkIds = new Set(chunks.map((c) => c.id));
  const missing = [...sectionIds].filter((id) => !chunkIds.has(id));
  const extra = [...chunkIds].filter((id) => !sectionIds.has(id));
  assert.deepEqual(missing, [], "sections with no chunk");
  assert.deepEqual(extra, [], "chunks with no section");
});

test("every in-scope golden row's gold section has a chunk", async () => {
  const [rows, chunks] = await Promise.all([loadGolden(), enumerateChunks()]);
  const ids = new Set(chunks.map((c) => c.id));
  const unreachable = rows
    .filter((r) => r.type !== "out_of_scope")
    .flatMap((r) => r.sections)
    .filter((id) => !ids.has(id));
  assert.deepEqual(unreachable, []);
});

test("no chunk is empty of body text", async () => {
  const chunks = await enumerateChunks();
  const bodiless = chunks.filter((c) => c.text.split("\n\n").slice(1).join("\n\n").trim() === "");
  // Some pages legitimately have a heading with no prose before the next
  // heading. Report them rather than failing: the count is information, and a
  // sudden jump means the extent rule broke.
  console.log(`chunks with an empty body: ${bodiless.length} of ${chunks.length}`);
  assert.ok(bodiless.length < chunks.length / 2, `${bodiless.length} of ${chunks.length} chunks have no body`);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test src/corpus/chunks.test.ts`
Expected: FAIL — cannot resolve module `./chunks.ts`.

- [ ] **Step 4: Write the implementation**

`src/corpus/chunks.ts`:

```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { enumerateSections, parseSections, type Section } from "./sections.ts";

export interface Chunk {
  id: string;
  path: string;
  slug: string;
  /** Ancestors of strictly decreasing level, then the section's own heading. */
  headingPath: string[];
  /** What gets embedded: the heading path, a blank line, then the body. */
  text: string;
}

function headingPathFor(sections: Section[], index: number): string[] {
  const self = sections[index]!;
  const path: string[] = [self.title];
  let level = self.level;
  for (let k = index - 1; k >= 0; k -= 1) {
    const candidate = sections[k]!;
    if (candidate.level < level) {
      path.unshift(candidate.title);
      level = candidate.level;
    }
  }
  return path;
}

export function buildChunks(relPath: string, markdown: string): Chunk[] {
  const lines = markdown.split("\n");
  const sections = parseSections(relPath, markdown);

  return sections.map((section, index) => {
    // A section's body runs to the NEXT HEADING OF ANY LEVEL, so sections never
    // nest and no chunk contains another chunk's text.
    const start = section.line + 1;
    const end = sections[index + 1]?.line ?? lines.length;
    const body = lines.slice(start, end).join("\n").trim();
    const headingPath = headingPathFor(sections, index);

    return {
      id: section.id,
      path: section.path,
      slug: section.slug,
      headingPath,
      text: `${headingPath.join(" > ")}\n\n${body}`,
    };
  });
}

export async function enumerateChunks(corpusRoot = "corpus"): Promise<Chunk[]> {
  const sections = await enumerateSections(corpusRoot);
  const paths = [...new Set(sections.map((s) => s.path))];
  const all: Chunk[] = [];
  for (const relPath of paths) {
    const markdown = await readFile(join(corpusRoot, relPath), "utf8");
    all.push(...buildChunks(relPath, markdown));
  }
  return all;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test src/corpus/chunks.test.ts`
Expected: PASS, 8 tests. The empty-body test prints a count — record it in the commit message.

- [ ] **Step 6: Sanity-check a real chunk by eye**

Run:
```bash
node --input-type=module -e '
import { enumerateChunks } from "./src/corpus/chunks.ts";
const chunks = await enumerateChunks();
const c = chunks.find((x) => x.id === "tutorial/query-params.md#optional-parameters");
console.log(JSON.stringify({ id: c.id, headingPath: c.headingPath, chars: c.text.length }, null, 2));
console.log("---"); console.log(c.text);
'
```
Expected: `headingPath` is `["Query Parameters", "Optional parameters"]`, and the text begins `Query Parameters > Optional parameters` followed by that section's prose only. The probe measured this chunk at 453 characters; a wildly different size means the extent rule is wrong.

- [ ] **Step 7: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean; 53 passing.

```bash
git add src/corpus/chunks.ts src/corpus/chunks.test.ts tests/fixtures/chunk-extent.md
git commit -m "$(cat <<'EOF'
feat: turn sections into embeddable chunks

Adds extent to the identity sections.ts already provides. A body runs
from its heading to the next heading of ANY level, so sections never
nest — without that rule an H1 would span a whole file, since every
corpus file has exactly one H1, and one golden row's gold would contain
another's.

The embedded text carries the heading path, because eight gold sections
are page intros with little prose of their own and the path is what
disambiguates anchors that repeat across files.

Two tests guard the seam that no other test would catch: the chunk id
set must equal the section id set, and every in-scope golden row's gold
must have a chunk. Without them, identity and extent could drift apart
and a golden row would become unreachable with the suite still green.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

### Task 4: The embedder

**Files:**
- Create: `src/embed/provider.ts`
- Test: `src/embed/provider.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export const EMBEDDING_MODEL = "nomic-embed-text";
  export const EMBEDDING_DIM = 768;
  export const DOCUMENT_PREFIX = "search_document: ";
  export const QUERY_PREFIX = "search_query: ";
  export const BATCH_SIZE = 64;

  export function ollamaUrl(): string;
  export function batch<T>(items: T[], size: number): T[][];
  export function assertDimensions(vectors: number[][]): void;

  export interface Embedder {
    readonly model: string;
    embedDocuments(texts: string[]): Promise<number[][]>;
    embedQuery(text: string): Promise<number[]>;
  }
  export function ollamaEmbedder(): Embedder;
  ```

The provider wiring, already verified against the running Ollama — use it exactly:

```ts
createOllama({ baseURL: `${ollamaUrl()}/api` }).textEmbeddingModel(EMBEDDING_MODEL)
```

The `/api` suffix is required; `OLLAMA_URL` does not carry it.

- [ ] **Step 1: Write the failing test**

`src/embed/provider.test.ts` — only the pure helpers are unit-tested. `ollamaEmbedder` itself needs a running Ollama and is exercised by `ingest`.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertDimensions,
  batch,
  BATCH_SIZE,
  DOCUMENT_PREFIX,
  EMBEDDING_DIM,
  ollamaUrl,
  QUERY_PREFIX,
} from "./provider.ts";

test("batch splits into groups of at most size", () => {
  assert.deepEqual(batch([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("batch returns nothing for an empty input", () => {
  assert.deepEqual(batch([], 64), []);
});

test("batch keeps a single group when it fits", () => {
  assert.deepEqual(batch([1, 2], 64), [[1, 2]]);
});

test("batch rejects a non-positive size", () => {
  assert.throws(() => batch([1], 0), /size must be positive/);
});

test("assertDimensions accepts correctly sized vectors", () => {
  const ok = [new Array<number>(EMBEDDING_DIM).fill(0), new Array<number>(EMBEDDING_DIM).fill(1)];
  assert.doesNotThrow(() => assertDimensions(ok));
});

test("assertDimensions names the offending index", () => {
  const bad = [new Array<number>(EMBEDDING_DIM).fill(0), new Array<number>(3).fill(0)];
  assert.throws(() => assertDimensions(bad), /index 1 .*3 .*768/);
});

test("ollamaUrl prefers OLLAMA_URL and falls back to the local default", () => {
  const original = process.env.OLLAMA_URL;
  try {
    process.env.OLLAMA_URL = "http://example:1234";
    assert.equal(ollamaUrl(), "http://example:1234");
    delete process.env.OLLAMA_URL;
    assert.equal(ollamaUrl(), "http://127.0.0.1:11434");
  } finally {
    if (original === undefined) delete process.env.OLLAMA_URL;
    else process.env.OLLAMA_URL = original;
  }
});

test("ollamaUrl strips a trailing slash so the /api suffix cannot double up", () => {
  const original = process.env.OLLAMA_URL;
  try {
    process.env.OLLAMA_URL = "http://example:1234/";
    assert.equal(ollamaUrl(), "http://example:1234");
  } finally {
    if (original === undefined) delete process.env.OLLAMA_URL;
    else process.env.OLLAMA_URL = original;
  }
});

test("the prefixes are the ones nomic documents", () => {
  assert.equal(DOCUMENT_PREFIX, "search_document: ");
  assert.equal(QUERY_PREFIX, "search_query: ");
  assert.equal(BATCH_SIZE, 64);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/embed/provider.test.ts`
Expected: FAIL — cannot resolve module `./provider.ts`.

- [ ] **Step 3: Write the implementation**

`src/embed/provider.ts`:

```ts
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

export function assertDimensions(vectors: number[][]): void {
  for (const [index, vector] of vectors.entries()) {
    if (vector.length !== EMBEDDING_DIM) {
      throw new Error(
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

function unreachable(error: unknown): never {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(
    `Cannot reach Ollama at ${ollamaUrl()}\n` +
      `  ${reason}\n\n` +
      `Is it running? Start it and pull the model:\n` +
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
          if (error instanceof Error && /dimensions, expected/.test(error.message)) throw error;
          unreachable(error);
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
        if (error instanceof Error && /dimensions, expected/.test(error.message)) throw error;
        unreachable(error);
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/embed/provider.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Smoke-test against the running Ollama**

Run:
```bash
node --input-type=module -e '
import { ollamaEmbedder, EMBEDDING_DIM } from "./src/embed/provider.ts";
const e = ollamaEmbedder();
const docs = await e.embedDocuments(["hello", "world"]);
const q = await e.embedQuery("hello");
console.log("documents:", docs.length, "dim", docs[0].length, "expected", EMBEDDING_DIM);
console.log("query dim:", q.length);
'
```
Expected: `documents: 2 dim 768 expected 768` and `query dim: 768`. If it reports Ollama unreachable, start it — do not change the code.

- [ ] **Step 6: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean; 62 passing.

```bash
git add src/embed/provider.ts src/embed/provider.test.ts
git commit -m "$(cat <<'EOF'
feat: embed through the AI SDK against a host Ollama

The prefixes nomic documents are applied inside the embedder, so no
caller can forget one or apply the wrong one, and documents are batched
in groups of 64 rather than sent as one 944-value request.

Every vector's dimension is asserted with the offending index named.
The chunks.embedding column is vector(768), so a silent dimension change
would fail at insert time with a far less legible error.

Only the pure helpers are unit-tested. ollamaEmbedder's behaviour is the
AI SDK's plus two string prefixes, and testing it would require Ollama
in the suite, which must pass on a fresh clone.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

### Task 5: The top-k query

**Files:**
- Create: `src/retrieve/search.ts`
- Test: `src/retrieve/search.test.ts`

**Interfaces:**
- Consumes: `connect`, `databaseUrl` from `src/db/client.ts`.
- Produces:
  ```ts
  export interface Hit { id: string; score: number }
  export function toVectorLiteral(vector: number[]): string;
  export async function topK(
    client: import("pg").Client, queryVector: number[], k: number, model: string,
  ): Promise<Hit[]>;
  ```

- [ ] **Step 1: Write the failing test**

`src/retrieve/search.test.ts`. The database-dependent tests must **skip visibly** when Postgres is unavailable, because `npm test` has to pass on a fresh clone.

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { databaseUrl } from "../db/client.ts";
import { toVectorLiteral, topK } from "./search.ts";
import { EMBEDDING_DIM } from "../embed/provider.ts";

test("toVectorLiteral produces the format pgvector parses", () => {
  assert.equal(toVectorLiteral([0.1, -0.2, 3]), "[0.1,-0.2,3]");
});

test("toVectorLiteral rejects the wrong dimension", () => {
  assert.throws(() => toVectorLiteral([1, 2, 3]), /3 dimensions, expected 768/);
});

// One probe decides whether the database-backed tests run. A skip is printed,
// never silent — a green suite must not hide that these did not execute.
async function probe(): Promise<string | false> {
  const client = new Client({ connectionString: databaseUrl() });
  try {
    await client.connect();
    await client.end();
    return false;
  } catch {
    return `SKIPPED (no database at ${databaseUrl()})`;
  }
}
const skip = await probe();
if (skip !== false) console.log(`search.test.ts: ${skip}`);

function unit(index: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[index] = 1;
  return v;
}

test("ranks by cosine distance and reports similarity", { skip }, async () => {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM chunks WHERE id LIKE 'test::%'");
    for (const [i, id] of ["test::a", "test::b", "test::c"].entries()) {
      await client.query(
        `INSERT INTO chunks (id, path, slug, heading_path, text, hash, embedding, model)
         VALUES ($1, 'p.md', 's', ARRAY['h'], 't', 'h', $2::vector, 'test-model')`,
        [id, toVectorLiteral(unit(i))],
      );
    }

    const hits = await topK(client, unit(1), 3, "test-model");
    assert.deepEqual(hits.map((h) => h.id), ["test::b", "test::a", "test::c"]);
    assert.ok(hits[0]!.score > 0.99, `expected ~1, got ${hits[0]!.score}`);
    assert.ok(Math.abs(hits[1]!.score) < 0.01, `orthogonal should be ~0, got ${hits[1]!.score}`);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});

test("breaks ties by id, deterministically", { skip }, async () => {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const id of ["test::z", "test::a"]) {
      await client.query(
        `INSERT INTO chunks (id, path, slug, heading_path, text, hash, embedding, model)
         VALUES ($1, 'p.md', 's', ARRAY['h'], 't', 'h', $2::vector, 'test-model')`,
        [id, toVectorLiteral(unit(0))],
      );
    }
    const hits = await topK(client, unit(0), 2, "test-model");
    assert.deepEqual(hits.map((h) => h.id), ["test::a", "test::z"]);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});

test("ignores rows belonging to another model", { skip }, async () => {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO chunks (id, path, slug, heading_path, text, hash, embedding, model)
       VALUES ('test::other', 'p.md', 's', ARRAY['h'], 't', 'h', $1::vector, 'other-model')`,
      [toVectorLiteral(unit(0))],
    );
    const hits = await topK(client, unit(0), 5, "test-model");
    assert.deepEqual(hits.filter((h) => h.id === "test::other"), []);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/retrieve/search.test.ts`
Expected: FAIL — cannot resolve module `./search.ts`.

- [ ] **Step 3: Write the implementation**

`src/retrieve/search.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/retrieve/search.test.ts`
Expected: PASS, 5 tests, with the database-backed three actually running (the container is up). If they skip, start the container — do not accept a skip here.

- [ ] **Step 5: Verify the skip path works too**

Run: `DATABASE_URL=postgres://nobody@localhost:1/none node --test src/retrieve/search.test.ts`
Expected: PASS with `SKIPPED (no database at …)` printed and the three database tests reported as skipped, not failed.

- [ ] **Step 6: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean; 67 passing.

```bash
git add src/retrieve/search.ts src/retrieve/search.test.ts
git commit -m "$(cat <<'EOF'
feat: top-k retrieval over pgvector

Ordering is `embedding <=> $1::vector` — cosine distance — so similarity
is 1 - distance and no normalization step exists in application code to
get wrong. Ties break by id so results are deterministic, and the query
filters on model so a partially-completed ingest surfaces as fewer
candidates rather than as wrong scores.

The database-backed tests run inside a transaction that rolls back, and
they skip with a printed SKIPPED line when Postgres is absent, because
npm test has to pass on a fresh clone. Both paths were verified.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

### Task 6: Scoring recall@5

**Files:**
- Create: `src/evals/recall.ts`
- Test: `src/evals/recall.test.ts`

**Interfaces:**
- Consumes: `GoldenRow` from `src/evals/golden.ts`.
- Produces:
  ```ts
  export interface RowResult {
    id: string; question: string; hit: boolean;
    gold: string[]; retrieved: string[]; goldRank: number | null;
  }
  export interface RecallReport {
    k: number; hits: number; total: number; recallAt5: number; rows: RowResult[];
  }
  export const EXPECTED_IN_SCOPE = 20;
  export function scoreRecall(
    rows: GoldenRow[], retrievedByRowId: Map<string, string[]>, k: number,
  ): RecallReport;
  ```

Pure, no I/O. That purity is what keeps Ollama and Postgres out of this module's tests.

- [ ] **Step 1: Write the failing test**

`src/evals/recall.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GoldenRow } from "./golden.ts";
import { scoreRecall } from "./recall.ts";

function row(over: Partial<GoldenRow> = {}): GoldenRow {
  return {
    id: "q001",
    question: "How do I make a query parameter optional?",
    type: "how_to",
    sections: ["a#1"],
    url: "https://example.com/a/#1",
    note: "n",
    line: 1,
    ...over,
  };
}

/** 20 in-scope rows with distinct ids and golds, so the denominator is valid. */
function twentyInScope(): GoldenRow[] {
  return Array.from({ length: 20 }, (_, i) =>
    row({
      id: `q${String(i + 1).padStart(3, "0")}`,
      question: `question ${i}`,
      sections: [`s${i}#g`],
    }),
  );
}

function allHit(rows: GoldenRow[]): Map<string, string[]> {
  return new Map(rows.map((r) => [r.id, [r.sections[0]!]]));
}

test("a gold at rank k counts as a hit", () => {
  const rows = twentyInScope();
  const retrieved = allHit(rows);
  const first = rows[0]!;
  retrieved.set(first.id, ["x#1", "x#2", "x#3", "x#4", first.sections[0]!]);
  const report = scoreRecall(rows, retrieved, 5);
  assert.equal(report.rows.find((r) => r.id === first.id)!.hit, true);
  assert.equal(report.rows.find((r) => r.id === first.id)!.goldRank, 5);
});

test("a gold at rank k+1 does not count, but its rank is still recorded", () => {
  const rows = twentyInScope();
  const retrieved = allHit(rows);
  const first = rows[0]!;
  retrieved.set(first.id, ["x#1", "x#2", "x#3", "x#4", "x#5", first.sections[0]!]);
  const report = scoreRecall(rows, retrieved, 5);
  const result = report.rows.find((r) => r.id === first.id)!;
  assert.equal(result.hit, false);
  assert.equal(result.goldRank, 6);
  assert.equal(report.hits, 19);
  assert.equal(report.recallAt5, 0.95);
});

test("a multi-entry gold hits on any member", () => {
  const rows = twentyInScope();
  rows[0]!.sections = ["s0#g", "s0#alt"];
  const retrieved = allHit(rows);
  retrieved.set(rows[0]!.id, ["x#1", "s0#alt"]);
  const report = scoreRecall(rows, retrieved, 5);
  assert.equal(report.rows[0]!.hit, true);
  assert.equal(report.rows[0]!.goldRank, 2);
});

test("goldRank is null when no gold appears at all", () => {
  const rows = twentyInScope();
  const retrieved = allHit(rows);
  retrieved.set(rows[0]!.id, ["x#1", "x#2"]);
  const report = scoreRecall(rows, retrieved, 5);
  assert.equal(report.rows[0]!.goldRank, null);
  assert.equal(report.rows[0]!.hit, false);
});

test("out_of_scope rows are excluded from the report entirely", () => {
  const rows = [
    ...twentyInScope(),
    row({ id: "q021", question: "django?", type: "out_of_scope", sections: [], url: undefined }),
  ];
  const report = scoreRecall(rows, allHit(rows), 5);
  assert.equal(report.total, 20);
  assert.equal(report.rows.length, 20);
  assert.deepEqual(report.rows.filter((r) => r.id === "q021"), []);
});

test("a denominator other than 20 throws", () => {
  const rows = twentyInScope().slice(0, 19);
  assert.throws(() => scoreRecall(rows, allHit(rows), 5), /19 in-scope rows, expected 20/);
});

test("a row with no retrieval entry throws rather than scoring as a miss", () => {
  const rows = twentyInScope();
  const retrieved = allHit(rows);
  retrieved.delete(rows[3]!.id);
  assert.throws(() => scoreRecall(rows, retrieved, 5), /no retrieval recorded for q004/);
});

test("all hits gives recall 1, none gives 0", () => {
  const rows = twentyInScope();
  assert.equal(scoreRecall(rows, allHit(rows), 5).recallAt5, 1);
  const none = new Map(rows.map((r) => [r.id, ["nope#1"]]));
  assert.equal(scoreRecall(rows, none, 5).recallAt5, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/evals/recall.test.ts`
Expected: FAIL — cannot resolve module `./recall.ts`.

- [ ] **Step 3: Write the implementation**

`src/evals/recall.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/evals/recall.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Typecheck, full suite, commit**

Run: `npm run typecheck && npm test`
Expected: clean; 75 passing.

```bash
git add src/evals/recall.ts src/evals/recall.test.ts
git commit -m "$(cat <<'EOF'
feat: score recall@5 over the in-scope golden rows

Pure and I/O-free, which is what keeps Ollama and Postgres out of these
tests while still covering the logic that decides the number.

Two deliberate failures rather than quiet wrong answers: a denominator
other than 20 throws, because a changed golden set makes the score
incomparable to earlier runs; and a row with no retrieval entry throws
instead of scoring as a miss, since a missing lookup is a bug in the
caller, not evidence about the retriever.

goldRank is recorded past k on purpose. A gold at rank 7 is a tuning
problem; at rank 400 it is a corpus problem, and the aggregate cannot
tell them apart.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

### Task 7: `npm run ingest`

**Files:**
- Create: `scripts/ingest.ts`
- Modify: `package.json` (add the `ingest` script)

**Interfaces:**
- Consumes: `enumerateChunks` (Task 3), `ollamaEmbedder`/`EMBEDDING_MODEL` (Task 4), `connect`/`fail` (Task 1), `toVectorLiteral` (Task 5).
- Produces: a populated `chunks` table. No exported API.

- [ ] **Step 1: Write the script**

`scripts/ingest.ts`:

```ts
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
```

- [ ] **Step 2: Add the npm script**

In `package.json`, after `db:reset`:

```json
"ingest": "node --env-file-if-exists=.env scripts/ingest.ts",
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Run the first full ingest**

Run: `npm run ingest`
Expected: `corpus: 944 chunks`, `to embed: 944, skipping 0`, a progress line, then roughly `embedded 944, skipped 0, deleted 0 in ~40s` and `chunks: 944 rows, 944 embedded`.

If Ollama is unreachable it exits naming `ollama serve` — start it rather than changing code.

- [ ] **Step 5: Verify the cache by re-running**

Run: `npm run ingest`
Expected: `to embed: 0, skipping 944` and `embedded 0, skipped 944, deleted 0` in about a second. This is the hash cache working; if it re-embeds everything, the hash is not stable and that must be fixed before moving on.

- [ ] **Step 6: Verify the stored rows directly**

Run:
```bash
docker exec agentlab-db psql -U agentlab -d agentlab -c \
  "SELECT count(*), count(embedding), count(DISTINCT model), min(vector_dims(embedding)), max(vector_dims(embedding)) FROM chunks"
```
Expected: `944 | 944 | 1 | 768 | 768`.

- [ ] **Step 7: Commit**

Run: `npm test`
Expected: 75 passing.

```bash
git add scripts/ingest.ts package.json
git commit -m "$(cat <<'EOF'
feat: ingest the corpus into pgvector

Embeds only what changed. A chunk is re-embedded when it is new, when
its text hash moved, or when its stored row came from a different model
— that last condition is what makes a model swap invalidate every row
rather than silently mixing two models' vectors in one column.

Rows whose id left the corpus are deleted, so the table cannot drift
away from the section set the golden rows point into.

Verified: a first run embeds 944 in about 40s; an immediate re-run
embeds 0 and skips 944.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

### Task 8: `npm run eval` — the first number

**Files:**
- Create: `scripts/eval.ts`
- Modify: `package.json` (add the `eval` script), `README.md` (Running it, Results)
- Commit: the first `evals/results/<iso>.json`

**Interfaces:**
- Consumes: `connect` (Task 1), `ollamaEmbedder`/`EMBEDDING_MODEL` (Task 4), `topK` (Task 5), `scoreRecall` (Task 6), `loadGolden` and `validateGolden` (already in the repo), `enumerateSections` for the expected count.
- Produces: `evals/results/<ISO>.json` and the printed score.

- [ ] **Step 1: Write the script**

`scripts/eval.ts`:

```ts
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
```

- [ ] **Step 2: Add the npm script**

In `package.json`, after `ingest`:

```json
"eval": "node --env-file-if-exists=.env scripts/eval.ts",
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 4: Verify the precondition guard fires**

Run:
```bash
docker exec agentlab-db psql -U agentlab -d agentlab -c \
  "BEGIN; UPDATE chunks SET embedding = NULL WHERE id = (SELECT min(id) FROM chunks); \
   SELECT count(embedding) FROM chunks; ROLLBACK"
```
That only proves the data can be broken inside a transaction. To exercise the guard for real, temporarily point at an empty database:

Run: `docker exec agentlab-db psql -U agentlab -d agentlab -c "CREATE DATABASE evalguard"`
Run: `DATABASE_URL=postgres://agentlab:agentlab@localhost:5433/evalguard npm run db:setup`
Run: `DATABASE_URL=postgres://agentlab:agentlab@localhost:5433/evalguard npm run eval`
Expected: exits 1 with `rows 0 (expected 944), embedded 0, distinct models 0 (expected 1)` and `npm run ingest`.
Run: `docker exec agentlab-db psql -U agentlab -d agentlab -c "DROP DATABASE evalguard"`

- [ ] **Step 5: Run the eval — this is the first measurement**

Run: `npm run eval`
Expected: a `recall@5 = 0.xx (n/20)` line, the missed rows with their gold ranks, and a written artifact path.

**Do not tune anything in response to the number.** Record it. Per the README, resolution at n=20 is about 15pp, so the first score is a baseline, not a target. Note in particular whether q013 missed — the spec predicts it will, for a documented corpus reason.

- [ ] **Step 6: Fill in the README's results row**

The Results table's `v1` row stays empty — v1 means both numbers, and classification accuracy arrives in chunk 3. Add a row above it for this chunk:

```markdown
| Version | Classification accuracy | recall@5 | Model | Date |
| ------- | ----------------------- | -------- | ----- | ---- |
| 2b (retrieval only) | – | <the measured value> | nomic-embed-text | 2026-09-11 |
| v1      | –                       | –        | –     | –    |
```

Also replace the `npm run eval` sentence under **What gets measured** — it currently says the eval "will run the questions and print both numbers — that arrives with the next chunk". It now prints one:

```markdown
`npm run validate:golden` proves every row points at a section that exists. `npm run ingest` embeds
the corpus and `npm run eval` scores recall@5 over the 20 in-scope rows, writing a JSON artifact
under `evals/results/`. Classification accuracy arrives with the `classify` node.
```

And add the two commands to the **Running it** block, after `npm run db:check`:

```bash
npm run ingest            # embed 944 chunks into pgvector (~40s, needs Ollama)
npm run eval              # score recall@5 and write evals/results/<iso>.json
```

- [ ] **Step 7: Commit the code, the artifact, and the README**

Run: `npm test`
Expected: 75 passing.

```bash
git add scripts/eval.ts package.json README.md evals/results
git commit -m "$(cat <<'EOF'
feat: score recall@5 and record the first measurement

npm run eval embeds the 20 in-scope questions, retrieves the top 5 from
pgvector, and writes a committed JSON artifact alongside the printed
score. The artifact is committed because chunk 7 compares two embedding
models and would otherwise have nothing to compare against.

It refuses to score unless the table holds exactly one chunk per section,
all embedded, all from one model, and unless the golden set validates.
A half-ingested table yields a number that looks real and is not.

Stdout lists every missed row with its gold's actual rank and the five
results that beat it, because the aggregate alone is not actionable.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

## Verification

After Task 8, all of these must hold:

```bash
npm run typecheck        # exit 0, no output
npm test                 # 75 passing
npm run validate:golden  # 30 rows (10/10/10) against 944 sections, golden set OK
npm run db:check         # 944 rows, 944 embedded, schema matches
npm run ingest           # to embed: 0, skipping 944
npm run eval             # recall@5 = 0.xx (n/20)
git status --short        # clean
```

And one judgement no command makes: read the missed rows. A miss whose gold ranked 6th or 7th is a
retrieval problem worth a later chunk. A miss whose gold ranked in the hundreds means the chunk text
or the gold choice is wrong, and that is worth investigating before any tuning. q013 is expected to
miss for a documented corpus reason, and a miss there is not evidence about the retriever.
