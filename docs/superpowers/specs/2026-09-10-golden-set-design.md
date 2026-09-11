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
| Section identity | `relpath#anchor`, anchor read from the file's own `{ #… }`, public URL as separate metadata | No slugify rule to keep in sync with upstream; verifiable by grep |
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

Pinned at tag `0.141.1`, commit `95f8322ee1dcda7ceace7b1c4f6c9915b36d748f` (resolved
2026-09-10 via `git ls-remote`). `corpus/SOURCE.md` records the tag, the full SHA, the copied
subpaths, and the upstream MIT license attribution. The markdown is committed to git.

One content caveat, recorded here but out of scope for this chunk: these files use MkDocs-Material
include directives (`{* ../../docs_src/… *}`) in place of inline code samples, so a section's body
text references code it does not contain. That affects the ingest pipeline's chunk content, not
section *identity*, which is all this chunk needs.

Nothing else from the upstream repository enters this one — no source tree, no submodule, no
build config.

## Section identity

A section is a markdown heading plus the prose beneath it, up to **the next heading of any level**.
Its identifier is:

```
<path relative to corpus/>#<slug of the heading text>
```

Example: `tutorial/query-params.md#optional-parameters`

#### Sections never nest

"To the next heading of any level" — rather than the next heading of the same or higher level — is
deliberate, and it is what keeps sections a flat partition of each file: every line of prose belongs
to exactly one section, and no section contains another.

The alternative rule reads more naturally but breaks the metric. Every one of the 106 vendored files
has exactly one H1, so under a same-or-higher-level rule a level-1 section would span its entire
file. Two consequences follow, both fatal to recall@5:

- Sections would overlap at different granularities. `tutorial/body.md#request-body` (the H1) would
  *contain* `tutorial/body.md#results`, so q003's correct answer would swallow q018's — one row's
  gold section becoming another row's distractor, with no way for retrieval to be right about both.
- A retrieved "section" could be a whole page, which is not a unit anyone can cite.

Under the flat rule an **H1 section is the page's introductory prose only** — the text between the
title and the first `##`. That is intended, not an accident of parsing. Eight of the twenty in-scope
golden rows (q002, q003, q004, q005, q006, q008, q011, q020) target exactly such an introductory
section, because on those pages the introduction is where the answer is actually stated: it carries
the mechanism and the motivation, while the `##` sections beneath it walk through construction steps
that presuppose the answer. Those rows are correctly aimed and must not be re-pointed at
subheadings.

This is a decision recorded for the ingest pipeline, which will be the first consumer to need a
section's *body*. It requires no change to `enumerateSections()`, which computes identity only and
never extent.

### Anchors are declared, not derived

The FastAPI documentation declares its anchors inline, using the `attr_list` custom-id syntax:

```markdown
## Optional parameters { #optional-parameters }
```

Every real heading in the vendored slice carries one (verified: 37/37 in `deployment/docker.md`,
27/27 in `tutorial/first-steps.md`). So the slug is **read, not computed** — the anchor in the file
is the same anchor the public site serves, with no slugify rule to keep in sync.

A slugify fallback exists only for a heading that declares no anchor: strip inline markdown,
lowercase, whitespace runs to a single hyphen, drop everything that is not alphanumeric / hyphen /
underscore, and on a within-file collision append `_1`, `_2`, … in document order. The validator
reports every heading that falls back, because upstream adding an un-anchored heading is a signal
worth seeing rather than silently absorbing.

### Fenced code blocks are not headings

`deployment/docker.md` contains Dockerfile and shell listings whose comments begin with `#`. A naive
`^#{1,6} ` match finds 50 headings in that file; only 37 are real. The parser tracks fence state —
opened by three or more backticks or tildes, closed by a fence of at least the same length and the
same character — and ignores every line inside. Getting this wrong puts section ids in the golden
set that no retrieval can ever return.

### Return shape

`enumerateSections()` returns, for each section: `{ id, path, slug, title, level, url, anchorSource }`,
where `anchorSource` is `"declared"` or `"slugified"`.

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
5. **Adjudicate against the whole file, and against prose only.** Added 2026-09-11, after the first
   measurement (see *Amendment* below). Locating a section that answers the question is not enough.
   Two further checks, both on every in-scope row:
   - **Uniqueness.** List *every* section of the file the chosen one lives in and ask of each: does
     this one also answer the question? "Also answers" means answers the question **whole** — a
     section that supplies one instance of the answer is not a rival. (`path-params#data-validation`
     gives one of the four things type hints buy you; it does not answer "why does FastAPI care
     about type hints at all", which `#recap` does.) Without that qualifier almost every row has a
     rival and the rule is unusable. If more than one section answers the whole question, the defect
     is in the **question**, not in the choice — rewrite it until exactly one section answers, or
     drop the ambiguous clause. A question with two defensible answers cannot be scored: whichever
     section is recorded, a correct retrieval of the other counts as a miss. Where the documentation
     genuinely splits one answer across two headings and no rewrite separates them, rule 3 applies
     instead: record both, and justify the second in the `note`.
   - **Prose, not includes.** The answer must be stated in the section's own prose. The vendored
     pages pull their code in through MkDocs include directives (`{* ../../docs_src/… *}`) and
     `docs_src/` is not vendored, so an answer that lives only in the included code is not present
     in the text that gets embedded. A section whose relevant content is a code include answers the
     question for a human reader of the website and not at all for this corpus.
6. **Comparison questions are checked across files.** Rule 5 scopes its uniqueness check to one
   file, which is enough for a question about one thing and blind to a question about the
   relationship between two. A question of the form "the difference between A and B", "what does A
   do that B does not", or "A compared with B" has, by construction, a defensible answer wherever
   *either* side is documented. For those, run the uniqueness check over the file of each side. If
   both sides are documented in their own file and neither subsumes the other, record both sections
   under rule 3 rather than picking one and scoring a correct retrieval of the other as a miss.

## Amendment — 2026-09-11

Rule 5 was added after chunk 2b produced the first `recall@5`. Triaging its eight misses showed that
rules 1-4 admit three distinct defects, all three present in the committed set:

| Row | Defect | Evidence |
| --- | --- | --- |
| `q009` | Gold section states the answer only in a code include | Its entire prose on the topic is *"you could use this to create a database session and close it after finishing"*; the mechanism is in three `{* … *}` directives |
| `q014` | Question has two clauses answered by two different sections | *"…and why not just call the function myself?"* is answered by `dependencies/index#simple-usage`, not by the recorded gold |
| `q015` | Question ambiguous; two sections defensibly answer it | *"where does it come from"* admits both the renderer (`#interactive-api-docs`, "provided by Swagger UI") and the content's origin (`#what-is-openapi-for`, "the OpenAPI schema is what powers…") |

None of these is a retrieval failure, and no validator rule can detect any of them — each requires
reading the sibling sections of the file. The rule costs roughly two minutes per row at authoring
time and would have caught all three.

The measurement that exposed them, `recall@5 = 0.60 (12/20)`, was therefore taken against an
instrument with three known defects. It stays in the results table, labelled as such: a baseline
that is discarded rather than recorded is a baseline that can be quietly re-chosen later.

### Re-audit of all twenty in-scope rows

Rules 5 and 6 were then applied to every in-scope row, not only the eight that missed — roughly
eighty-five sibling sections read. Fourteen rows passed. Four more rows were found defective, none
of them by the retrieval score:

| Row | Rival section | Why no rewrite separates them |
| --- | --- | --- |
| `q005` | `request-files#define-file-parameters` | The H1 names the mechanism (`File`); the sibling carries the substance (`bytes` versus `UploadFile`, and what each costs). Both answer "how do I accept an uploaded file". |
| `q006` | `request-forms#define-form-parameters` | Same split: the H1 names `Form`, the sibling gives the configuration and the OAuth2 case. |
| `q007` | `response-cookies#return-a-response-directly` | Two genuine mechanisms for one task — a `Response` parameter, or building the response yourself. |
| `q011` | `path-params#path-parameters` (another file) | Found by rule 6, not rule 5. "The difference between a path parameter and a query parameter" is answered wherever either side is defined. |

All four take a second section under rule 3 rather than a rewritten question. The four rows already
scored as hits before the change (ranks 1, 3, 1 and 2), and `hit` is `goldRank <= k` over
`Math.min(...ranks)`, so **adding a section cannot move them**. Their score staying put is the check
that the change added targets without buying points.

Three findings about the method itself, recorded because they cost more than the rows did:

- **A mechanical screen does not substitute for reading.** Stripping include directives and
  measuring the prose that remains flags nothing on `q009` — 535 characters is mid-range for this
  corpus. Its defect is not thin prose but prose that omits the mechanism. Only reading finds that.
- **Rule 5 caught a rewrite made under rule 5.** The first replacement drafted for `q015` —
  "what does FastAPI generate that both of its built-in docs pages read from?" — is itself two
  clauses, and `first-steps#openapi` answers the first. The rule applies to corrections, not only to
  original authorship.
- **The rule costs about two minutes per row and found four defects in rows that were scoring
  correctly.** Score-driven triage would have found none of them: all four were hits.

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
- a section whose anchor was slugified rather than declared (reported, non-fatal)
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

- Unit tests on `enumerateSections()`, against hand-written fixture files rather than the real
  corpus, covering: a declared `{ #anchor }`; `#`-prefixed comments inside ``` and ~~~ fences
  (must not become sections); a longer fence closing over a shorter one; nested heading levels;
  and the slugify fallback's punctuation, inline code ticks, emphasis, links, and within-file
  collision suffixes.
- One test against the real corpus asserting that a known section id
  (`tutorial/query-params.md#optional-parameters`) is produced, so fixtures cannot drift from
  reality unnoticed.
- Unit tests on URL derivation, including `index.md` collapsing.
- The validator runs as part of the test suite, so a golden row can never reference a section that
  the corpus does not contain.

## Metric semantics

- **Classification accuracy** — over all 30 rows: fraction where the predicted `type` equals the
  expected `type`.
- **recall@5** — over the 20 in-scope rows only: fraction where at least one member of `sections`
  appears in the top 5 retrieved sections. `out_of_scope` rows are excluded, because there is no
  correct section to retrieve.

**Classification accuracy** is also reported per class, so a regression in one label is visible
rather than averaged away. All three classes hold 10 rows, which makes the three numbers directly
comparable, but 10 rows is coarse: one row is 10pp.

**recall@5 is reported as a single number only.** An earlier draft of this spec promised it per
class as well; that is withdrawn. Per class it would rest on 10 rows (SE ≈ 15pp), which cannot
resolve less than roughly a 30pp swing — so a per-class recall@5 would mostly publish noise in a
shape that invites reading it as a per-label regression.

### Resolution and coverage

Two limits of the instrument, recorded here and stated in the README so neither is discovered by
someone tuning against a rounding error.

- **Resolution.** recall@5 has n=20, so one row is 5pp and the standard error is around 10pp;
  classification accuracy has n=30 and moves 3.3pp per row. Differences below about 15pp are noise.
  No tuning decision may be justified by a smaller movement than that.
- **Coverage.** The 20 in-scope gold sections are distributed `tutorial` 17, `advanced` 2,
  `deployment` 1, `how-to` 0, against a corpus in which `advanced/` holds 252 of 944 sections and
  `how-to/` 78. About 35% of the corpus is therefore distractor-only, and a retrieval regression
  confined to those subtrees would be invisible in recall@5. Widening coverage means authoring
  rows that land in `advanced/` and `how-to/` — a change to the golden set, not to the runner, and
  one that must respect the 10/10/10 mix.

## Not in this chunk

No ingest pipeline, no embeddings, no pgvector schema, no graph nodes, no eval runner. This chunk
lands the corpus, the section identity rule, the 30 questions, and a validator that proves the
questions point at real sections. The eval runner that consumes `golden.jsonl` is the next chunk.
