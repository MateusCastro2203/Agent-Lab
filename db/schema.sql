-- Agent-Lab schema. Idempotent: safe to re-run without dropping the volume.
-- Applied by `npm run db:setup`.
--
-- IMPORTANT — how schema changes work here.
--
-- Every statement below is `IF NOT EXISTS`, which makes re-running harmless but
-- also means an edit to this file is SILENTLY IGNORED once the objects exist:
-- adding a column here and re-running `db:setup` changes nothing, and `db:check`
-- would still report OK. That was verified, not assumed.
--
-- So `db:setup` records a fingerprint of this file in `schema_meta`, and
-- `db:check` fails loudly when the file no longer matches what was applied. The
-- fix is `npm run db:reset --force`, which drops these tables and reapplies —
-- destroying stored embeddings, which then cost a re-ingest to rebuild.
--
-- The fingerprint ignores comments and whitespace, so editing this prose does
-- not raise a false alarm.

CREATE EXTENSION IF NOT EXISTS vector;

-- One row, holding the fingerprint of the schema that was last applied.
CREATE TABLE IF NOT EXISTS schema_meta (
  id         int PRIMARY KEY CHECK (id = 1),
  hash       text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- One row per corpus section. `id` is the section id that `enumerateSections()`
-- produces and that a golden row's `sections` entry names, so a retrieval
-- result can be compared against the golden set without translation.
CREATE TABLE IF NOT EXISTS chunks (
  id           text PRIMARY KEY,      -- "<path relative to corpus/>#<anchor>"
  path         text NOT NULL,
  slug         text NOT NULL,
  heading_path text[] NOT NULL,       -- ancestors, then the section's own heading
  text         text NOT NULL,         -- the text that was embedded
  hash         text NOT NULL,         -- sha256 of `text`; lets ingest skip unchanged rows
  embedding    vector(768),           -- null until embedded
  model        text,                  -- which model produced `embedding`
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Deliberately NO vector index.
--
-- pgvector's HNSW and IVFFlat are APPROXIMATE nearest-neighbour indexes: they
-- trade exactness for speed. At 944 rows there is no speed to win — a
-- sequential scan over 944 vectors of 768 dimensions is sub-millisecond — while
-- the exactness being traded away is precisely what recall@5 measures. An
-- approximate index here could lower the score for no benefit.
--
-- Revisit when the corpus is large enough for a scan to actually cost
-- something, and re-measure recall@5 before and after if an index is added.
