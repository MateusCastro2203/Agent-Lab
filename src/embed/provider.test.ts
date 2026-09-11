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
