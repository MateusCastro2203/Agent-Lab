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

`npm run validate:golden` proves every row points at a section that exists. `npm run eval` will run
the questions and print both numbers — that arrives with the next chunk.

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
docker compose up -d      # Postgres (not used until the ingest chunk)
npm install
npm run corpus:fetch      # re-vendor the pinned FastAPI docs (already committed)
npm run sections          # list every section id
npm run validate:golden   # check the golden set against the corpus
npm test
```

None of the commands above touch it yet, but configuration for the ingest/ask/eval chunk already
lives in `.env`: `DATABASE_URL`, `AGENT_MODEL`, `JUDGE_MODEL`, `OPENROUTER_API_KEY`.

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
