# Golden Set Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the vendored FastAPI docs corpus, a section-identity module, 30 hand-authored golden questions, and a validator that proves every golden row points at a section that exists.

**Architecture:** The corpus is vendored at a pinned upstream commit and committed to git, so a fresh checkout reproduces the same scores. `src/corpus/sections.ts` is the single place that turns markdown files into identified sections; the validator consumes it now and the future ingest pipeline will consume it later, so a section id in `golden.jsonl` can never mean something different from a section id emitted by retrieval. The 30 questions are authored by hand in user voice, then grounded to sections — in that order — because generating questions from section text inflates recall@5 through lexical overlap.

**Tech Stack:** TypeScript run natively by Node 25 (type stripping — no bundler, no ts-node), `node:test` for tests, `tsc --noEmit` for type checking. Zero runtime dependencies in this chunk.

**Spec:** `docs/superpowers/specs/2026-09-10-golden-set-design.md`

## Global Constraints

- Node >= 22.18 (native TypeScript type stripping). Verified on v25.9.0.
- `package.json` has `"type": "module"`. All relative imports include the explicit `.ts` extension — Node's type stripping does not resolve extensionless specifiers.
- No runtime dependencies. Dev dependencies limited to `typescript` and `@types/node`.
- Corpus pinned at tag `0.141.1`, commit `95f8322ee1dcda7ceace7b1c4f6c9915b36d748f`.
- Vendored subpaths, from upstream `docs/en/docs/`: `tutorial/`, `advanced/`, `how-to/`, `deployment/`.
- Section id format: `<path relative to corpus/>#<anchor>`, e.g. `tutorial/query-params.md#optional-parameters`.
- Public URL base: `https://fastapi.tiangolo.com/`.
- Label mix in `evals/golden.jsonl`: exactly 10 `how_to`, 10 `concept`, 10 `out_of_scope`.
- Every commit message ends with the AI trail:
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
| `package.json` | Scripts + dev dependencies |
| `tsconfig.json` | Type checking only (`noEmit`) |
| `.gitignore` | `node_modules`, `.env` |
| `scripts/fetch-corpus.sh` | Sparse-checkout the pinned upstream commit into `corpus/`, write `corpus/SOURCE.md` |
| `corpus/**/*.md` | Vendored documentation (committed) |
| `corpus/SOURCE.md` | Tag, SHA, subpaths, license attribution |
| `src/corpus/urls.ts` | `toUrl()` — section id parts to public URL |
| `src/corpus/sections.ts` | `slugify()`, `parseSections()`, `enumerateSections()` |
| `src/evals/golden.ts` | Golden row types, JSONL parsing |
| `src/evals/validate.ts` | Validation rules over rows + sections |
| `scripts/list-sections.ts` | Print every section id — the grounding tool for authoring |
| `scripts/validate-golden.ts` | CLI wrapper, non-zero exit on any fatal problem |
| `evals/golden.jsonl` | The 30 questions |
| `tests/fixtures/*.md` | Hand-written markdown for parser unit tests |

---

### Task 1: Scaffold and vendor the corpus

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `scripts/fetch-corpus.sh`
- Create (generated, committed): `corpus/**/*.md`, `corpus/SOURCE.md`
- Test: `tests/corpus-vendored.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: a populated `corpus/` directory; npm scripts `typecheck`, `test`, `corpus:fetch`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "agent-lab",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.18" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "node --test",
    "corpus:fetch": "bash scripts/fetch-corpus.sh"
  },
  "devDependencies": {
    "typescript": "^5.9.0",
    "@types/node": "^24.0.0"
  }
}
```

- [ ] **Step 2: Write `tsconfig.json`**

Type checking only. `allowImportingTsExtensions` is required because our imports carry `.ts`, which Node needs and `tsc` otherwise rejects.

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Write `.gitignore`**

```
node_modules/
.env
```

- [ ] **Step 4: Install dev dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` written, no errors.

- [ ] **Step 5: Write `scripts/fetch-corpus.sh`**

Fetches the tag and then asserts the resolved commit equals the pin, so an upstream tag move is caught rather than silently vendored.

```bash
#!/usr/bin/env bash
set -euo pipefail

TAG="0.141.1"
SHA="95f8322ee1dcda7ceace7b1c4f6c9915b36d748f"
UPSTREAM="https://github.com/fastapi/fastapi.git"
SUBDIRS=(tutorial advanced how-to deployment)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$TMP" init -q
git -C "$TMP" remote add origin "$UPSTREAM"
git -C "$TMP" config core.sparseCheckout true
git -C "$TMP" sparse-checkout set --no-cone \
  'docs/en/docs/tutorial/**' \
  'docs/en/docs/advanced/**' \
  'docs/en/docs/how-to/**' \
  'docs/en/docs/deployment/**'
git -C "$TMP" fetch -q --depth 1 origin "refs/tags/$TAG"
git -C "$TMP" checkout -q FETCH_HEAD

RESOLVED="$(git -C "$TMP" rev-parse HEAD)"
if [[ "$RESOLVED" != "$SHA" ]]; then
  echo "PIN MISMATCH: tag $TAG resolves to $RESOLVED, expected $SHA" >&2
  exit 1
fi

rm -rf "$REPO_ROOT/corpus"
mkdir -p "$REPO_ROOT/corpus"
for d in "${SUBDIRS[@]}"; do
  cp -R "$TMP/docs/en/docs/$d" "$REPO_ROOT/corpus/$d"
done

FILE_COUNT="$(find "$REPO_ROOT/corpus" -name '*.md' | wc -l | tr -d ' ')"

cat > "$REPO_ROOT/corpus/SOURCE.md" <<EOF
# Corpus source

Vendored from [fastapi/fastapi]($UPSTREAM).

- **Tag:** \`$TAG\`
- **Commit:** \`$SHA\`
- **Upstream path:** \`docs/en/docs/\`
- **Subpaths:** ${SUBDIRS[*]}
- **Markdown files:** $FILE_COUNT

Regenerate with \`npm run corpus:fetch\`. The script fails if the tag no longer
resolves to the pinned commit.

The FastAPI documentation is © Sebastián Ramírez, MIT licensed. It is included
here as a retrieval corpus only.
EOF

echo "vendored $FILE_COUNT markdown files at $TAG ($SHA)"
```

- [ ] **Step 6: Write the failing test**

`tests/corpus-vendored.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

test("all four subpaths are vendored", () => {
  for (const dir of ["tutorial", "advanced", "how-to", "deployment"]) {
    assert.ok(existsSync(`corpus/${dir}`), `corpus/${dir} is missing`);
  }
});

test("SOURCE.md records the pinned commit", async () => {
  const source = await readFile("corpus/SOURCE.md", "utf8");
  assert.match(source, /95f8322ee1dcda7ceace7b1c4f6c9915b36d748f/);
});

test("a known section heading survived vendoring", async () => {
  const md = await readFile("corpus/tutorial/query-params.md", "utf8");
  assert.match(md, /^## Optional parameters \{ #optional-parameters \}$/m);
});
```

- [ ] **Step 7: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `corpus/tutorial is missing` (the corpus does not exist yet).

- [ ] **Step 8: Fetch the corpus**

Run: `npm run corpus:fetch`
Expected: prints `vendored <N> markdown files at 0.141.1 (95f8322…)`. If it prints `PIN MISMATCH`, stop and report — do not vendor a different commit.

- [ ] **Step 9: Run the test to verify it passes**

Run: `npm test`
Expected: PASS, 3 tests.

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore scripts/fetch-corpus.sh corpus tests/corpus-vendored.test.ts
git commit -m "$(cat <<'EOF'
feat: vendor the FastAPI docs corpus at a pinned commit

Scaffolds the project on native Node TypeScript execution with no
runtime dependencies, and sparse-checks out tutorial/advanced/how-to/
deployment from fastapi/fastapi 0.141.1. The fetch script asserts the
tag still resolves to the pinned SHA, so an upstream tag move fails
loudly instead of silently changing every future score.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

### Task 2: `toUrl()` — section id to public URL

**Files:**
- Create: `src/corpus/urls.ts`
- Test: `src/corpus/urls.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function toUrl(relPath: string, anchor: string): string` — `relPath` is relative to `corpus/` and ends in `.md`; `anchor` carries no leading `#`.

- [ ] **Step 1: Write the failing test**

`src/corpus/urls.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toUrl } from "./urls.ts";

test("drops the .md extension and adds a trailing slash", () => {
  assert.equal(
    toUrl("tutorial/query-params.md", "optional-parameters"),
    "https://fastapi.tiangolo.com/tutorial/query-params/#optional-parameters",
  );
});

test("collapses index.md to its directory", () => {
  assert.equal(
    toUrl("tutorial/index.md", "tutorial-user-guide"),
    "https://fastapi.tiangolo.com/tutorial/#tutorial-user-guide",
  );
});

test("handles a nested path", () => {
  assert.equal(
    toUrl("advanced/security/oauth2-scopes.md", "oauth2-scopes"),
    "https://fastapi.tiangolo.com/advanced/security/oauth2-scopes/#oauth2-scopes",
  );
});

test("rejects a path that is not markdown", () => {
  assert.throws(() => toUrl("tutorial/query-params.txt", "x"), /must end in \.md/);
});

test("rejects an anchor carrying a leading hash", () => {
  assert.throws(() => toUrl("tutorial/query-params.md", "#x"), /leading '#'/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/corpus/urls.test.ts`
Expected: FAIL — cannot resolve module `./urls.ts`.

- [ ] **Step 3: Write the minimal implementation**

`src/corpus/urls.ts`:

```ts
export const DOCS_BASE = "https://fastapi.tiangolo.com/";

export function toUrl(relPath: string, anchor: string): string {
  if (!relPath.endsWith(".md")) {
    throw new Error(`path must end in .md: ${relPath}`);
  }
  if (anchor.startsWith("#")) {
    throw new Error(`anchor must not carry a leading '#': ${anchor}`);
  }
  const withoutExt = relPath.slice(0, -".md".length);
  const docPath = withoutExt.endsWith("/index")
    ? withoutExt.slice(0, -"index".length)
    : withoutExt === "index"
      ? ""
      : `${withoutExt}/`;
  return `${DOCS_BASE}${docPath}#${anchor}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/corpus/urls.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Type check**

Run: `npm run typecheck`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/corpus/urls.ts src/corpus/urls.test.ts
git commit -m "$(cat <<'EOF'
feat: derive public docs URLs from section paths

toUrl() maps a corpus-relative markdown path plus an anchor to the
public fastapi.tiangolo.com URL, collapsing index.md to its directory.
The URL is what an answer cites, so it is derived rather than typed by
hand into each golden row.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

### Task 3: `enumerateSections()` — the single section-identity rule

**Files:**
- Create: `src/corpus/sections.ts`, `scripts/list-sections.ts`
- Create: `tests/fixtures/declared-anchors.md`, `tests/fixtures/fenced-code.md`, `tests/fixtures/no-anchors.md`
- Test: `src/corpus/sections.test.ts`
- Modify: `package.json` (add the `sections` script)

**Interfaces:**
- Consumes: `toUrl(relPath, anchor)` from `src/corpus/urls.ts`.
- Produces:
  ```ts
  export type AnchorSource = "declared" | "slugified";
  export interface Section {
    id: string;            // `${path}#${slug}`
    path: string;          // relative to corpus/, e.g. "tutorial/query-params.md"
    slug: string;          // anchor without '#'
    title: string;         // heading text, anchor block and inline markdown stripped
    level: number;         // 1..6
    url: string;
    anchorSource: AnchorSource;
  }
  export function slugify(headingText: string, taken: Set<string>): string;
  export function parseSections(relPath: string, markdown: string): Section[];
  export function enumerateSections(corpusRoot?: string): Promise<Section[]>;
  ```
  `enumerateSections` defaults `corpusRoot` to `"corpus"` and returns sections sorted by `path`, then document order.

- [ ] **Step 1: Write the fixtures**

`tests/fixtures/declared-anchors.md`:

```markdown
# Query Parameters { #query-parameters }

Intro prose.

## Optional parameters { #optional-parameters }

More prose.

### A deeper heading {#no-spaces-in-braces}

Prose.
```

`tests/fixtures/fenced-code.md`:

`````markdown
# Docker { #docker }

Prose.

```Dockerfile
# Install the dependencies
RUN pip install -r requirements.txt
## Not a heading either
```

## Real heading { #real-heading }

~~~bash
# Also not a heading
~~~

````text
```
# Nested fence content, still not a heading
```
````

## Last heading { #last-heading }
`````

`tests/fixtures/no-anchors.md`:

```markdown
# Getting Started

Prose.

## Using `Depends()`, *carefully*

Prose.

## Using `Depends()`, *carefully*

A duplicate heading, same text.

## Read the [docs](https://example.com)!

Prose.
```

- [ ] **Step 2: Write the failing test**

`src/corpus/sections.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { enumerateSections, parseSections, slugify } from "./sections.ts";

const fixture = (name: string) => readFile(`tests/fixtures/${name}`, "utf8");

test("reads declared anchors and strips the anchor block from the title", async () => {
  const sections = parseSections("f.md", await fixture("declared-anchors.md"));
  assert.deepEqual(
    sections.map((s) => [s.slug, s.title, s.level, s.anchorSource]),
    [
      ["query-parameters", "Query Parameters", 1, "declared"],
      ["optional-parameters", "Optional parameters", 2, "declared"],
      ["no-spaces-in-braces", "A deeper heading", 3, "declared"],
    ],
  );
});

test("builds the id from path and slug", async () => {
  const sections = parseSections("tutorial/query-params.md", await fixture("declared-anchors.md"));
  assert.equal(sections[1]?.id, "tutorial/query-params.md#optional-parameters");
  assert.equal(
    sections[1]?.url,
    "https://fastapi.tiangolo.com/tutorial/query-params/#optional-parameters",
  );
});

test("ignores hash-prefixed lines inside code fences", async () => {
  const sections = parseSections("f.md", await fixture("fenced-code.md"));
  assert.deepEqual(sections.map((s) => s.slug), ["docker", "real-heading", "last-heading"]);
});

test("slugifies a heading that declares no anchor", async () => {
  const sections = parseSections("f.md", await fixture("no-anchors.md"));
  assert.deepEqual(
    sections.map((s) => [s.slug, s.anchorSource]),
    [
      ["getting-started", "slugified"],
      ["using-depends-carefully", "slugified"],
      ["using-depends-carefully_1", "slugified"],
      ["read-the-docs", "slugified"],
    ],
  );
});

test("slugify strips punctuation and lowercases", () => {
  assert.equal(slugify("Using `Depends()`, *carefully*", new Set()), "using-depends-carefully");
});

test("slugify suffixes a within-file collision", () => {
  const taken = new Set(["a-heading"]);
  assert.equal(slugify("A heading", taken), "a-heading_1");
});

test("the real corpus yields a known section id", async () => {
  const sections = await enumerateSections();
  const ids = new Set(sections.map((s) => s.id));
  assert.ok(ids.has("tutorial/query-params.md#optional-parameters"));
});

test("no real corpus section id contains a space", async () => {
  const sections = await enumerateSections();
  const bad = sections.filter((s) => /\s/.test(s.id));
  assert.deepEqual(bad.map((s) => s.id), []);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test src/corpus/sections.test.ts`
Expected: FAIL — cannot resolve module `./sections.ts`.

- [ ] **Step 4: Write the minimal implementation**

`src/corpus/sections.ts`:

```ts
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { toUrl } from "./urls.ts";

export type AnchorSource = "declared" | "slugified";

export interface Section {
  id: string;
  path: string;
  slug: string;
  title: string;
  level: number;
  url: string;
  anchorSource: AnchorSource;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const DECLARED_ANCHOR = /\s*\{\s*#([^}\s]+)\s*\}\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

export function slugify(headingText: string, taken: Set<string>): string {
  const plain = headingText
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links keep their label
    .replace(/[`*_~]/g, "");
  const base = plain
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!taken.has(base)) return base;
  let n = 1;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

export function parseSections(relPath: string, markdown: string): Section[] {
  const sections: Section[] = [];
  const taken = new Set<string>();
  let openFence: string | null = null;

  for (const line of markdown.split("\n")) {
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      if (openFence === null) {
        openFence = marker;
        continue;
      }
      // A fence closes only on the same character, at least as long.
      if (marker[0] === openFence[0] && marker.length >= openFence.length) {
        openFence = null;
      }
      continue;
    }
    if (openFence !== null) continue;

    const heading = HEADING.exec(line);
    if (!heading) continue;

    const level = heading[1]!.length;
    const raw = heading[2]!.trim();
    const declared = DECLARED_ANCHOR.exec(raw);
    const title = (declared ? raw.slice(0, declared.index) : raw).trim();

    const slug = declared ? declared[1]! : slugify(title, taken);
    taken.add(slug);

    sections.push({
      id: `${relPath}#${slug}`,
      path: relPath,
      slug,
      title,
      level,
      url: toUrl(relPath, slug),
      anchorSource: declared ? "declared" : "slugified",
    });
  }

  return sections;
}

async function markdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "SOURCE.md")
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join("/"))
    .sort();
}

export async function enumerateSections(corpusRoot = "corpus"): Promise<Section[]> {
  const paths = await markdownFiles(corpusRoot);
  const all: Section[] = [];
  for (const relPath of paths) {
    const markdown = await readFile(join(corpusRoot, relPath), "utf8");
    all.push(...parseSections(relPath, markdown));
  }
  return all;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test src/corpus/sections.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Write the section-listing CLI**

This is the grounding tool the authoring tasks depend on.

`scripts/list-sections.ts`:

```ts
import { enumerateSections } from "../src/corpus/sections.ts";

const sections = await enumerateSections();
for (const s of sections) {
  console.log(`${s.id}\t${s.anchorSource}\t${s.title}`);
}
console.error(`${sections.length} sections`);
```

Three tab-separated columns, so the authoring tasks can grep the id and the anchor provenance is
visible without a second tool.

Add to `package.json` scripts:

```json
"sections": "node scripts/list-sections.ts"
```

- [ ] **Step 7: Verify the CLI and check for slugify fallbacks**

Run: `npm run sections | wc -l`
Expected: several hundred lines.

Run: `npm run sections 2>/dev/null | awk -F'\t' '$2 == "slugified" { print $1 }'`
Expected: no output, or a short list. Record the list in the commit message if non-empty — it is the
set of upstream headings that declare no anchor, and therefore the only ids whose stability depends
on our slugify rule.

- [ ] **Step 8: Type check and run the full suite**

Run: `npm run typecheck && npm test`
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add src/corpus/sections.ts src/corpus/sections.test.ts scripts/list-sections.ts tests/fixtures package.json
git commit -m "$(cat <<'EOF'
feat: enumerate corpus sections from declared anchors

Sections are identified by the anchor the FastAPI docs already declare
in each heading, so there is no slugify rule to keep in sync with
upstream; slugify survives only as a reported fallback. The parser
tracks code-fence state, because Dockerfile and shell comments inside
fences otherwise become sections that no retrieval can ever return.

npm run sections prints every id, which is how golden rows get grounded.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

### Task 4: Golden row types and JSONL loading

**Files:**
- Create: `src/evals/golden.ts`
- Test: `src/evals/golden.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export type GoldenType = "how_to" | "concept" | "out_of_scope";
  export const GOLDEN_TYPES: readonly GoldenType[];
  export interface GoldenRow {
    id: string;
    question: string;
    type: GoldenType;
    sections: string[];
    url?: string;
    note: string;
    line: number;   // 1-based source line, for error reporting
  }
  export function parseGoldenLine(line: string, lineNo: number): GoldenRow;
  export function loadGolden(path?: string): Promise<GoldenRow[]>;
  export function normalizeQuestion(question: string): string;
  ```
  `loadGolden` defaults `path` to `"evals/golden.jsonl"`, skips blank lines, and throws on malformed JSON or a missing required field.

- [ ] **Step 1: Write the failing test**

`src/evals/golden.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeQuestion, parseGoldenLine } from "./golden.ts";

const validLine = JSON.stringify({
  id: "q001",
  question: "How do I make a query parameter optional?",
  type: "how_to",
  sections: ["tutorial/query-params.md#optional-parameters"],
  url: "https://fastapi.tiangolo.com/tutorial/query-params/#optional-parameters",
  note: "chosen over query-params-str-validations, which covers validation",
});

test("parses a well-formed row and records its line number", () => {
  const row = parseGoldenLine(validLine, 7);
  assert.equal(row.id, "q001");
  assert.equal(row.type, "how_to");
  assert.deepEqual(row.sections, ["tutorial/query-params.md#optional-parameters"]);
  assert.equal(row.line, 7);
});

test("rejects malformed JSON with the line number", () => {
  assert.throws(() => parseGoldenLine("{nope", 3), /line 3/);
});

test("rejects an unknown type", () => {
  const bad = JSON.stringify({ ...JSON.parse(validLine), type: "howto" });
  assert.throws(() => parseGoldenLine(bad, 1), /type/);
});

test("rejects a missing note", () => {
  const { note, ...rest } = JSON.parse(validLine) as Record<string, unknown>;
  assert.throws(() => parseGoldenLine(JSON.stringify(rest), 1), /note/);
});

test("rejects sections that is not an array of strings", () => {
  const bad = JSON.stringify({ ...JSON.parse(validLine), sections: "a#b" });
  assert.throws(() => parseGoldenLine(bad, 1), /sections/);
});

test("normalizeQuestion lowercases, strips punctuation, collapses whitespace", () => {
  assert.equal(
    normalizeQuestion("How  do I,  make a query parameter OPTIONAL?"),
    "how do i make a query parameter optional",
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/evals/golden.test.ts`
Expected: FAIL — cannot resolve module `./golden.ts`.

- [ ] **Step 3: Write the minimal implementation**

`src/evals/golden.ts`:

```ts
import { readFile } from "node:fs/promises";

export type GoldenType = "how_to" | "concept" | "out_of_scope";

export const GOLDEN_TYPES: readonly GoldenType[] = ["how_to", "concept", "out_of_scope"];

export interface GoldenRow {
  id: string;
  question: string;
  type: GoldenType;
  sections: string[];
  url?: string;
  note: string;
  line: number;
}

export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function parseGoldenLine(line: string, lineNo: number): GoldenRow {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error(`line ${lineNo}: malformed JSON`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`line ${lineNo}: expected a JSON object`);
  }
  const o = raw as Record<string, unknown>;

  if (typeof o.id !== "string") throw new Error(`line ${lineNo}: id must be a string`);
  if (typeof o.question !== "string") throw new Error(`line ${lineNo}: question must be a string`);
  if (typeof o.note !== "string") throw new Error(`line ${lineNo}: note must be a string`);
  if (!GOLDEN_TYPES.includes(o.type as GoldenType)) {
    throw new Error(`line ${lineNo}: type must be one of ${GOLDEN_TYPES.join(", ")}`);
  }
  if (!isStringArray(o.sections)) {
    throw new Error(`line ${lineNo}: sections must be an array of strings`);
  }
  if (o.url !== undefined && typeof o.url !== "string") {
    throw new Error(`line ${lineNo}: url must be a string when present`);
  }

  return {
    id: o.id,
    question: o.question,
    type: o.type as GoldenType,
    sections: o.sections,
    ...(o.url === undefined ? {} : { url: o.url }),
    note: o.note,
    line: lineNo,
  };
}

export async function loadGolden(path = "evals/golden.jsonl"): Promise<GoldenRow[]> {
  const text = await readFile(path, "utf8");
  const rows: GoldenRow[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    rows.push(parseGoldenLine(line, i + 1));
  });
  return rows;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/evals/golden.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Type check**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/evals/golden.ts src/evals/golden.test.ts
git commit -m "$(cat <<'EOF'
feat: parse and type golden set rows

Row-level schema enforcement with the source line number in every
error, so a bad row in a 30-line JSONL file is findable. normalizeQuestion
gives the duplicate check a definition instead of leaving "near
duplicate" to judgement.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

### Task 5: Validation rules and the `validate:golden` CLI

**Files:**
- Create: `src/evals/validate.ts`, `scripts/validate-golden.ts`
- Create: `evals/golden.jsonl` (one seed row, so the CLI has something real to run against)
- Test: `src/evals/validate.test.ts`
- Modify: `package.json` (add the `validate:golden` script)

**Interfaces:**
- Consumes: `GoldenRow`, `loadGolden`, `normalizeQuestion` from `src/evals/golden.ts`; `Section`, `enumerateSections` from `src/corpus/sections.ts`.
- Produces:
  ```ts
  export interface Problem {
    rowId: string | null;
    line: number | null;
    kind: string;
    message: string;
    fatal: boolean;
  }
  export interface ValidateOptions { enforceCounts: boolean }
  export function validateGolden(
    rows: GoldenRow[],
    sections: Section[],
    options: ValidateOptions,
  ): Problem[];
  ```
  `enforceCounts` is `false` here and flipped to `true` in Task 9, once all 30 rows exist — otherwise Tasks 6 through 8 could not commit green.

- [ ] **Step 1: Write the failing test**

`src/evals/validate.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Section } from "../corpus/sections.ts";
import type { GoldenRow } from "./golden.ts";
import { validateGolden } from "./validate.ts";

const section = (path: string, slug: string): Section => ({
  id: `${path}#${slug}`,
  path,
  slug,
  title: slug,
  level: 2,
  url: `https://fastapi.tiangolo.com/${path.slice(0, -3)}/#${slug}`,
  anchorSource: "declared",
});

const SECTIONS = [section("tutorial/query-params.md", "optional-parameters")];

const row = (over: Partial<GoldenRow> = {}): GoldenRow => ({
  id: "q001",
  question: "How do I make a query parameter optional?",
  type: "how_to",
  sections: ["tutorial/query-params.md#optional-parameters"],
  url: "https://fastapi.tiangolo.com/tutorial/query-params/#optional-parameters",
  note: "the section that states the default-is-None rule",
  line: 1,
  ...over,
});

const kinds = (rows: GoldenRow[], enforceCounts = false) =>
  validateGolden(rows, SECTIONS, { enforceCounts })
    .filter((p) => p.fatal)
    .map((p) => p.kind)
    .sort();

test("a good row produces no fatal problems", () => {
  assert.deepEqual(kinds([row()]), []);
});

test("flags an unknown section id", () => {
  assert.deepEqual(kinds([row({ sections: ["tutorial/nope.md#gone"] })]), ["unknown-section"]);
});

test("flags an in-scope row with no sections", () => {
  assert.deepEqual(kinds([row({ sections: [], url: undefined })]), ["missing-sections"]);
});

test("flags an out_of_scope row that names a section", () => {
  assert.deepEqual(
    kinds([row({ type: "out_of_scope" })]),
    ["out-of-scope-has-sections", "out-of-scope-has-url"],
  );
});

test("accepts an out_of_scope row with no sections and no url", () => {
  assert.deepEqual(
    kinds([row({ type: "out_of_scope", sections: [], url: undefined })]),
    [],
  );
});

test("flags a url that disagrees with sections[0]", () => {
  assert.deepEqual(kinds([row({ url: "https://fastapi.tiangolo.com/wrong/#x" })]), ["url-mismatch"]);
});

test("flags a duplicate id", () => {
  assert.deepEqual(
    kinds([row(), row({ question: "How do I read a path parameter?", line: 2 })]),
    ["duplicate-id"],
  );
});

test("flags two questions that collide after normalization", () => {
  assert.deepEqual(
    kinds([row(), row({ id: "q002", question: "How  do I make a Query Parameter optional!", line: 2 })]),
    ["duplicate-question"],
  );
});

test("flags a malformed id", () => {
  assert.deepEqual(kinds([row({ id: "1" })]), ["bad-id-format"]);
});

test("reports a slugified anchor as non-fatal", () => {
  const slugified: Section[] = [{ ...SECTIONS[0]!, anchorSource: "slugified" }];
  const problems = validateGolden([row()], slugified, { enforceCounts: false });
  const p = problems.find((x) => x.kind === "slugified-anchor");
  assert.ok(p, "expected a slugified-anchor problem");
  assert.equal(p.fatal, false);
});

test("enforceCounts flags a mix that is not 10/10/10", () => {
  assert.deepEqual(kinds([row()], true), ["label-count"]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/evals/validate.test.ts`
Expected: FAIL — cannot resolve module `./validate.ts`.

- [ ] **Step 3: Write the minimal implementation**

`src/evals/validate.ts`:

```ts
import type { Section } from "../corpus/sections.ts";
import { GOLDEN_TYPES, normalizeQuestion, type GoldenRow } from "./golden.ts";

export interface Problem {
  rowId: string | null;
  line: number | null;
  kind: string;
  message: string;
  fatal: boolean;
}

export interface ValidateOptions {
  enforceCounts: boolean;
}

const ID_FORMAT = /^q\d{3}$/;
const EXPECTED_PER_LABEL = 10;

export function validateGolden(
  rows: GoldenRow[],
  sections: Section[],
  options: ValidateOptions,
): Problem[] {
  const problems: Problem[] = [];
  const byId = new Map<string, Section>(sections.map((s) => [s.id, s]));
  const seenIds = new Set<string>();
  const seenQuestions = new Map<string, string>();

  const add = (row: GoldenRow | null, kind: string, message: string, fatal = true) =>
    problems.push({
      rowId: row?.id ?? null,
      line: row?.line ?? null,
      kind,
      message,
      fatal,
    });

  for (const row of rows) {
    if (!ID_FORMAT.test(row.id)) {
      add(row, "bad-id-format", `id ${JSON.stringify(row.id)} does not match q\\d{3}`);
    }
    if (seenIds.has(row.id)) add(row, "duplicate-id", `id ${row.id} appears more than once`);
    seenIds.add(row.id);

    const normalized = normalizeQuestion(row.question);
    const previous = seenQuestions.get(normalized);
    if (previous !== undefined) {
      add(row, "duplicate-question", `question collides with ${previous} after normalization`);
    } else {
      seenQuestions.set(normalized, row.id);
    }

    if (row.note.trim() === "") add(row, "empty-note", "note must explain the section choice");

    if (row.type === "out_of_scope") {
      if (row.sections.length > 0) {
        add(row, "out-of-scope-has-sections", "an out_of_scope row must have sections: []");
      }
      if (row.url !== undefined) {
        add(row, "out-of-scope-has-url", "an out_of_scope row must not carry a url");
      }
      continue;
    }

    if (row.sections.length === 0) {
      add(row, "missing-sections", "an in-scope row must name at least one section");
      continue;
    }

    for (const id of row.sections) {
      const section = byId.get(id);
      if (section === undefined) {
        add(row, "unknown-section", `no section in the corpus has id ${id}`);
        continue;
      }
      if (section.anchorSource === "slugified") {
        add(
          row,
          "slugified-anchor",
          `${id} has no anchor declared upstream; its id depends on our slugify rule`,
          false,
        );
      }
    }

    const primary = byId.get(row.sections[0]!);
    if (primary !== undefined && row.url !== primary.url) {
      add(row, "url-mismatch", `url should be ${primary.url}`);
    }
  }

  if (options.enforceCounts) {
    for (const type of GOLDEN_TYPES) {
      const n = rows.filter((r) => r.type === type).length;
      if (n !== EXPECTED_PER_LABEL) {
        add(null, "label-count", `expected ${EXPECTED_PER_LABEL} ${type} rows, found ${n}`);
      }
    }
  }

  return problems;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test src/evals/validate.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Write the CLI**

`scripts/validate-golden.ts`:

```ts
import { enumerateSections } from "../src/corpus/sections.ts";
import { loadGolden } from "../src/evals/golden.ts";
import { validateGolden } from "../src/evals/validate.ts";

const enforceCounts = process.argv.includes("--final");

const [rows, sections] = await Promise.all([loadGolden(), enumerateSections()]);
const problems = validateGolden(rows, sections, { enforceCounts });

for (const p of problems) {
  const where = p.line === null ? "golden.jsonl" : `golden.jsonl:${p.line}`;
  const level = p.fatal ? "error" : "warn";
  console.error(`${level} ${where} [${p.kind}] ${p.message}`);
}

const counts = { how_to: 0, concept: 0, out_of_scope: 0 };
for (const row of rows) counts[row.type] += 1;
console.log(
  `${rows.length} rows (how_to ${counts.how_to}, concept ${counts.concept}, ` +
    `out_of_scope ${counts.out_of_scope}) against ${sections.length} sections`,
);

const fatal = problems.filter((p) => p.fatal).length;
if (fatal > 0) {
  console.error(`${fatal} fatal problem(s)`);
  process.exit(1);
}
console.log("golden set OK");
```

Add to `package.json` scripts:

```json
"validate:golden": "node scripts/validate-golden.ts"
```

- [ ] **Step 6: Seed `evals/golden.jsonl` with one real row**

Find the section id first:

Run: `npm run sections 2>/dev/null | cut -f1 | grep -i 'query-params.md#optional'`
Expected: `tutorial/query-params.md#optional-parameters`

Then write `evals/golden.jsonl` as a single line (no trailing content):

```jsonl
{"id":"q001","question":"How do I make a query parameter optional?","type":"how_to","sections":["tutorial/query-params.md#optional-parameters"],"url":"https://fastapi.tiangolo.com/tutorial/query-params/#optional-parameters","note":"chosen over query-params-str-validations, which covers validation rather than optionality"}
```

- [ ] **Step 7: Run the CLI**

Run: `npm run validate:golden`
Expected: `1 rows (how_to 1, concept 0, out_of_scope 0) against <N> sections` then `golden set OK`, exit 0.

Run: `npm run validate:golden -- --final`
Expected: three `label-count` errors, exit 1. This confirms the count gate works before it is switched on.

- [ ] **Step 8: Type check and run the full suite**

Run: `npm run typecheck && npm test`
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add src/evals/validate.ts src/evals/validate.test.ts scripts/validate-golden.ts evals/golden.jsonl package.json
git commit -m "$(cat <<'EOF'
feat: validate golden rows against the real corpus

Every fatal rule from the spec, plus a non-fatal report when a cited
section's anchor came from our slugify fallback rather than from
upstream. The 10/10/10 count gate lives behind --final so the three
authoring commits can each land green.

Seeds golden.jsonl with one grounded row so the CLI runs against
something real.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

### Task 6: Author the 10 `how_to` rows

**Files:**
- Modify: `evals/golden.jsonl` (q001 already exists from Task 5; add q002–q010)

**Interfaces:**
- Consumes: `npm run sections`, `npm run validate:golden`.
- Produces: 10 `how_to` rows.

**Authoring rules — apply to every row, they are what keep recall@5 honest:**

1. The question text below is fixed. It was written in newcomer vocabulary *before* any section was looked at. Do not reword it to match the section you find.
2. Never copy the section's heading or first sentence into the question.
3. `sections` holds one entry unless the documentation genuinely splits the answer across headings. Never add a second entry to make retrieval easier.
4. `note` states why this section and not the nearest competing one. A note that just restates the heading is not a note.
5. `url` must equal the `url` that `npm run sections` implies for `sections[0]` — the validator checks this, so let it catch mistakes rather than hand-typing carefully.

- [ ] **Step 1: List the candidate sections for each question**

For each question, run the search and read the top candidates before choosing:

```bash
npm run sections 2>/dev/null | grep -iE 'path-param|query'          # q002
npm run sections 2>/dev/null | grep -iE 'request-body|body'         # q003
npm run sections 2>/dev/null | grep -iE 'status-code'               # q004
npm run sections 2>/dev/null | grep -iE 'file|upload'               # q005
npm run sections 2>/dev/null | grep -iE 'form'                      # q006
npm run sections 2>/dev/null | grep -iE 'cookie'                    # q007
npm run sections 2>/dev/null | grep -iE 'https'                     # q008
npm run sections 2>/dev/null | grep -iE 'depend'                    # q009
npm run sections 2>/dev/null | grep -iE 'test'                      # q010
```

Open the file for a shortlisted candidate before committing to it, e.g.:

```bash
sed -n '/{ #optional-parameters }/,/^## /p' corpus/tutorial/query-params.md
```

- [ ] **Step 2: Append q002–q010 to `evals/golden.jsonl`**

One JSON object per line, no pretty-printing. The `question` and `type` values are fixed; fill `sections`, `url`, and `note` from Step 1.

| id | question |
| --- | --- |
| q002 | How do I read a value out of the URL path? |
| q003 | How do I accept a JSON payload in a POST request? |
| q004 | How do I make an endpoint return 201 instead of 200? |
| q005 | How do I accept an uploaded file? |
| q006 | How do I read the fields of a submitted HTML form? |
| q007 | How do I set a cookie on the response? |
| q008 | How do I serve the app over HTTPS in production? |
| q009 | How do I reuse one database connection across several endpoints? |
| q010 | How do I write an automated test that calls one of my endpoints? |

- [ ] **Step 3: Validate**

Run: `npm run validate:golden`
Expected: `10 rows (how_to 10, concept 0, out_of_scope 0) …` then `golden set OK`, exit 0.

If a `url-mismatch` appears, take the URL from the error message — it is derived from the corpus and is correct. If an `unknown-section` appears, the id was mistyped; re-run the `npm run sections` grep for it.

- [ ] **Step 4: Self-review against the authoring rules**

Read the 10 rows back and check each one:
- Does the question use a word that only appears in the section's heading? If so, that row will score well for the wrong reason — rephrase toward how someone would ask before reading the docs, keeping the same intent.
- Does any `note` merely restate the heading? Replace it with the competing section it was chosen over.
- Does any row have more than one section? Justify it in the note or cut it to one.

- [ ] **Step 5: Commit**

```bash
git add evals/golden.jsonl
git commit -m "$(cat <<'EOF'
feat: add the 10 how_to golden questions

Questions phrased in newcomer vocabulary first, then grounded to
sections via npm run sections, so retrieval is not scored on lexical
overlap with the heading it is supposed to find. Each note records the
competing section it was chosen over.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

### Task 7: Author the 10 `concept` rows

**Files:**
- Modify: `evals/golden.jsonl` (add q011–q020)

**Interfaces:**
- Consumes: `npm run sections`, `npm run validate:golden`.
- Produces: 10 `concept` rows.

**Authoring rules — the same five as Task 6, repeated because they are the point of the task:**

1. The question text below is fixed; do not reword it to match the section found.
2. Never copy the section's heading or first sentence into the question.
3. One entry in `sections` unless the docs genuinely split the answer.
4. `note` names the competing section this one was chosen over.
5. Let the validator catch `url` mistakes rather than hand-typing carefully.

Additional rule for this label: a `concept` question asks what something is, why it exists, or how it behaves — never for steps or syntax. If a question below reads as a how-to when you get to it, that is a bug in the plan; report it rather than silently relabelling.

- [ ] **Step 1: List the candidate sections**

```bash
npm run sections 2>/dev/null | grep -iE 'path-param|query-param'    # q011
npm run sections 2>/dev/null | grep -iE 'type|annotation|intro'     # q012
npm run sections 2>/dev/null | grep -iE 'async|concurren'           # q013
npm run sections 2>/dev/null | grep -iE 'depend'                    # q014
npm run sections 2>/dev/null | grep -iE 'docs|openapi|swagger'      # q015
npm run sections 2>/dev/null | grep -iE 'response-model'            # q016
npm run sections 2>/dev/null | grep -iE 'router|bigger-app'         # q017
npm run sections 2>/dev/null | grep -iE 'valid|pydantic|model'      # q018
npm run sections 2>/dev/null | grep -iE 'background'                # q019
npm run sections 2>/dev/null | grep -iE 'middleware'                # q020
```

- [ ] **Step 2: Append q011–q020 to `evals/golden.jsonl`**

| id | question |
| --- | --- |
| q011 | What is the difference between a path parameter and a query parameter? |
| q012 | Why does FastAPI care about type hints at all? |
| q013 | What changes about how a route runs if I declare it `async def`? |
| q014 | What is a dependency, and why not just call the function myself? |
| q015 | Where does the interactive API documentation page come from? |
| q016 | What does declaring a response model do that a return type annotation does not? |
| q017 | Why would I split routes into routers instead of putting them all on the app? |
| q018 | What does FastAPI actually do with a Pydantic model when a request arrives? |
| q019 | What are the limits of background tasks compared with a real task queue? |
| q020 | What can middleware see, and when does it run relative to my endpoint? |

- [ ] **Step 3: Validate**

Run: `npm run validate:golden`
Expected: `20 rows (how_to 10, concept 10, out_of_scope 0) …` then `golden set OK`, exit 0.

- [ ] **Step 4: Self-review against the authoring rules**

As in Task 6, plus: confirm each of these 10 asks *what* or *why*, not *how*. If one drifted into a how-to during grounding, that row belongs in Task 6's label — report the conflict instead of relabelling it.

- [ ] **Step 5: Commit**

```bash
git add evals/golden.jsonl
git commit -m "$(cat <<'EOF'
feat: add the 10 concept golden questions

Each asks what something is, why it exists, or how it behaves, so the
classifier is tested on a real distinction rather than on surface
phrasing. Grounded the same way as the how_to rows: phrasing first,
section second.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

### Task 8: Author the 10 `out_of_scope` rows

**Files:**
- Modify: `evals/golden.jsonl` (add q021–q030)

**Interfaces:**
- Consumes: `npm run validate:golden`.
- Produces: 10 `out_of_scope` rows, each with `sections: []` and no `url`.

These need no grounding — there is no section to find. Every row's `note` records which of the three sub-kinds it belongs to, because that grouping is the reason the set discriminates.

- [ ] **Step 1: Append q021–q030 to `evals/golden.jsonl`**

Each row: `"type":"out_of_scope"`, `"sections":[]`, no `url` key at all, and the `note` shown.

| id | question | note |
| --- | --- | --- |
| q021 | How do I define a foreign key on a Django model? | adjacent-but-absent: another Python web framework |
| q022 | How do I register a blueprint in Flask? | adjacent-but-absent: another Python web framework |
| q023 | How do I make SQLAlchemy eager-load a relationship in one query? | adjacent-but-absent: a library FastAPI apps use, documented elsewhere |
| q024 | How does Pydantic compile its validators in Rust? | adjacent-but-absent: Pydantic internals, not FastAPI usage |
| q025 | What is the worst-case time complexity of quicksort? | off-domain: general computer science |
| q026 | How do I rebase my branch onto main without losing commits? | off-domain: git, unrelated to the corpus |
| q027 | Which country won the 2018 football World Cup? | off-domain: general knowledge |
| q028 | What changed in the FastAPI 0.100 release? | in-domain, outside the vendored slice: release notes were not vendored |
| q029 | What is the complete list of keyword arguments `APIRouter()` accepts? | in-domain, outside the vendored slice: the API reference was not vendored |
| q030 | Who maintains FastAPI, and how can a company sponsor it? | in-domain, outside the vendored slice: project meta pages were not vendored |

- [ ] **Step 2: Validate without the count gate**

Run: `npm run validate:golden`
Expected: `30 rows (how_to 10, concept 10, out_of_scope 10) …` then `golden set OK`, exit 0.

If `out-of-scope-has-url` appears, a `url` key was left on a row — remove the key entirely rather than setting it to `null` or `""`.

- [ ] **Step 3: Validate with the count gate**

Run: `npm run validate:golden -- --final`
Expected: `golden set OK`, exit 0. This is the first time the gate passes.

- [ ] **Step 4: Commit**

```bash
git add evals/golden.jsonl
git commit -m "$(cat <<'EOF'
feat: add the 10 out_of_scope golden questions

Four adjacent-but-absent (Django, Flask, SQLAlchemy, Pydantic
internals), three off-domain, and three in-domain questions whose
answers live in upstream areas we did not vendor. That last group is
the discriminating one: a classifier keying on the word "FastAPI"
answers them anyway.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

### Task 9: Switch on the count gate and document the workflow

**Files:**
- Modify: `package.json` (`validate:golden` gains `--final`; `test` gains the validator)
- Modify: `README.md` (running-it commands, metric semantics)
- Create: `tests/golden-valid.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: `npm test` failing if any golden row stops pointing at a real section.

- [ ] **Step 1: Write the failing test**

`tests/golden-valid.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { enumerateSections } from "../src/corpus/sections.ts";
import { loadGolden } from "../src/evals/golden.ts";
import { validateGolden } from "../src/evals/validate.ts";

test("the committed golden set is valid, including the 10/10/10 mix", async () => {
  const [rows, sections] = await Promise.all([loadGolden(), enumerateSections()]);
  const fatal = validateGolden(rows, sections, { enforceCounts: true }).filter((p) => p.fatal);
  assert.deepEqual(
    fatal.map((p) => `${p.line ?? "-"} ${p.kind}: ${p.message}`),
    [],
  );
});

test("the golden set holds exactly 30 rows", async () => {
  const rows = await loadGolden();
  assert.equal(rows.length, 30);
});
```

- [ ] **Step 2: Run it to confirm it passes against the real file**

Run: `node --test tests/golden-valid.test.ts`
Expected: PASS, 2 tests. (This test is written last precisely because it can only pass once all 30 rows exist — if it fails, an earlier task is incomplete; fix that rather than weakening this test.)

- [ ] **Step 3: Make the gate the default**

In `package.json`, change:

```json
"validate:golden": "node scripts/validate-golden.ts --final"
```

- [ ] **Step 4: Run the full suite**

Run: `npm run typecheck && npm test && npm run validate:golden`
Expected: all clean.

- [ ] **Step 5: Update `README.md`**

In the **Running it** block, replace the command list with:

```bash
docker compose up -d      # Postgres (not used until the ingest chunk)
npm install
npm run corpus:fetch      # re-vendor the pinned FastAPI docs (already committed)
npm run sections          # list every section id
npm run validate:golden   # check the golden set against the corpus
npm test
```

In **What gets measured**, replace the golden-set paragraph with:

```markdown
The golden set is 30 questions in `evals/golden.jsonl` — 10 `how_to`, 10 `concept`, 10
`out_of_scope` — each with its expected type and, when in scope, the documentation section that
answers it. Sections are identified as `<path>#<anchor>`, where the anchor is the one the FastAPI
docs already declare in the heading.

- **Classification accuracy** is measured over all 30 rows.
- **recall@5** is measured over the 20 in-scope rows only; an `out_of_scope` row has no correct
  section to retrieve.

`npm run validate:golden` proves every row points at a section that exists. `npm run eval` will run
the questions and print both numbers — that arrives with the next chunk.
```

Under **Roadmap**, leave `v1` unchecked (three nodes and two numbers are not done) but add above it:

```markdown
- [x] corpus vendored, section identity, golden set + validator
```

- [ ] **Step 6: Commit**

```bash
git add package.json README.md tests/golden-valid.test.ts
git commit -m "$(cat <<'EOF'
feat: gate the 10/10/10 mix and document the golden set workflow

npm test now fails if any golden row stops pointing at a real corpus
section, so a corpus re-vendor cannot silently invalidate the measuring
stick. README records the section id format and that recall@5 is scored
over the 20 in-scope rows only.

🤖 Generated with Claude Code

Co-Authored-By: Claude <noreply@anthropic.com>
AI-Assisted: yes
AI-Tool: claude-code
EOF
)"
```

---

## Verification

After Task 9, all of these must hold:

```bash
npm run typecheck        # exit 0, no output
npm test                 # all suites pass
npm run validate:golden  # "30 rows (how_to 10, concept 10, out_of_scope 10) … golden set OK"
git status --short        # clean
```

And a manual check that no automated rule can make: read the 30 questions end to end and ask whether a competent FastAPI user would agree with each `type` label and each cited section. That judgement is the golden set's real validation; the validator only proves the rows are well-formed and point at something real.
