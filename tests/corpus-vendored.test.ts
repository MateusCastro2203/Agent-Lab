import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

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
