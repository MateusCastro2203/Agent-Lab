import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { toUrl } from "./urls.ts";

export type AnchorSource = "declared" | "slugified";

export interface Section {
  id: string;
  path: string;
  slug: string;
  title: string;
  level: number;
  url: string;
  anchorSource: AnchorSource;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const DECLARED_ANCHOR = /\s*\{\s*#([^}\s]+)\s*\}\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;

export function slugify(headingText: string, taken: Set<string>): string {
  const plain = headingText
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links keep their label
    .replace(/[`*_~]/g, "");
  const base = plain
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-_]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!taken.has(base)) return base;
  let n = 1;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

export function parseSections(relPath: string, markdown: string): Section[] {
  const sections: Section[] = [];
  const taken = new Set<string>();
  let openFence: string | null = null;

  for (const line of markdown.split("\n")) {
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      if (openFence === null) {
        openFence = marker;
        continue;
      }
      // A fence closes only on the same character, at least as long.
      if (marker[0] === openFence[0] && marker.length >= openFence.length) {
        openFence = null;
      }
      continue;
    }
    if (openFence !== null) continue;

    const heading = HEADING.exec(line);
    if (!heading) continue;

    const level = heading[1]!.length;
    const raw = heading[2]!.trim();
    const declared = DECLARED_ANCHOR.exec(raw);
    const title = (declared ? raw.slice(0, declared.index) : raw).trim();

    const slug = declared ? declared[1]! : slugify(title, taken);
    taken.add(slug);

    sections.push({
      id: `${relPath}#${slug}`,
      path: relPath,
      slug,
      title,
      level,
      url: toUrl(relPath, slug),
      anchorSource: declared ? "declared" : "slugified",
    });
  }

  return sections;
}

async function markdownFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md") && e.name !== "SOURCE.md")
    .map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join("/"))
    .sort();
}

export async function enumerateSections(corpusRoot = "corpus"): Promise<Section[]> {
  const paths = await markdownFiles(corpusRoot);
  const all: Section[] = [];
  for (const relPath of paths) {
    const markdown = await readFile(join(corpusRoot, relPath), "utf8");
    all.push(...parseSections(relPath, markdown));
  }
  return all;
}
