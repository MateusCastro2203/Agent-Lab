import { test } from "node:test";
import assert from "node:assert/strict";
import { enumerateSections } from "../src/corpus/sections.ts";
import { loadGolden } from "../src/evals/golden.ts";
import { validateGolden } from "../src/evals/validate.ts";

test("the committed golden set is valid, including the 10/10/10 mix", async () => {
  const [rows, sections] = await Promise.all([loadGolden(), enumerateSections()]);
  const fatal = validateGolden(rows, sections, { enforceCounts: true }).filter((p) => p.fatal);
  assert.deepEqual(
    fatal.map((p) => `${p.line ?? "-"} ${p.kind}: ${p.message}`),
    [],
  );
});

test("the golden set holds exactly 30 rows", async () => {
  const rows = await loadGolden();
  assert.equal(rows.length, 30);
});
