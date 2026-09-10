import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeQuestion, parseGoldenLine } from "./golden.ts";

const validLine = JSON.stringify({
  id: "q001",
  question: "How do I make a query parameter optional?",
  type: "how_to",
  sections: ["tutorial/query-params.md#optional-parameters"],
  url: "https://fastapi.tiangolo.com/tutorial/query-params/#optional-parameters",
  note: "chosen over query-params-str-validations, which covers validation",
});

test("parses a well-formed row and records its line number", () => {
  const row = parseGoldenLine(validLine, 7);
  assert.equal(row.id, "q001");
  assert.equal(row.type, "how_to");
  assert.deepEqual(row.sections, ["tutorial/query-params.md#optional-parameters"]);
  assert.equal(row.line, 7);
});

test("rejects malformed JSON with the line number", () => {
  assert.throws(() => parseGoldenLine("{nope", 3), /line 3/);
});

test("rejects an unknown type", () => {
  const bad = JSON.stringify({ ...JSON.parse(validLine), type: "howto" });
  assert.throws(() => parseGoldenLine(bad, 1), /type/);
});

test("rejects a missing note", () => {
  const { note, ...rest } = JSON.parse(validLine) as Record<string, unknown>;
  assert.throws(() => parseGoldenLine(JSON.stringify(rest), 1), /note/);
});

test("rejects sections that is not an array of strings", () => {
  const bad = JSON.stringify({ ...JSON.parse(validLine), sections: "a#b" });
  assert.throws(() => parseGoldenLine(bad, 1), /sections/);
});

test("normalizeQuestion lowercases, strips punctuation, collapses whitespace", () => {
  assert.equal(
    normalizeQuestion("How  do I,  make a query parameter OPTIONAL?"),
    "how do i make a query parameter optional",
  );
});
