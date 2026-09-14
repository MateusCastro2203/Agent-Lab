# Classification Accuracy — Design

**Date:** 2026-09-14
**Status:** Approved, not yet implemented
**Scope:** A `classify` function, a few-shot prompt with a mechanical anti-leakage guard, pure
accuracy scoring, and `npm run eval:classify` — producing the second of the lab's two numbers.

## Why this comes now

The README promises two numbers. Chunk 2b produced the first, `recall@5`, and chunk 2c repaired the
ruler it was measured against. Classification accuracy is the other half, and it is the first thing
in this project that needs a **generating** model: every chunk so far has been embeddings and
arithmetic.

That makes this chunk the one where a new failure mode arrives. Up to now a wrong number could only
come from the corpus, the golden set, or the code. From here it can also come from a prompt — and a
prompt is the easiest place in the whole project to manufacture a good score by accident.

## Where this sits

| chunk | delivers | number it produces |
| --- | --- | --- |
| 2b (done) | ingest, retrieve, `npm run eval` | `recall@5` = 0.60 |
| 2c (done) | golden set audited under authoring rules 5 and 6 | `recall@5` = 0.65 |
| **3 (this one)** | `classify`, few-shot prompt, `npm run eval:classify` | **classification accuracy → the `v1` row** |
| 4 | LangGraph graph, `answer` node with citations and abstention, run state persisted | none — unmeasured |
| later | tool calling, scored by exact match instead of adjudication | a third ruler |

## Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Graph | **No LangGraph.** `classify` is a pure function | The number does not depend on a graph. Chunk 4 has two nodes and run-state persistence — that is when typed state and checkpointing carry weight. Same discipline as shipping no ANN index |
| Model | Local, 8B class, through Ollama, pinned as a constant | Free, offline, reproducible, no API key. The README already reserves OpenRouter for "when a stronger model is needed" |
| Prompt | Few-shot, six examples, **authored fresh** | Chosen over zero-shot for label adherence. The cost is accepted explicitly: the first measurement mixes model capability with prompt quality |
| Leakage | Mechanical test, not discipline | Chunk 2c found seven defective golden rows written under rules the author had written himself |
| Ruler | **Separate** script and artifact directory | `recall@5` refuses to run without 944 embedded rows; `classify` never touches the database. Coupling them blocks one measurement on the other's preconditions |
| Repetitions | **Three runs**, reporting min / median / max | Measures the instrument's own noise, which no other part of this project has measured |

## The label set has one source

`GoldenType` and `GOLDEN_TYPES` already exist in `src/evals/golden.ts` and are what the golden set is
validated against. The classifier imports them; the structured-output schema is

```ts
z.object({ label: z.enum(GOLDEN_TYPES) })
```

The classifier does **not** declare its own list of labels. If it did, the two could drift, and the
eval would report a classification error where the defect is a constant.

## Model pin

`AGENT_MODEL` is a constant in `src/agent/classifier.ts`, exactly as `EMBEDDING_MODEL` is a constant
in `src/embed/provider.ts`. It is never read from the environment: the model is part of what a
recorded number means, and a number whose model came from an unset variable cannot be compared to
anything.

Its value is decided by a smoke test, not by assumption. The requirement is unambiguous:

- Candidates are tried in this fixed order: `qwen3:8b`, then `llama3.1:8b`.
- A candidate passes only if it returns a schema-valid `{ label }` for one question of each of the
  three classes, at `temperature: 0`, through `generateObject`.
- The first candidate to pass is pinned, and **this spec is amended to record which**, with the
  smoke-test output, before any measurement runs.
- If neither passes, no measurement runs and the chunk stops for a decision. A model that cannot
  hold a three-value enum is not a model this instrument can report on.

No embedding model changes. `nomic-embed-text` stays exactly as it is, and nothing in this chunk
re-ingests or re-scores `recall@5`.

## Prompt and few-shot

`src/agent/prompt.ts` exports the system prompt and `FEW_SHOT`, a readonly array of
`{ question, label }`.

**Six examples, two per class.** Balanced deliberately: an unbalanced example set shifts the model's
prior, and then per-class accuracy measures the prompt's shape rather than the model. Two per class
rather than one because `out_of_scope` has internal structure the golden set is built on — adjacent
but absent, off domain, and in domain but outside the vendored slice — and one example cannot carry
all three.

The examples are written for this purpose and appear nowhere in `evals/golden.jsonl`.

## The anti-leakage guard

`src/agent/prompt.test.ts` proves the examples are not drawn from the ruler. Two assertions, both
fatal, each example against all thirty golden rows:

1. **Equality.** `normalizeQuestion(example)` must differ from `normalizeQuestion(row)`. This reuses
   the function the validator already uses for its `duplicate-question` rule.
2. **Overlap.** Jaccard similarity must be below `0.5`. Both sides are passed through
   `normalizeQuestion`, split on whitespace into a `Set` of tokens, and scored as
   `|A ∩ B| / |A ∪ B|`. The test prints the closest pair it found, so a failure says which example
   to rewrite.

The second exists because the first is weak. "How do I make a query parameter optional?" and "How do
I make a query param optional?" are the same question and differ under exact comparison. `0.5` is a
tripwire, not a metric: it is a judgement call, and moving it is a spec change rather than a tuning
knob.

## What is measured

- **Classification accuracy** over all thirty rows: the share whose predicted label equals `type`.
- **Per class**, across three classes of ten rows each. Equal support is what makes the three
  comparable.

`scoreAccuracy` is pure — golden rows and predictions in, a report out, no model and no I/O — the
same shape as `scoreRecall`. It throws rather than guesses in two cases: a denominator that is not
thirty, and a row with no prediction. A scoring function that silently tolerates a missing
prediction reports a number that is quietly measuring twenty-nine rows.

### Three runs

The eval runs the full thirty questions three times and reports `min`, `median` and `max` for the
overall figure and for each class. All three runs must share one prompt hash; the script asserts it.

The reason is that `temperature: 0` does **not** make a local model bit-reproducible. Without the
spread, the first difference between two future measurements is unattributable — a better prompt and
the model breathing look identical. The README already states the sampling noise floor: one row is
3.3pp overall and 10pp within a class. Three runs measure the other source of noise, and if the
spread turns out to exceed the sampling resolution, that is the most important thing this chunk
finds.

The `v1` README row records the **median**, with the min–max spread beside it.

## Artifact

Written to `evals/results-classify/<iso>.json` — a sibling of `evals/results/`, not a file inside it,
so the two rulers cannot collide.

It records the model, the temperature, the few-shot count, the **prompt hash**, all three runs with
their per-row predictions, and the summary. The prompt hash is the SHA-256 of the system prompt
concatenated with `FEW_SHOT` serialized as compact JSON in array order — so reordering the examples
changes it, because reordering them can change the result. It is the same device as chunk 2a's
schema fingerprint: without it an edited prompt produces a new number and leaves no trace that
anything changed.

## Error handling

- **Ollama unreachable** — fail naming the URL, the same treatment `provider.ts` already gives
  embeddings.
- **Invalid format** — one retry, then **abort the whole run**, naming the question id and the raw
  output.

Aborting is deliberate. Counting a format failure as a wrong answer folds "the model cannot
classify" and "the model cannot emit JSON" into one number. If the model cannot hold the format,
that is a model-selection problem to surface, not a datapoint to average away. The smoke test that
pins `AGENT_MODEL` exists to catch it before a measurement ever runs.

**No `process.exit` in a library module.** `classifier.ts` throws; the script decides whether to
kill the process. The same correction is applied to `src/embed/provider.ts`, which still calls
`process.exit(1)` inside a module — carried from chunk 2b, where it was ruled acceptable for scripts
and flagged as blocking for this chunk. Leaving it would mean two providers with opposite error
contracts.

## Testing

Every unit test runs without Ollama, through `classifierWith(stub)` — an injectable model, present
from the start rather than retrofitted. Chunk 2b's final review found the embedding prefixes could
be swapped with a green suite, and this is the shape that fixed it.

- `accuracy.test.ts` — a denominator that is not thirty throws; a missing prediction throws; per
  class counts; perfect, zero, and mixed cases.
- `prompt.test.ts` — both leakage assertions, and that `FEW_SHOT` is balanced two per class.
- `classifier.test.ts` — the question reaches the model; a valid label round-trips; a response
  outside the enum is rejected.

The smoke test against a real Ollama is a **script**, not a unit test — the same reasoning that left
`provider.ts` without one in chunk 2b.

## Not in this chunk

No LangGraph, no `answer` node, no citations, no abstention behaviour, no run-state persistence, no
`npm run ask`, no tool calling, no second model compared, no change to `recall@5` or to the corpus,
the golden set, or the database schema.

## What this chunk cannot tell you

- **Resolution.** Thirty rows overall means one row is 3.3pp; ten rows per class means one row is
  10pp. Per-class differences smaller than about 20pp are not readable at this support.
- **Prompt versus model.** Few-shot was chosen with this cost accepted: the number measures a model
  *and* a prompt together, and this chunk cannot separate them. Only a later comparison — the same
  prompt against a second model, or two prompts against one — can.
- **Stability beyond three runs.** Three runs estimate the spread; they do not bound it.
- **Whether the labels are the right labels.** Accuracy measures agreement with the golden set's
  `type` field. That the three-way split is the right way to route a question is an assumption this
  instrument inherits and cannot test.
