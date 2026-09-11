import { test } from "node:test";
import assert from "node:assert/strict";
import { databaseUrl, describe } from "./client.ts";

test("describe unwraps an AggregateError with an empty message", () => {
  const aggregate = new AggregateError([
    new Error("connect ECONNREFUSED ::1:5433"),
    new Error("connect ECONNREFUSED 127.0.0.1:5433"),
  ]);
  assert.equal(aggregate.message, "");
  assert.equal(
    describe(aggregate),
    "connect ECONNREFUSED ::1:5433; connect ECONNREFUSED 127.0.0.1:5433",
  );
});

test("describe collapses duplicate causes", () => {
  const aggregate = new AggregateError([new Error("same"), new Error("same")]);
  assert.equal(describe(aggregate), "same");
});

test("describe falls back to a plain Error's message", () => {
  assert.equal(describe(new Error("plain")), "plain");
});

test("describe stringifies a non-Error", () => {
  assert.equal(describe("just a string"), "just a string");
});

test("databaseUrl prefers DATABASE_URL and falls back to the local default", () => {
  const original = process.env.DATABASE_URL;
  try {
    process.env.DATABASE_URL = "postgres://example/db";
    assert.equal(databaseUrl(), "postgres://example/db");
    delete process.env.DATABASE_URL;
    assert.equal(databaseUrl(), "postgres://agentlab:agentlab@localhost:5433/agentlab");
  } finally {
    if (original === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = original;
  }
});
