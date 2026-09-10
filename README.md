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

- **Classification accuracy** — did it get the question type right?
- **recall@5** — did the correct section appear in the top 5 retrieved?

The golden set is ~30 questions in `evals/golden.jsonl`, each with its expected type and the section
that answers it. `npm run eval` runs them all and prints both numbers.

### Results

| Version | Classification accuracy | recall@5 | Model | Date |
| ------- | ----------------------- | -------- | ----- | ---- |
| v1      | –                       | –        | –     | –    |

## Stack

TypeScript, LangGraph, Postgres + pgvector (Docker), AI SDK. Ollama for the agent (local, no cost),
OpenRouter when a stronger model is needed.

## Running it

```bash
docker compose up -d     # Postgres
npm run ingest           # index the docs
npm run ask "..."        # ask a question
npm run eval             # run the golden set
```

Configuration lives in `.env`: `DATABASE_URL`, `AGENT_MODEL`, `JUDGE_MODEL`, `OPENROUTER_API_KEY`.

## Roadmap

Each item lands only once the previous one runs and is measured:

- [ ] v1: three nodes + two numbers
- [ ] critic node (reviews the answer before it ships)
- [ ] `interrupt()` for ambiguous questions
- [ ] second embedding model, compared
- [ ] promptfoo in CI

## License

MIT. The FastAPI documentation is © Sebastián Ramírez, MIT licensed, and is used here as a
retrieval corpus only.
