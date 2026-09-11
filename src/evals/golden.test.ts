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

// The key must be ABSENT, not merely undefined — the schema says url is "absent on
// out_of_scope rows". Nothing else in the suite pins that: validate.ts's
// out-of-scope-has-url rule tests the value (`row.url !== undefined`), not the key,
// so relaxing golden.ts's conditional spread to a plain `url: o.url` slips past every
// other test while making a JSON round-trip of a row emit `"url": null`.
test("omits the url key entirely when the line carries no url", () => {
  const { url, ...noUrl } = JSON.parse(validLine) as Record<string, unknown>;
  const row = parseGoldenLine(JSON.stringify(noUrl), 1);
  assert.equal(Object.hasOwn(row, "url"), false, `url key leaked in: ${Object.keys(row).join(", ")}`);
  assert.ok(!("url" in row));
  assert.ok(Object.hasOwn(parseGoldenLine(validLine, 1), "url"));
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
