import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { databaseUrl } from "../db/client.ts";
import { toVectorLiteral, topK } from "./search.ts";
import { EMBEDDING_DIM } from "../embed/provider.ts";

test("toVectorLiteral produces the format pgvector parses", () => {
  // Brief note: the 3-element example in the task-5 brief cannot pass this
  // test as written — toVectorLiteral's dimension guard (required by the
  // Task 4 interface: it imports EMBEDDING_DIM to enforce it) throws for any
  // non-768-length vector, so a 3-element input throws here just as it does
  // in the very next test. Padding to EMBEDDING_DIM preserves what this test
  // actually checks — JSON-array literal formatting — without disabling the
  // guard.
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[0] = 0.1;
  v[1] = -0.2;
  v[2] = 3;
  // Checked independently of the implementation — this would fail if
  // toVectorLiteral ever stopped emitting the bracketed, comma-separated,
  // no-space literal pgvector's parser expects.
  const literal = toVectorLiteral(v);
  assert.ok(literal.startsWith("[0.1,-0.2,3,"), literal.slice(0, 40));
  assert.ok(literal.endsWith("]"));
  assert.equal(literal.split(",").length, EMBEDDING_DIM);
  assert.doesNotMatch(literal, / /); // pgvector rejects spaces in the literal
});

test("toVectorLiteral rejects the wrong dimension", () => {
  assert.throws(() => toVectorLiteral([1, 2, 3]), /3 dimensions, expected 768/);
});

// One probe decides whether the database-backed tests run. A skip is printed,
// never silent — a green suite must not hide that these did not execute.
async function probe(): Promise<string | false> {
  const client = new Client({ connectionString: databaseUrl() });
  try {
    await client.connect();
    await client.end();
    return false;
  } catch {
    return `SKIPPED (no database at ${databaseUrl()})`;
  }
}
const skip = await probe();
if (skip !== false) console.log(`search.test.ts: ${skip}`);

function unit(index: number): number[] {
  const v = new Array<number>(EMBEDDING_DIM).fill(0);
  v[index] = 1;
  return v;
}

test("ranks by cosine distance and reports similarity", { skip }, async () => {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM chunks WHERE id LIKE 'test::%'");
    for (const [i, id] of ["test::a", "test::b", "test::c"].entries()) {
      await client.query(
        `INSERT INTO chunks (id, path, slug, heading_path, text, hash, embedding, model)
         VALUES ($1, 'p.md', 's', ARRAY['h'], 't', 'h', $2::vector, 'test-model')`,
        [id, toVectorLiteral(unit(i))],
      );
    }

    const hits = await topK(client, unit(1), 3, "test-model");
    assert.deepEqual(hits.map((h) => h.id), ["test::b", "test::a", "test::c"]);
    assert.ok(hits[0]!.score > 0.99, `expected ~1, got ${hits[0]!.score}`);
    assert.ok(Math.abs(hits[1]!.score) < 0.01, `orthogonal should be ~0, got ${hits[1]!.score}`);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});

test("breaks ties by id, deterministically", { skip }, async () => {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    await client.query("BEGIN");
    for (const id of ["test::z", "test::a"]) {
      await client.query(
        `INSERT INTO chunks (id, path, slug, heading_path, text, hash, embedding, model)
         VALUES ($1, 'p.md', 's', ARRAY['h'], 't', 'h', $2::vector, 'test-model')`,
        [id, toVectorLiteral(unit(0))],
      );
    }
    const hits = await topK(client, unit(0), 2, "test-model");
    assert.deepEqual(hits.map((h) => h.id), ["test::a", "test::z"]);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});

test("ignores rows belonging to another model", { skip }, async () => {
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO chunks (id, path, slug, heading_path, text, hash, embedding, model)
       VALUES ('test::other', 'p.md', 's', ARRAY['h'], 't', 'h', $1::vector, 'other-model')`,
      [toVectorLiteral(unit(0))],
    );
    const hits = await topK(client, unit(0), 5, "test-model");
    assert.deepEqual(hits.filter((h) => h.id === "test::other"), []);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
