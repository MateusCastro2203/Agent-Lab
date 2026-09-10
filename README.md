# Agent-Lab

A local workbench for learning to **design and measure** an LLM agent.

The agent is deliberately small: it answers questions about the FastAPI documentation. What matters
is everything around it — a graph with typed state and checkpointing, a RAG pipeline, and a set of
questions with known answers that gives the agent a score. Not a product; a lab.

## What the agent does

Takes a question and runs three nodes:

1. **classify** — is the question `how_to`, `concept`, or `out_of_scope`?
2. **retrieve** — if in scope, pull the most relevant documentation sections
3. **answer** — answer with citations; if out of scope, abstain

Every run's state is persisted in Postgres, so you can inspect what the agent decided, step by step.

## The corpus

Markdown from the official FastAPI docs (tutorial, advanced, how-to, deployment). Every heading
carries its own anchor, so the **section** is the unit of retrieval — that's what the golden set
points at.

## What gets measured

Two numbers, defined before tuning any prompt:

The golden set is 30 questions in `evals/golden.jsonl` — 10 `how_to`, 10 `concept`, 10
`out_of_scope` — each with its expected type and, when in scope, the documentation section that
answers it. Sections are identified as `<path>#<anchor>`, where the anchor is the one the FastAPI
docs already declare in the heading.

- **Classification accuracy** is measured over all 30 rows.
- **recall@5** is measured over the 20 in-scope rows only; an `out_of_scope` row has no correct
  section to retrieve.

Classification accuracy is also reported per class — all three classes have 10 rows, which makes
the three directly comparable, though 10 rows is a coarse basis: one row is 10pp. recall@5 is
**not** broken out per class: at n=10 the number cannot
resolve anything smaller than a very large change, so reporting it per class would invite reading
noise as a per-label regression.

`npm run validate:golden` proves every row points at a section that exists. `npm run eval` will run
the questions and print both numbers — that arrives with the next chunk.

### What the numbers cannot tell you

Two limits of this instrument, stated up front so nobody over-reads a score.

**The metric's resolution is coarse — treat anything under ~15pp as noise.** recall@5 has 20 rows,
so a single row flipping moves it 5 percentage points, and its standard error is roughly 10pp.
Classification accuracy has 30 rows and moves 3.3pp per row. A prompt change that "improves"
recall@5 by 4pp has told you nothing; only differences of about 15pp or more are signal at this
sample size. Reporting a number to one decimal place does not make it precise.

**Coverage is skewed to `tutorial/`, so a third of the corpus is only ever a distractor.** The 20
in-scope gold sections fall out by directory as `tutorial` 17, `advanced` 2, `deployment` 1, and
`how-to` **0** — while `advanced/` is 252 of the 944 sections and `how-to/` is 78. Roughly 35% of
the corpus therefore has no gold row pointing into it and serves only to be *not* retrieved. A
retrieval regression confined to those two subtrees would leave recall@5 completely unchanged, so
the score is evidence about `tutorial/` far more than about the corpus as a whole.

### Known limits of the corpus

Only `tutorial/`, `advanced/`, `how-to/` and `deployment/` were vendored, so a few FastAPI topics
have no home in the corpus. The clearest case is `async.md`, which owns the "what does `async def`
change?" question upstream and lives at the docs root: it is absent here, and two vendored pages
carry dead links to it. Question `q013` is answered instead from a file-streaming section that
happens to state the mechanism in prose. Expect it to be one of the harder rows, and read a failure
there as a corpus boundary rather than a retriever regression.

The vendored pages also pull their code samples in through MkDocs include directives
(`{* ../../docs_src/… *}`) instead of inlining them, and `docs_src/` was not vendored. Retrieval
therefore matches prose, not code — which is worth remembering when a section that "obviously"
contains the answer scores badly.

### Results

| Version | Classification accuracy | recall@5 | Model | Date |
| ------- | ----------------------- | -------- | ----- | ---- |
| v1      | –                       | –        | –     | –    |

## Stack

TypeScript, LangGraph, Postgres + pgvector (Docker), AI SDK. Ollama for the agent (local, no cost),
OpenRouter when a stronger model is needed.

## Running it

```bash
npm install
npm run corpus:fetch      # re-vendor the pinned FastAPI docs (already committed)
npm run sections          # list every section id
npm run validate:golden   # check the golden set against the corpus
npm test
```

Nothing above needs configuration, and nothing above needs Postgres — the database arrives with the
ingest chunk, along with the `docker compose` file to run it. There is no `.env` in a fresh checkout
either: it is gitignored and no example is committed yet. The ingest/ask/eval chunk will introduce
one and document it there; the variables it expects are `DATABASE_URL`, `AGENT_MODEL`,
`JUDGE_MODEL`, and `OPENROUTER_API_KEY`.

## Roadmap

Each item lands only once the previous one runs and is measured:

- [x] corpus vendored, section identity, golden set + validator
- [ ] v1: three nodes + two numbers
- [ ] critic node (reviews the answer before it ships)
- [ ] `interrupt()` for ambiguous questions
- [ ] second embedding model, compared
- [ ] promptfoo in CI

## License

MIT. The FastAPI documentation is © Sebastián Ramírez, MIT licensed, and is used here as a
retrieval corpus only.
