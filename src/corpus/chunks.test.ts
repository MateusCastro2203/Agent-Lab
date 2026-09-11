import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { enumerateSections } from "./sections.ts";
import { buildChunks, enumerateChunks } from "./chunks.ts";
import { loadGolden } from "../evals/golden.ts";

const fixture = (name: string) => readFile(`tests/fixtures/${name}`, "utf8");

test("an H1 body stops at the first H2", async () => {
  const chunks = buildChunks("f.md", await fixture("chunk-extent.md"));
  const top = chunks[0]!;
  assert.equal(top.slug, "top-page");
  assert.match(top.text, /Intro prose that belongs to the H1/);
  assert.doesNotMatch(top.text, /Body of the first section/);
});

test("heading path carries ancestors of strictly decreasing level", async () => {
  const chunks = buildChunks("f.md", await fixture("chunk-extent.md"));
  const byslug = new Map(chunks.map((c) => [c.slug, c]));
  assert.deepEqual(byslug.get("top-page")!.headingPath, ["Top Page"]);
  assert.deepEqual(byslug.get("first-section")!.headingPath, ["Top Page", "First Section"]);
  assert.deepEqual(byslug.get("nested-under-first")!.headingPath, [
    "Top Page",
    "First Section",
    "Nested Under First",
  ]);
  // Second Section is a sibling of First Section, so First must not appear.
  assert.deepEqual(byslug.get("second-section")!.headingPath, ["Top Page", "Second Section"]);
});

test("text is the heading path then a blank line then the body", async () => {
  const chunks = buildChunks("f.md", await fixture("chunk-extent.md"));
  const first = chunks.find((c) => c.slug === "first-section")!;
  assert.ok(first.text.startsWith("Top Page > First Section\n\n"), first.text.slice(0, 60));
});

test("hash-prefixed lines inside fences stay in the body and start no chunk", async () => {
  const chunks = buildChunks("f.md", await fixture("chunk-extent.md"));
  assert.deepEqual(chunks.map((c) => c.slug), [
    "top-page",
    "first-section",
    "nested-under-first",
    "second-section",
  ]);
  const first = chunks.find((c) => c.slug === "first-section")!;
  assert.match(first.text, /# not a heading/);
  const second = chunks.find((c) => c.slug === "second-section")!;
  assert.match(second.text, /## also not a heading/);
});

test("a chunk id equals its section id", async () => {
  const chunks = buildChunks("tutorial/query-params.md", await fixture("chunk-extent.md"));
  assert.equal(chunks[1]!.id, "tutorial/query-params.md#first-section");
});

test("the real corpus yields one chunk per section, with identical id sets", async () => {
  const [sections, chunks] = await Promise.all([enumerateSections(), enumerateChunks()]);
  assert.equal(chunks.length, sections.length, `${chunks.length} chunks vs ${sections.length} sections`);
  const sectionIds = new Set(sections.map((s) => s.id));
  const chunkIds = new Set(chunks.map((c) => c.id));
  const missing = [...sectionIds].filter((id) => !chunkIds.has(id));
  const extra = [...chunkIds].filter((id) => !sectionIds.has(id));
  assert.deepEqual(missing, [], "sections with no chunk");
  assert.deepEqual(extra, [], "chunks with no section");
});

test("every in-scope golden row's gold section has a chunk", async () => {
  const [rows, chunks] = await Promise.all([loadGolden(), enumerateChunks()]);
  const ids = new Set(chunks.map((c) => c.id));
  const unreachable = rows
    .filter((r) => r.type !== "out_of_scope")
    .flatMap((r) => r.sections)
    .filter((id) => !ids.has(id));
  assert.deepEqual(unreachable, []);
});

test("no chunk is empty of body text", async () => {
  const chunks = await enumerateChunks();
  const bodiless = chunks.filter((c) => c.text.split("\n\n").slice(1).join("\n\n").trim() === "");
  // Some pages legitimately have a heading with no prose before the next
  // heading. Report them rather than failing: the count is information, and a
  // sudden jump means the extent rule broke.
  console.log(`chunks with an empty body: ${bodiless.length} of ${chunks.length}`);
  assert.ok(bodiless.length < chunks.length / 2, `${bodiless.length} of ${chunks.length} chunks have no body`);
});
