import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { enumerateSections, parseSections, slugify } from "./sections.ts";

const fixture = (name: string) => readFile(`tests/fixtures/${name}`, "utf8");

test("reads declared anchors and strips the anchor block from the title", async () => {
  const sections = parseSections("f.md", await fixture("declared-anchors.md"));
  assert.deepEqual(
    sections.map((s) => [s.slug, s.title, s.level, s.anchorSource]),
    [
      ["query-parameters", "Query Parameters", 1, "declared"],
      ["optional-parameters", "Optional parameters", 2, "declared"],
      ["no-spaces-in-braces", "A deeper heading", 3, "declared"],
    ],
  );
});

test("builds the id from path and slug", async () => {
  const sections = parseSections("tutorial/query-params.md", await fixture("declared-anchors.md"));
  assert.equal(sections[1]?.id, "tutorial/query-params.md#optional-parameters");
  assert.equal(
    sections[1]?.url,
    "https://fastapi.tiangolo.com/tutorial/query-params/#optional-parameters",
  );
});

test("ignores hash-prefixed lines inside code fences", async () => {
  const sections = parseSections("f.md", await fixture("fenced-code.md"));
  assert.deepEqual(sections.map((s) => s.slug), ["docker", "real-heading", "last-heading"]);
});

test("slugifies a heading that declares no anchor", async () => {
  const sections = parseSections("f.md", await fixture("no-anchors.md"));
  assert.deepEqual(
    sections.map((s) => [s.slug, s.anchorSource]),
    [
      ["getting-started", "slugified"],
      ["using-depends-carefully", "slugified"],
      ["using-depends-carefully_1", "slugified"],
      ["read-the-docs", "slugified"],
    ],
  );
});

test("title preserves inline markdown; only the slug strips it", async () => {
  const sections = parseSections("f.md", await fixture("no-anchors.md"));
  assert.deepEqual(
    sections.map((s) => s.title),
    [
      "Getting Started",
      "Using `Depends()`, *carefully*",
      "Using `Depends()`, *carefully*",
      "Read the [docs](https://example.com)!",
    ],
  );
});

test("slugify strips punctuation and lowercases", () => {
  assert.equal(slugify("Using `Depends()`, *carefully*", new Set()), "using-depends-carefully");
});

test("slugify suffixes a within-file collision", () => {
  const taken = new Set(["a-heading"]);
  assert.equal(slugify("A heading", taken), "a-heading_1");
});

test("the real corpus yields a known section id", async () => {
  const sections = await enumerateSections();
  const ids = new Set(sections.map((s) => s.id));
  assert.ok(ids.has("tutorial/query-params.md#optional-parameters"));
});

test("no real corpus section id contains a space", async () => {
  const sections = await enumerateSections();
  const bad = sections.filter((s) => /\s/.test(s.id));
  assert.deepEqual(bad.map((s) => s.id), []);
});

test("records the 0-based line index of each heading", async () => {
  const sections = parseSections("f.md", await fixture("declared-anchors.md"));
  // Verified against tests/fixtures/declared-anchors.md: the three headings sit
  // on 0-based lines 0, 4 and 8.
  assert.deepEqual(
    sections.map((s) => [s.slug, s.line]),
    [
      ["query-parameters", 0],
      ["optional-parameters", 4],
      ["no-spaces-in-braces", 8],
    ],
  );
});

test("line indexes skip fenced content, matching the sections found", async () => {
  const sections = parseSections("f.md", await fixture("fenced-code.md"));
  const lines = (await fixture("fenced-code.md")).split("\n");
  for (const section of sections) {
    assert.match(lines[section.line] ?? "", /^#{1,6} /, `line ${section.line} is not a heading`);
  }
});
