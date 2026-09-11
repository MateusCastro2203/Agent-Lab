import { enumerateSections } from "../src/corpus/sections.ts";
import { loadGolden } from "../src/evals/golden.ts";
import { validateGolden } from "../src/evals/validate.ts";

const enforceCounts = process.argv.includes("--final");

const [rows, sections] = await Promise.all([loadGolden(), enumerateSections()]);
const problems = validateGolden(rows, sections, { enforceCounts });

for (const p of problems) {
  const where = p.line === null ? "golden.jsonl" : `golden.jsonl:${p.line}`;
  const level = p.fatal ? "error" : "warn";
  console.error(`${level} ${where} [${p.kind}] ${p.message}`);
}

const counts = { how_to: 0, concept: 0, out_of_scope: 0 };
for (const row of rows) counts[row.type] += 1;
console.log(
  `${rows.length} rows (how_to ${counts.how_to}, concept ${counts.concept}, ` +
    `out_of_scope ${counts.out_of_scope}) against ${sections.length} sections`,
);

const fatal = problems.filter((p) => p.fatal).length;
if (fatal > 0) {
  console.error(`${fatal} fatal problem(s)`);
  process.exit(1);
}
console.log("golden set OK");
