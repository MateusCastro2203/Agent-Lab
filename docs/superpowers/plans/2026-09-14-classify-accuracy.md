# Classification Accuracy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce classification accuracy over the thirty golden rows — the lab's second number — through a pure `classify` function, a few-shot prompt whose examples are mechanically proven absent from the golden set, and `npm run eval:classify`.

**Architecture:** No graph. `classify` is a function with an injectable language model, mirroring `embedderWith`/`ollamaEmbedder` from chunk 2b. Scoring is pure and separate from I/O, mirroring `scoreRecall`. The eval is its own script writing its own artifact directory, because it never touches the database while `npm run eval` refuses to run without one.

**Tech Stack:** Node 25 native TypeScript, `node:test`, AI SDK v7 (`ai@7.0.97`) with `generateObject`, `ollama-ai-provider-v2@4`, `zod@4`, Ollama on the host.

**Spec:** `docs/superpowers/specs/2026-09-14-classify-accuracy-design.md`

## Global Constraints

- `AGENT_MODEL` is a **constant** in `src/agent/classifier.ts`, never read from the environment.
- The label set comes from `GOLDEN_TYPES` in `src/evals/golden.ts`. No module declares its own list of labels.
- `temperature: 0` on every model call.
- Library modules **throw**; only `scripts/` may end the process.
- Nothing in this plan touches `corpus/`, `evals/golden.jsonl`, `db/schema.sql`, `src/retrieve/`, `src/corpus/`, or `evals/results/`. `recall@5` is not re-run and not re-scored.
- Import paths carry the explicit `.ts` extension. `verbatimModuleSyntax` and `noUncheckedIndexedAccess` are on: use `import type` for types, and index access yields `T | undefined`.
- Every unit test runs without Ollama. The smoke test is a script, not a unit test.
- Commit messages end with the trailer block used throughout this repo.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/smoke-classify.ts` | Create. Decides which model can hold a three-value enum. Standalone — does not import the prompt or the classifier |
| `src/cli.ts` | Create. `fail` and `describe`, moved out of `db/client.ts` so a script with no database can use them without loading `pg` |
| `src/embed/provider.ts` | Modify. `handleEmbedFailure` throws instead of calling `process.exit(1)` |
| `scripts/ingest.ts`, `scripts/eval.ts` | Modify. Catch what `provider.ts` now throws |
| `src/agent/prompt.ts` | Create. System prompt, `FEW_SHOT`, `renderSystem()`, `promptHash()` |
| `src/agent/prompt.test.ts` | Create. The anti-leakage guard and the balance check |
| `src/agent/classifier.ts` | Create. `AGENT_MODEL`, `classifierWith(model)`, `ollamaClassifier()` |
| `src/agent/classifier.test.ts` | Create. Stub-model tests |
| `src/evals/accuracy.ts` | Create. `scoreAccuracy()` and `summarize()`, both pure |
| `src/evals/accuracy.test.ts` | Create. Scoring tests |
| `scripts/eval-classify.ts` | Create. Three runs, artifact, console report |
| `package.json` | Modify. Two new scripts |
| `README.md` | Modify. The `v1` row |

---

### Task 1: Pin `AGENT_MODEL` by smoke test

The spec forbids any measurement before this task's amendment exists. This task downloads a model (~5 GB) — confirm with the user before running the `ollama pull` step.

**Files:**
- Create: `scripts/smoke-classify.ts`
- Modify: `package.json` (add `smoke:classify`)
- Modify: `docs/superpowers/specs/2026-09-14-classify-accuracy-design.md` (amendment)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the pinned model string, which Task 4 hard-codes as `AGENT_MODEL`.

- [ ] **Step 1: Write the smoke script**

It is deliberately standalone: it tests the *model*, not this project's prompt, so it must not import `prompt.ts` or `classifier.ts`.

```ts
// scripts/smoke-classify.ts
import { generateObject } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { z } from "zod";
import { GOLDEN_TYPES } from "../src/evals/golden.ts";
import { ollamaUrl } from "../src/embed/provider.ts";

const CANDIDATES = ["qwen3:8b", "llama3.1:8b"];

// One question per class. These are smoke-test inputs, not golden rows, and
// they are never scored — the only question is whether the model returns a
// value inside the enum at all.
const PROBES = [
  { question: "How do I add a description that shows up next to an endpoint in the docs?", expect: "how_to" },
  { question: "Why does the framework validate the response as well as the request?", expect: "concept" },
  { question: "How do I add a custom middleware in Express?", expect: "out_of_scope" },
];

const schema = z.object({ label: z.enum(GOLDEN_TYPES) });
const provider = createOllama({ baseURL: `${ollamaUrl()}/api` });

for (const candidate of CANDIDATES) {
  console.log(`\n=== ${candidate}`);
  let ok = true;
  for (const probe of PROBES) {
    try {
      const { object } = await generateObject({
        model: provider(candidate),
        schema,
        system: "Label the question with exactly one of: how_to, concept, out_of_scope.",
        prompt: probe.question,
        temperature: 0,
      });
      // Schema validity is the pass criterion. Agreement with `expect` is
      // printed because it is useful to see, but a disagreement is a
      // classification result, not a format failure, and does not fail the
      // smoke test — that is what the eval measures.
      const agree = object.label === probe.expect ? "agrees" : `says ${object.label}, expected ${probe.expect}`;
      console.log(`  ok   schema-valid, ${agree}  <- ${probe.question}`);
    } catch (error) {
      ok = false;
      console.log(`  FAIL ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (ok) {
    console.log(`\nPINNED: ${candidate} returned a schema-valid label for all three classes.`);
    process.exit(0);
  }
  console.log(`  -> ${candidate} rejected`);
}

console.error(`\nNo candidate held the enum. Do not measure. Candidates tried: ${CANDIDATES.join(", ")}`);
process.exit(1);
```

- [ ] **Step 2: Add the npm script**

In `package.json`, inside `"scripts"`:

```json
"smoke:classify": "node --env-file-if-exists=.env scripts/smoke-classify.ts"
```

- [ ] **Step 3: Confirm with the user, then pull the first candidate**

```bash
ollama pull qwen3:8b
```

- [ ] **Step 4: Run the smoke test**

Run: `npm run smoke:classify`
Expected: three `ok schema-valid` lines and `PINNED: qwen3:8b`.

If it fails, pull `llama3.1:8b` and run again. If both fail, STOP and report — the spec says no measurement runs.

- [ ] **Step 5: Amend the spec with the result**

Append to `docs/superpowers/specs/2026-09-14-classify-accuracy-design.md`:

```markdown
## Amendment — model pinned

`AGENT_MODEL` is `<the candidate that passed>`, pinned on 2026-09-14 by
`npm run smoke:classify`. It returned a schema-valid `{ label }` for one question of each of the
three classes at `temperature: 0`. Smoke output:

<paste the three ok lines and the PINNED line verbatim>
```

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke-classify.ts package.json docs/superpowers/specs/2026-09-14-classify-accuracy-design.md
git commit -m "feat: pin the classify model by smoke test, not by assumption"
```

---

### Task 2: Library modules throw; only scripts exit

`src/embed/provider.ts` calls `process.exit(1)` inside a module. Chunk 2b ruled that acceptable for scripts and flagged it blocking for this chunk. Leaving it would ship two providers with opposite error contracts.

**Files:**
- Create: `src/cli.ts`
- Modify: `src/db/client.ts` (import `fail` and `describe` from `src/cli.ts`, re-export `fail`)
- Modify: `src/embed/provider.ts:50-61` (`handleEmbedFailure`)
- Modify: `scripts/ingest.ts`, `scripts/eval.ts` (catch what now throws)

**Interfaces:**
- Produces: `fail(message: string): never` and `describe(error: unknown): string` from `src/cli.ts`; `EmbeddingFailedError` from `src/embed/provider.ts`.

- [ ] **Step 1: Create `src/cli.ts`**

Move the two helpers verbatim out of `src/db/client.ts` — the bodies do not change.

```ts
// src/cli.ts
// Process-ending helpers live here, not in db/client.ts, so a script with no
// database can use them without pulling in `pg`.

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// Connecting to `localhost` tries IPv6 and IPv4, and the failure arrives as an
// AggregateError whose own `message` is empty — the causes are in `.errors`.
// Reading only `.message` printed a blank reason, so unwrap the aggregate.
export function describe(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}
```

Verify the `describe` body against the current `src/db/client.ts` before writing, and copy what is there rather than this sketch if it differs.

- [ ] **Step 2: Point `db/client.ts` at it**

Delete both function bodies from `src/db/client.ts` and add at the top:

```ts
import { fail, describe } from "../cli.ts";
```

Then re-export `fail`, because `scripts/eval.ts` and `scripts/ingest.ts` already import it from there and this task must not churn their import lines:

```ts
export { fail } from "../cli.ts";
```

- [ ] **Step 3: Run the suite to prove nothing moved**

Run: `npm test && npx tsc --noEmit`
Expected: the same pass count as before this task, 0 failures, typecheck clean.

- [ ] **Step 4: Make `provider.ts` throw**

Replace `handleEmbedFailure` in `src/embed/provider.ts`:

```ts
export class EmbeddingFailedError extends Error {}

function handleEmbedFailure(error: unknown): never {
  if (error instanceof DimensionMismatchError) throw error;
  const reason = error instanceof Error ? error.message : String(error);
  throw new EmbeddingFailedError(
    `Embedding failed against ${ollamaUrl()}\n` +
      `  ${reason}\n\n` +
      `If Ollama is not running, start it and make sure the model is pulled:\n` +
      `  ollama serve\n` +
      `  ollama pull ${EMBEDDING_MODEL}\n`,
  );
}
```

- [ ] **Step 5: Catch it in both scripts**

In `scripts/ingest.ts` and `scripts/eval.ts`, wrap each `embedder` call site so the message still reaches the user and the exit code is still 1. In `scripts/eval.ts` the call is `await embedder.embedQuery(row.question)` inside the loop; wrap the loop:

```ts
  const embedder = ollamaEmbedder();
  const retrieved = new Map<string, string[]>();
  try {
    for (const row of inScope) {
      const vector = await embedder.embedQuery(row.question);
      const hits = await topK(client, vector, RANK_DEPTH, EMBEDDING_MODEL);
      retrieved.set(row.id, hits.map((h) => h.id));
    }
  } catch (error) {
    if (error instanceof EmbeddingFailedError) fail(error.message);
    throw error;
  }
```

Apply the same shape around the embedding loop in `scripts/ingest.ts`, and add `EmbeddingFailedError` to the existing import from `../src/embed/provider.ts` in both files.

- [ ] **Step 6: Prove the new path fires**

Run, with Ollama reachable, a deliberate break — point the scripts at a dead port for one invocation:

```bash
OLLAMA_URL=http://127.0.0.1:1 npm run eval
```

Expected: the `Embedding failed against http://127.0.0.1:1` message, the `ollama pull` hint, and exit code 1 — not an unhandled rejection and not a stack trace. Confirm with `echo $?`.

- [ ] **Step 7: Run the suite and commit**

Run: `npm test && npx tsc --noEmit`

```bash
git add src/cli.ts src/db/client.ts src/embed/provider.ts scripts/ingest.ts scripts/eval.ts
git commit -m "refactor: library modules throw, only scripts end the process"
```

---

### Task 3: The prompt and the anti-leakage guard

**Files:**
- Create: `src/agent/prompt.ts`
- Test: `src/agent/prompt.test.ts`

**Interfaces:**
- Consumes: `GoldenType`, `GOLDEN_TYPES`, `normalizeQuestion`, `loadGolden` from `src/evals/golden.ts`.
- Produces: `SYSTEM_PROMPT: string`, `FEW_SHOT: readonly FewShotExample[]`, `renderSystem(): string`, `promptHash(): string`.

- [ ] **Step 1: Write the failing test**

```ts
// src/agent/prompt.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGolden, normalizeQuestion, GOLDEN_TYPES } from "../evals/golden.ts";
import { FEW_SHOT, renderSystem, promptHash } from "./prompt.ts";

function tokens(text: string): Set<string> {
  return new Set(normalizeQuestion(text).split(" ").filter((t) => t !== ""));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

const golden = await loadGolden();

// A few-shot example drawn from the ruler measures the model on questions it
// was shown. Chunk 2c found seven defective golden rows written under rules
// their author had written, so this is a test rather than a discipline.
test("no few-shot example is a golden question", () => {
  const goldenNormalized = new Map(golden.map((r) => [normalizeQuestion(r.question), r.id]));
  for (const example of FEW_SHOT) {
    const collision = goldenNormalized.get(normalizeQuestion(example.question));
    assert.equal(collision, undefined, `"${example.question}" is ${collision}`);
  }
});

// Equality is weak: "query parameter" and "query param" are the same question
// and differ exactly. The threshold is a tripwire, not a metric.
test("no few-shot example overlaps a golden question past 0.5", () => {
  let worst = { score: 0, example: "", row: "" };
  for (const example of FEW_SHOT) {
    const a = tokens(example.question);
    for (const row of golden) {
      const score = jaccard(a, tokens(row.question));
      if (score > worst.score) worst = { score, example: example.question, row: row.id };
    }
  }
  assert.ok(
    worst.score < 0.5,
    `closest pair scored ${worst.score.toFixed(2)}: "${worst.example}" vs ${worst.row}`,
  );
  console.log(`prompt.test.ts: closest few-shot/golden pair ${worst.score.toFixed(2)} (${worst.row})`);
});

// An unbalanced example set shifts the model's prior, and then per-class
// accuracy measures the prompt's shape rather than the model.
test("few-shot is balanced two per class", () => {
  for (const label of GOLDEN_TYPES) {
    assert.equal(FEW_SHOT.filter((e) => e.label === label).length, 2, label);
  }
  assert.equal(FEW_SHOT.length, 6);
});

test("the system prompt carries every example and names every label", () => {
  const system = renderSystem();
  for (const example of FEW_SHOT) assert.ok(system.includes(example.question), example.question);
  for (const label of GOLDEN_TYPES) assert.ok(system.includes(label), label);
});

test("the prompt hash is stable and 64 hex characters", () => {
  assert.match(promptHash(), /^[0-9a-f]{64}$/);
  assert.equal(promptHash(), promptHash());
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/agent/prompt.test.ts`
Expected: FAIL — cannot resolve `./prompt.ts`.

- [ ] **Step 3: Write `src/agent/prompt.ts`**

```ts
// src/agent/prompt.ts
import { createHash } from "node:crypto";
import { GOLDEN_TYPES, type GoldenType } from "../evals/golden.ts";

export interface FewShotExample {
  question: string;
  label: GoldenType;
}

export const SYSTEM_PROMPT = `You label one question about the FastAPI documentation with exactly one of three labels.

how_to — asks for the steps or the syntax to accomplish a task.
concept — asks what something is, why it exists, or how it behaves.
out_of_scope — cannot be answered from the FastAPI documentation: it is about a different library or framework, about something unrelated to web APIs, or about a part of the FastAPI project that is not its documentation, such as release notes, the API reference, or how to contribute.

Answer with the label only.`;

// Written for this prompt and absent from evals/golden.jsonl, which
// prompt.test.ts proves rather than asserts. Two per class: out_of_scope has
// internal structure the golden set is built on — adjacent but absent, off
// domain, and in domain but outside the vendored slice — and one example
// cannot carry it.
export const FEW_SHOT: readonly FewShotExample[] = [
  { question: "How do I add a description that shows up next to an endpoint in the docs?", label: "how_to" },
  { question: "How do I return a plain text response instead of JSON?", label: "how_to" },
  { question: "What does the `Annotated` type actually add to a parameter declaration?", label: "concept" },
  { question: "Why does the framework validate the response as well as the request?", label: "concept" },
  { question: "How do I add a custom middleware in Express?", label: "out_of_scope" },
  { question: "Which FastAPI version added support for Pydantic v2?", label: "out_of_scope" },
];

export function renderSystem(): string {
  const labels = GOLDEN_TYPES.join(", ");
  const examples = FEW_SHOT.map((e) => `Q: ${e.question}\nA: ${e.label}`).join("\n\n");
  return `${SYSTEM_PROMPT}\n\nThe labels are: ${labels}\n\nExamples:\n\n${examples}`;
}

// Same device as chunk 2a's schema fingerprint: without it an edited prompt
// produces a new number and leaves no trace that anything changed. Array order
// is part of the hash because reordering examples can change the result.
export function promptHash(): string {
  return createHash("sha256")
    .update(SYSTEM_PROMPT)
    .update(JSON.stringify(FEW_SHOT))
    .digest("hex");
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test src/agent/prompt.test.ts`
Expected: 5 passing, and a printed line naming the closest few-shot/golden pair.

- [ ] **Step 5: Prove the guard actually fires**

Temporarily add `{ question: "How do I make a query parameter optional?", label: "how_to" }` to `FEW_SHOT` and re-run.
Expected: the equality test FAILS naming `q001`, and the balance test FAILS. Then **remove it** and confirm green again. A guard never seen failing is not known to work.

- [ ] **Step 6: Commit**

```bash
git add src/agent/prompt.ts src/agent/prompt.test.ts
git commit -m "feat: few-shot prompt with a mechanical anti-leakage guard"
```

---

### Task 4: The classifier

**Files:**
- Create: `src/agent/classifier.ts`
- Test: `src/agent/classifier.test.ts`

**Interfaces:**
- Consumes: `renderSystem()` from `src/agent/prompt.ts`; `GOLDEN_TYPES`, `GoldenType` from `src/evals/golden.ts`; the model string pinned in Task 1.
- Produces: `AGENT_MODEL: string`, `TEMPERATURE: 0`, `Classifier` (`{ readonly model: string; classify(question: string): Promise<GoldenType> }`), `classifierWith(model: LanguageModel): Classifier`, `ollamaClassifier(): Classifier`, `ClassifyFailedError`.

- [ ] **Step 1: Write the failing test**

The mock and its typed `doGenerateCalls` were verified against `ai@7.0.97` before this plan was written; this is the working shape, not a sketch.

```ts
// src/agent/classifier.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { classifierWith, ClassifyFailedError, AGENT_MODEL } from "./classifier.ts";
import { renderSystem } from "./prompt.ts";

function replying(text: string, calls = { n: 0 }): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      calls.n++;
      return {
        content: [{ type: "text" as const, text }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  });
}

test("a valid label round-trips", async () => {
  const model = replying(JSON.stringify({ label: "concept" }));
  assert.equal(await classifierWith(model).classify("Why does this exist?"), "concept");
});

// The seam that matters: the question must reach the model, and the rendered
// system prompt must go with it. Without this a refactor could silently send
// the question with no examples and nothing would fail.
test("the question and the rendered system prompt reach the model at temperature 0", async () => {
  const model = replying(JSON.stringify({ label: "how_to" }));
  await classifierWith(model).classify("How do I do the thing?");

  const call = model.doGenerateCalls[0]!;
  assert.equal(call.temperature, 0);
  const serialized = JSON.stringify(call.prompt);
  assert.ok(serialized.includes("How do I do the thing?"), serialized.slice(0, 200));
  assert.ok(serialized.includes(renderSystem().slice(0, 40)), "system prompt missing");
});

test("a label outside the enum is rejected rather than returned", async () => {
  const model = replying(JSON.stringify({ label: "maybe" }));
  await assert.rejects(() => classifierWith(model).classify("q"), ClassifyFailedError);
});

// One retry, then abort. Counting a format failure as a wrong answer would
// fold "cannot classify" and "cannot emit JSON" into one number.
test("it retries exactly once before failing", async () => {
  const calls = { n: 0 };
  const model = replying("not json at all", calls);
  await assert.rejects(() => classifierWith(model).classify("q"), ClassifyFailedError);
  assert.equal(calls.n, 2, `expected 2 attempts, got ${calls.n}`);
});

test("the second attempt is allowed to succeed", async () => {
  let n = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      n++;
      return {
        content: [{ type: "text" as const, text: n === 1 ? "garbage" : JSON.stringify({ label: "out_of_scope" }) }],
        finishReason: "stop" as const,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    },
  });
  assert.equal(await classifierWith(model).classify("q"), "out_of_scope");
  assert.equal(n, 2);
});

test("AGENT_MODEL is pinned to a non-empty constant", () => {
  assert.ok(AGENT_MODEL.length > 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/agent/classifier.test.ts`
Expected: FAIL — cannot resolve `./classifier.ts`.

- [ ] **Step 3: Write `src/agent/classifier.ts`**

Replace `qwen3:8b` below with whatever Task 1 pinned and recorded in the spec amendment.

```ts
// src/agent/classifier.ts
import { generateObject, type LanguageModel } from "ai";
import { createOllama } from "ollama-ai-provider-v2";
import { z } from "zod";
import { GOLDEN_TYPES, type GoldenType } from "../evals/golden.ts";
import { ollamaUrl } from "../embed/provider.ts";
import { renderSystem } from "./prompt.ts";

// Pinned by scripts/smoke-classify.ts and recorded in the spec's amendment.
// Never read from the environment: the model is part of what a recorded
// number means, and a number whose model came from an unset variable cannot
// be compared to anything.
export const AGENT_MODEL = "qwen3:8b";
export const TEMPERATURE = 0;

// The labels come from the golden set's own type. A second list here could
// drift from it, and the eval would then report a classification error where
// the defect is a constant.
const schema = z.object({ label: z.enum(GOLDEN_TYPES) });

export class ClassifyFailedError extends Error {}

export interface Classifier {
  readonly model: string;
  classify(question: string): Promise<GoldenType>;
}

// The model is a parameter so the prompt seam is testable without Ollama: a
// stub records the exact messages each call handed the SDK. Same shape as
// embedderWith, which is what closed the prefix hole in chunk 2b.
export function classifierWith(model: LanguageModel): Classifier {
  return {
    model: AGENT_MODEL,

    async classify(question: string): Promise<GoldenType> {
      let last: unknown;
      // One retry, then abort. A model that cannot hold a three-value enum is
      // a model-selection problem to surface, not a datapoint to average away.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const { object } = await generateObject({
            model,
            schema,
            system: renderSystem(),
            prompt: question,
            temperature: TEMPERATURE,
          });
          return object.label;
        } catch (error) {
          last = error;
        }
      }
      const reason = last instanceof Error ? last.message : String(last);
      throw new ClassifyFailedError(
        `Classification failed after 2 attempts for: ${question}\n  ${reason}`,
        { cause: last },
      );
    },
  };
}

export function ollamaClassifier(): Classifier {
  // baseURL needs the /api suffix; OLLAMA_URL does not carry it.
  const provider = createOllama({ baseURL: `${ollamaUrl()}/api` });
  return classifierWith(provider(AGENT_MODEL));
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test src/agent/classifier.test.ts`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/agent/classifier.ts src/agent/classifier.test.ts
git commit -m "feat: classify a question into the golden set's three labels"
```

---

### Task 5: Scoring

**Files:**
- Create: `src/evals/accuracy.ts`
- Test: `src/evals/accuracy.test.ts`

**Interfaces:**
- Consumes: `GoldenRow`, `GoldenType`, `GOLDEN_TYPES` from `src/evals/golden.ts`.
- Produces: `EXPECTED_ROWS = 30`, `scoreAccuracy(rows: GoldenRow[], predictions: Map<string, GoldenType>): AccuracyReport`, `summarize(reports: AccuracyReport[]): RunSummary`, and the `AccuracyReport`, `ClassBreakdown`, `Spread`, `RunSummary` types.

- [ ] **Step 1: Write the failing test**

```ts
// src/evals/accuracy.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { GoldenRow, GoldenType } from "./golden.ts";
import { scoreAccuracy, summarize, EXPECTED_ROWS } from "./accuracy.ts";

function rows(labels: GoldenType[]): GoldenRow[] {
  return labels.map((type, i) => ({
    id: `q${String(i + 1).padStart(3, "0")}`,
    question: `question ${i + 1}`,
    type,
    sections: [],
    note: "n",
    line: i + 1,
  }));
}

const TEN = <T>(v: T): T[] => new Array<T>(10).fill(v);
const THIRTY = rows([...TEN<GoldenType>("how_to"), ...TEN<GoldenType>("concept"), ...TEN<GoldenType>("out_of_scope")]);

function predict(fn: (row: GoldenRow) => GoldenType): Map<string, GoldenType> {
  return new Map(THIRTY.map((r) => [r.id, fn(r)]));
}

test("a perfect run scores 1", () => {
  const report = scoreAccuracy(THIRTY, predict((r) => r.type));
  assert.equal(report.accuracy, 1);
  assert.equal(report.correct, 30);
  assert.equal(report.total, 30);
  for (const cls of report.perClass) assert.equal(cls.accuracy, 1);
});

test("a run that always says how_to scores 10/30 and only that class", () => {
  const report = scoreAccuracy(THIRTY, predict(() => "how_to"));
  assert.equal(report.correct, 10);
  assert.ok(Math.abs(report.accuracy - 1 / 3) < 1e-9);
  const byLabel = new Map(report.perClass.map((c) => [c.label, c]));
  assert.equal(byLabel.get("how_to")!.accuracy, 1);
  assert.equal(byLabel.get("concept")!.accuracy, 0);
  assert.equal(byLabel.get("out_of_scope")!.accuracy, 0);
});

test("per-class support is ten each and rows carry both labels", () => {
  const report = scoreAccuracy(THIRTY, predict(() => "concept"));
  for (const cls of report.perClass) assert.equal(cls.total, 10);
  const row = report.rows.find((r) => r.id === "q001")!;
  assert.equal(row.expected, "how_to");
  assert.equal(row.predicted, "concept");
  assert.equal(row.correct, false);
});

// A wrong denominator means the golden set changed, so the number is no longer
// comparable to earlier runs.
test("a denominator other than thirty throws", () => {
  assert.throws(
    () => scoreAccuracy(THIRTY.slice(0, 29), predict((r) => r.type)),
    new RegExp(`29 rows, expected ${EXPECTED_ROWS}`),
  );
});

// Tolerating a missing prediction reports a number that is quietly measuring
// twenty-nine rows.
test("a missing prediction throws naming the row", () => {
  const partial = predict((r) => r.type);
  partial.delete("q017");
  assert.throws(() => scoreAccuracy(THIRTY, partial), /q017/);
});

test("summarize reports min, median and max across runs", () => {
  const a = scoreAccuracy(THIRTY, predict((r) => r.type));                       // 1.0
  const b = scoreAccuracy(THIRTY, predict(() => "how_to"));                      // 1/3
  const c = scoreAccuracy(THIRTY, predict((r) => (r.type === "concept" ? "how_to" : r.type))); // 20/30
  const s = summarize([a, b, c]);
  assert.ok(Math.abs(s.overall.min - 1 / 3) < 1e-9);
  assert.ok(Math.abs(s.overall.median - 2 / 3) < 1e-9);
  assert.equal(s.overall.max, 1);
  assert.equal(s.perClass.how_to.min, 1);
  assert.equal(s.perClass.concept.min, 0);
});

test("summarize refuses an empty list", () => {
  assert.throws(() => summarize([]), /at least one run/);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test src/evals/accuracy.test.ts`
Expected: FAIL — cannot resolve `./accuracy.ts`.

- [ ] **Step 3: Write `src/evals/accuracy.ts`**

```ts
// src/evals/accuracy.ts
import { GOLDEN_TYPES, type GoldenRow, type GoldenType } from "./golden.ts";

export interface ClassRow {
  id: string;
  question: string;
  expected: GoldenType;
  predicted: GoldenType;
  correct: boolean;
}

export interface ClassBreakdown {
  label: GoldenType;
  correct: number;
  total: number;
  accuracy: number;
}

export interface AccuracyReport {
  accuracy: number;
  correct: number;
  total: number;
  perClass: ClassBreakdown[];
  rows: ClassRow[];
}

export interface Spread {
  min: number;
  median: number;
  max: number;
}

export interface RunSummary {
  runs: number;
  overall: Spread;
  perClass: Record<GoldenType, Spread>;
}

export const EXPECTED_ROWS = 30;

export function scoreAccuracy(
  rows: GoldenRow[],
  predictions: Map<string, GoldenType>,
): AccuracyReport {
  // A different denominator means the golden set changed, so the number is no
  // longer comparable to earlier runs. Fail rather than publish it.
  if (rows.length !== EXPECTED_ROWS) {
    throw new Error(`golden set has ${rows.length} rows, expected ${EXPECTED_ROWS}`);
  }

  const results: ClassRow[] = rows.map((row) => {
    const predicted = predictions.get(row.id);
    if (predicted === undefined) {
      throw new Error(`no prediction recorded for ${row.id}`);
    }
    return {
      id: row.id,
      question: row.question,
      expected: row.type,
      predicted,
      correct: predicted === row.type,
    };
  });

  const perClass: ClassBreakdown[] = GOLDEN_TYPES.map((label) => {
    const of = results.filter((r) => r.expected === label);
    const correct = of.filter((r) => r.correct).length;
    return { label, correct, total: of.length, accuracy: of.length === 0 ? 0 : correct / of.length };
  });

  const correct = results.filter((r) => r.correct).length;
  return { accuracy: correct / results.length, correct, total: results.length, perClass, rows: results };
}

function spread(values: number[]): Spread {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { min: sorted[0]!, median, max: sorted[sorted.length - 1]! };
}

// temperature 0 does not make a local model bit-reproducible. Without the
// spread, the first difference between two future measurements is
// unattributable: a better prompt and the model breathing look identical.
export function summarize(reports: AccuracyReport[]): RunSummary {
  if (reports.length === 0) throw new Error("summarize needs at least one run");

  const perClass = {} as Record<GoldenType, Spread>;
  for (const label of GOLDEN_TYPES) {
    perClass[label] = spread(
      reports.map((r) => r.perClass.find((c) => c.label === label)?.accuracy ?? 0),
    );
  }

  return {
    runs: reports.length,
    overall: spread(reports.map((r) => r.accuracy)),
    perClass,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test src/evals/accuracy.test.ts`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git add src/evals/accuracy.ts src/evals/accuracy.test.ts
git commit -m "feat: score classification accuracy, overall and per class"
```

---

### Task 6: `npm run eval:classify`

**Files:**
- Create: `scripts/eval-classify.ts`
- Modify: `package.json`
- Create (by running): `evals/results-classify/<iso>.json`

**Interfaces:**
- Consumes: `loadGolden`, `validateGolden`, `enumerateSections`, `ollamaClassifier`, `AGENT_MODEL`, `TEMPERATURE`, `ClassifyFailedError`, `promptHash`, `FEW_SHOT`, `scoreAccuracy`, `summarize`, `fail`.
- Produces: the artifact whose median feeds Task 7's README row.

- [ ] **Step 1: Write the script**

```ts
// scripts/eval-classify.ts
import { mkdir, writeFile } from "node:fs/promises";
import { fail } from "../src/cli.ts";
import { loadGolden } from "../src/evals/golden.ts";
import type { GoldenType } from "../src/evals/golden.ts";
import { validateGolden } from "../src/evals/validate.ts";
import { enumerateSections } from "../src/corpus/sections.ts";
import { AGENT_MODEL, TEMPERATURE, ClassifyFailedError, ollamaClassifier } from "../src/agent/classifier.ts";
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
const classifier = ollamaClassifier();
const reports: AccuracyReport[] = [];

for (let run = 1; run <= RUNS; run++) {
  const predictions = new Map<string, GoldenType>();
  for (const row of golden) {
    try {
      predictions.set(row.id, await classifier.classify(row.question));
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
```

- [ ] **Step 2: Add the npm script**

In `package.json`, inside `"scripts"`:

```json
"eval:classify": "node --env-file-if-exists=.env scripts/eval-classify.ts"
```

- [ ] **Step 3: Prove the precondition fires before any model call**

Temporarily append a malformed line to `evals/golden.jsonl` — `{"id":"q031","question":"x","type":"how_to","sections":[],"note":"n"}` — and run `npm run eval:classify`.
Expected: it exits naming the validation problem, **without** calling the model (no run lines printed). Then `git checkout evals/golden.jsonl` and confirm it is clean with `git diff --stat`.

- [ ] **Step 4: Run the real eval**

Run: `npm run eval:classify`
Expected: three run lines, a median with a min–max spread, a per-class block, the wrong rows, and a written artifact path.

- [ ] **Step 5: Run the whole suite and typecheck**

Run: `npm test && npx tsc --noEmit`
Expected: every test passing, 0 skipped, typecheck clean.

- [ ] **Step 6: Commit the script and the artifact**

```bash
git add scripts/eval-classify.ts package.json evals/results-classify/
git commit -m "feat: measure classification accuracy over three runs"
```

---

### Task 7: The `v1` row

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the artifact written by Task 6.

- [ ] **Step 1: Fill in the results table**

Replace the `| v1 | – | – | – | – |` row. Use the **median** from the artifact, and put the min–max spread beside it. Example shape, with the real numbers substituted:

```markdown
| v1 | 0.73 (0.70–0.77) | 0.65 | qwen3:8b + nomic-embed-text | 2026-09-14 |
```

- [ ] **Step 2: Explain the spread under the table**

Add a short paragraph after the table stating: how many runs the spread comes from, that `temperature: 0` does not make a local model bit-reproducible, that the number measures a model *and* a six-example prompt together and this chunk cannot separate them, and that per-class figures rest on ten rows each so differences under about 20pp are not readable. Take the wording from the spec's "What this chunk cannot tell you" rather than inventing new claims.

- [ ] **Step 3: Update the running instructions**

In the commands block, beside `npm run eval`, add:

```bash
npm run smoke:classify    # check the agent model can hold the three-label enum
npm run eval:classify     # score classification accuracy, 3 runs, no database needed
```

- [ ] **Step 4: Verify the claim against the artifact**

Re-read the committed artifact and confirm every number written into the README appears in it. A README figure that cannot be traced to an artifact is the thing this project exists to avoid.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: record the v1 row with its run-to-run spread"
```

---

## Self-Review

**Spec coverage.** Label set from `GOLDEN_TYPES` — Task 4. `AGENT_MODEL` constant pinned by smoke test plus spec amendment — Task 1. Six examples two per class — Task 3. Both leakage assertions with the `0.5` tripwire — Task 3. Accuracy overall and per class, pure, throwing on a bad denominator and a missing prediction — Task 5. Three runs with min/median/max and one prompt hash — Tasks 5 and 6. Artifact fields and the sibling directory — Task 6. Ollama unreachable and one-retry-then-abort — Tasks 2 and 4. No `process.exit` in a library module, including the `provider.ts` carry-over — Task 2. Tests without Ollama through an injectable model — Tasks 3, 4, 5. README `v1` row with the spread — Task 7.

**Placeholders.** The only value not literal in this document is `AGENT_MODEL`, which Task 1 decides by a defined procedure and records in the spec before Task 4 hard-codes it; Task 4 Step 3 says so explicitly. The README numbers in Task 7 are marked as an example shape with the real numbers substituted from the artifact.

**Type consistency.** `GoldenType` and `GOLDEN_TYPES` are imported everywhere and declared nowhere. `Classifier.classify` returns `Promise<GoldenType>`, which is what `scoreAccuracy`'s `Map<string, GoldenType>` consumes. `summarize` takes `AccuracyReport[]`, which is what the run loop collects. `fail` moves to `src/cli.ts` in Task 2 and is imported from there by Task 6, while `db/client.ts` re-exports it so chunk 2b's call sites do not churn.
