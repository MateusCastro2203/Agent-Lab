import { enumerateSections } from "../src/corpus/sections.ts";

const sections = await enumerateSections();
for (const s of sections) {
  console.log(`${s.id}\t${s.anchorSource}\t${s.title}`);
}
console.error(`${sections.length} sections`);
