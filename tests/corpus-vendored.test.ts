import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { enumerateSections } from "../src/corpus/sections.ts";

test("all four subpaths are vendored", () => {
  for (const dir of ["tutorial", "advanced", "how-to", "deployment"]) {
    assert.ok(existsSync(`corpus/${dir}`), `corpus/${dir} is missing`);
  }
});

test("SOURCE.md records the pinned commit", async () => {
  const source = await readFile("corpus/SOURCE.md", "utf8");
  assert.match(source, /95f8322ee1dcda7ceace7b1c4f6c9915b36d748f/);
});

test("a known section heading survived vendoring", async () => {
  const md = await readFile("corpus/tutorial/query-params.md", "utf8");
  assert.match(md, /^## Optional parameters \{ #optional-parameters \}$/m);
});

// Pins the real corpus's shape, not a fixture's. The fence state machine and the
// declared-anchor rule are the two claims the whole section identity rests on: a
// "simplification" that swallowed real headings, or one that started slugifying,
// would still satisfy every fixture test and would only surface here.
test("the real corpus yields 944 declared-anchor sections over 106 files", async () => {
  const sections = await enumerateSections();

  assert.equal(sections.length, 944, `expected 944 sections, got ${sections.length}`);

  const paths = new Set(sections.map((s) => s.path));
  assert.equal(paths.size, 106, `expected 106 distinct paths, got ${paths.size}`);

  const fellBack = sections.filter((s) => s.anchorSource !== "declared").map((s) => s.id);
  assert.deepEqual(fellBack, [], `these anchors were slugified rather than declared: ${fellBack.join(", ")}`);
});
