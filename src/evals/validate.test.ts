import { test } from "node:test";
import assert from "node:assert/strict";
import type { Section } from "../corpus/sections.ts";
import type { GoldenRow } from "./golden.ts";
import { validateGolden } from "./validate.ts";

const section = (path: string, slug: string): Section => ({
  id: `${path}#${slug}`,
  path,
  slug,
  title: slug,
  level: 2,
  url: `https://fastapi.tiangolo.com/${path.slice(0, -3)}/#${slug}`,
  anchorSource: "declared",
});

const SECTIONS = [section("tutorial/query-params.md", "optional-parameters")];

const row = (over: Partial<GoldenRow> = {}): GoldenRow => ({
  id: "q001",
  question: "How do I make a query parameter optional?",
  type: "how_to",
  sections: ["tutorial/query-params.md#optional-parameters"],
  url: "https://fastapi.tiangolo.com/tutorial/query-params/#optional-parameters",
  note: "the section that states the default-is-None rule",
  line: 1,
  ...over,
});

const kinds = (rows: GoldenRow[], enforceCounts = false) =>
  validateGolden(rows, SECTIONS, { enforceCounts })
    .filter((p) => p.fatal)
    .map((p) => p.kind)
    .sort();

test("a good row produces no fatal problems", () => {
  assert.deepEqual(kinds([row()]), []);
});

test("flags an unknown section id", () => {
  assert.deepEqual(kinds([row({ sections: ["tutorial/nope.md#gone"] })]), ["unknown-section"]);
});

test("flags an in-scope row with no sections", () => {
  assert.deepEqual(kinds([row({ sections: [], url: undefined })]), ["missing-sections"]);
});

test("flags an out_of_scope row that names a section", () => {
  assert.deepEqual(
    kinds([row({ type: "out_of_scope" })]),
    ["out-of-scope-has-sections", "out-of-scope-has-url"],
  );
});

test("accepts an out_of_scope row with no sections and no url", () => {
  assert.deepEqual(
    kinds([row({ type: "out_of_scope", sections: [], url: undefined })]),
    [],
  );
});

test("flags a url that disagrees with sections[0]", () => {
  assert.deepEqual(kinds([row({ url: "https://fastapi.tiangolo.com/wrong/#x" })]), ["url-mismatch"]);
});

test("flags a duplicate id", () => {
  assert.deepEqual(
    kinds([row(), row({ question: "How do I read a path parameter?", line: 2 })]),
    ["duplicate-id"],
  );
});

test("flags two questions that collide after normalization", () => {
  assert.deepEqual(
    kinds([row(), row({ id: "q002", question: "How  do I make a Query Parameter optional!", line: 2 })]),
    ["duplicate-question"],
  );
});

test("flags a malformed id", () => {
  assert.deepEqual(kinds([row({ id: "1" })]), ["bad-id-format"]);
});

test("reports a slugified anchor as non-fatal", () => {
  const slugified: Section[] = [{ ...SECTIONS[0]!, anchorSource: "slugified" }];
  const problems = validateGolden([row()], slugified, { enforceCounts: false });
  const p = problems.find((x) => x.kind === "slugified-anchor");
  assert.ok(p, "expected a slugified-anchor problem");
  assert.equal(p.fatal, false);
});

test("enforceCounts flags a mix that is not 10/10/10", () => {
  assert.deepEqual(kinds([row()], true), ["label-count", "label-count", "label-count"]);
});
