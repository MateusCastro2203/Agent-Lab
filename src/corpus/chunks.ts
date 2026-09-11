import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { enumerateSections, parseSections, type Section } from "./sections.ts";

export interface Chunk {
  id: string;
  path: string;
  slug: string;
  /** Ancestors of strictly decreasing level, then the section's own heading. */
  headingPath: string[];
  /** What gets embedded: the heading path, a blank line, then the body. */
  text: string;
}

function headingPathFor(sections: Section[], index: number): string[] {
  const self = sections[index]!;
  const path: string[] = [self.title];
  let level = self.level;
  for (let k = index - 1; k >= 0; k -= 1) {
    const candidate = sections[k]!;
    if (candidate.level < level) {
      path.unshift(candidate.title);
      level = candidate.level;
    }
  }
  return path;
}

export function buildChunks(relPath: string, markdown: string): Chunk[] {
  const lines = markdown.split("\n");
  const sections = parseSections(relPath, markdown);

  return sections.map((section, index) => {
    // A section's body runs to the NEXT HEADING OF ANY LEVEL, so sections never
    // nest and no chunk contains another chunk's text.
    const start = section.line + 1;
    const end = sections[index + 1]?.line ?? lines.length;
    const body = lines.slice(start, end).join("\n").trim();
    const headingPath = headingPathFor(sections, index);

    return {
      id: section.id,
      path: section.path,
      slug: section.slug,
      headingPath,
      text: `${headingPath.join(" > ")}\n\n${body}`,
    };
  });
}

export async function enumerateChunks(corpusRoot = "corpus"): Promise<Chunk[]> {
  const sections = await enumerateSections(corpusRoot);
  const paths = [...new Set(sections.map((s) => s.path))];
  const all: Chunk[] = [];
  for (const relPath of paths) {
    const markdown = await readFile(join(corpusRoot, relPath), "utf8");
    all.push(...buildChunks(relPath, markdown));
  }
  return all;
}
