# Golden Set — Design

**Date:** 2026-09-10
**Status:** Approved, not yet implemented
**Scope:** Vendor the retrieval corpus, define the section identity rule, author 30 golden
questions, and ship a validator that proves every golden row points at a section that exists.

## Why this comes first

The golden set is the lab's measuring stick. Both numbers in the README — classification accuracy
and recall@5 — are defined entirely by this file. If the golden set is authored badly, every later
tuning decision is made against a broken instrument, and the scores in the results table mean
nothing.

The golden set also cannot be written in isolation: each in-scope row names the documentation
section that answers its question. Those section identifiers must be real. So the corpus is
vendored first, section identity is defined mechanically, and only then are questions authored.

## Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Corpus source | Vendored into the repo, pinned | A fresh checkout reproduces the exact recall@5 |
| Section identity | `relpath#slug`, public URL as separate metadata | Mechanically derivable from files; verifiable by grep |
| Label mix | 10 `how_to` / 10 `concept` / 10 `out_of_scope` | Per-class accuracy equally readable across all three |
| Correct answer | `sections` list, hit if any member is in the top 5 | Docs sometimes split one answer across headings |
| Authoring method | Hand-authored in user voice | Reverse-generating questions from section text inflates recall@5 via lexical overlap |

## Layout

```
corpus/                      # vendored FastAPI markdown, pinned
corpus/SOURCE.md             # upstream tag + commit SHA + subpaths + license note
evals/golden.jsonl           # 30 rows, one JSON object per line
src/corpus/sections.ts       # enumerateSections() — the single slug rule
scripts/validate-golden.ts   # structural + referential validation
```

`src/corpus/sections.ts` is deliberately shared. The validator consumes it now; the ingest pipeline
will consume it later. One slug rule with two consumers means a section id in `golden.jsonl` can
never come to mean something different from a section id emitted by retrieval.

## Corpus vendoring

Sparse-checkout `fastapi/fastapi` at a pinned release tag and copy these subpaths from
`docs/en/docs/` into `corpus/`, preserving relative structure:

- `tutorial/`
- `advanced/`
- `how-to/`
- `deployment/`

The implementation resolves the latest stable tag at vendoring time and records both the tag and the
full commit SHA in `corpus/SOURCE.md`, alongside the copied subpaths and the upstream MIT license
attribution. The markdown is committed to git.

Nothing else from the upstream repository enters this one — no source tree, no submodule, no
build config.

## Section identity

A section is a markdown heading plus the prose beneath it, up to the next heading of the same or
higher level. Its identifier is:

```
<path relative to corpus/>#<slug of the heading text>
```

Example: `tutorial/query-params.md#optional-parameters`

The slug rule must match python-markdown's `toc` extension, because that is what generates the
anchors on the public documentation site — and the public URL is what an answer cites. The rule:

1. Strip inline markdown from the heading text (backticks, emphasis, links keep their label).
2. Lowercase.
3. Replace whitespace runs with a single hyphen.
4. Drop every character that is not alphanumeric, hyphen, or underscore.
5. On a collision within one file, append `_1`, `_2`, … in document order.

`enumerateSections()` returns, for each section: `{ id, path, slug, title, level, url }`.

The public URL is derived from the path by dropping the `.md` extension, collapsing `index.md` to
its directory, and appending a trailing slash, then the anchor:

```
tutorial/query-params.md#optional-parameters
  → https://fastapi.tiangolo.com/tutorial/query-params/#optional-parameters
```

## Golden row schema

One JSON object per line in `evals/golden.jsonl`:

```jsonc
{
  "id": "q001",
  "question": "How do I make a query parameter optional?",
  "type": "how_to",
  "sections": ["tutorial/query-params.md#optional-parameters"],
  "url": "https://fastapi.tiangolo.com/tutorial/query-params/#optional-parameters",
  "note": "chosen over query-params-str-validations, which covers validation rather than optionality"
}
```

Fields:

- `id` — matches `q\d{3}`, assigned in order from `q001`, stable across edits. Never renumbered; a
  retired question's id retires with it and is not reused, so ids may exceed `q030` over time even
  though the file always holds 30 rows.
- `question` — the question as a user would ask it.
- `type` — exactly one of `how_to`, `concept`, `out_of_scope`.
- `sections` — array of section ids. Non-empty for in-scope rows, empty for `out_of_scope`.
- `url` — the public URL of `sections[0]`, for human review. Absent on `out_of_scope` rows.
- `note` — why this section and not a near neighbour. Required on every in-scope row; for
  `out_of_scope` rows it records which of the three sub-kinds the row is.

## Authoring rules

These rules exist to keep the two numbers honest. They are enforced by review, and where mechanical,
by the validator.

1. **Phrase before grounding.** The question is written first, in the vocabulary a newcomer has
   *before* reading the documentation. Only then is the answering section located and recorded.
2. **No heading text in a question.** A question may not quote or lightly paraphrase the wording of
   its own section's heading or first sentence.
3. **Never pad `sections`.** A second entry is added only where the documentation genuinely splits
   one answer across headings — never to make a score look better. The `note` field justifies the
   choice.
4. **`how_to` vs `concept`.** `how_to` asks for steps or syntax to accomplish a task. `concept` asks
   what something is, why it exists, or how it behaves. When a question reads as both, it is
   rewritten until it reads as one.

## `out_of_scope` composition

Ten rows, deliberately mixed rather than ten obvious misses:

- **4 adjacent-but-absent** — Django, Flask, SQLAlchemy, or Pydantic-internals questions that read
  like FastAPI questions.
- **3 off-domain** — unrelated programming or general-knowledge questions.
- **3 in-domain but outside the vendored slice** — questions whose answers live in upstream areas we
  did not vendor, such as the API reference or release notes.

The third group is the discriminating one: a naive classifier that keys on the word "FastAPI"
answers them anyway.

## Validation

`npm run validate:golden` exits non-zero on any of:

- a `sections` entry that `enumerateSections()` does not produce
- a `type` outside the three allowed values
- a duplicate `id`, or an `id` not matching `q\d{3}`
- two `question` values that collide after normalization (lowercase, punctuation stripped,
  whitespace collapsed)
- a non-empty `sections` on an `out_of_scope` row, or an empty `sections` on an in-scope row
- a `url` that does not match the derived URL of `sections[0]`, or a `url` present on an
  `out_of_scope` row
- a missing `note`
- a label count other than 10 / 10 / 10
- malformed JSON on any line

## Testing

- Unit tests on `enumerateSections()` covering the slug rule: punctuation in headings, inline code
  ticks, emphasis, links, duplicate headings within one file, and nested heading levels.
- Unit tests on URL derivation, including `index.md` collapsing.
- The validator runs as part of the test suite, so a golden row can never reference a section that
  the corpus does not contain.

## Metric semantics

- **Classification accuracy** — over all 30 rows: fraction where the predicted `type` equals the
  expected `type`.
- **recall@5** — over the 20 in-scope rows only: fraction where at least one member of `sections`
  appears in the top 5 retrieved sections. `out_of_scope` rows are excluded, because there is no
  correct section to retrieve.

Both numbers are also reported per class, so a regression in one label is visible rather than
averaged away.

## Not in this chunk

No ingest pipeline, no embeddings, no pgvector schema, no graph nodes, no eval runner. This chunk
lands the corpus, the section identity rule, the 30 questions, and a validator that proves the
questions point at real sections. The eval runner that consumes `golden.jsonl` is the next chunk.
