import { readFile } from "node:fs/promises";

export type GoldenType = "how_to" | "concept" | "out_of_scope";

export const GOLDEN_TYPES: readonly GoldenType[] = ["how_to", "concept", "out_of_scope"];

export interface GoldenRow {
  id: string;
  question: string;
  type: GoldenType;
  sections: string[];
  url?: string;
  note: string;
  line: number;
}

export function normalizeQuestion(question: string): string {
  return question
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

export function parseGoldenLine(line: string, lineNo: number): GoldenRow {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error(`line ${lineNo}: malformed JSON`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`line ${lineNo}: expected a JSON object`);
  }
  const o = raw as Record<string, unknown>;

  if (typeof o.id !== "string") throw new Error(`line ${lineNo}: id must be a string`);
  if (typeof o.question !== "string") throw new Error(`line ${lineNo}: question must be a string`);
  if (typeof o.note !== "string") throw new Error(`line ${lineNo}: note must be a string`);
  if (!GOLDEN_TYPES.includes(o.type as GoldenType)) {
    throw new Error(`line ${lineNo}: type must be one of ${GOLDEN_TYPES.join(", ")}`);
  }
  if (!isStringArray(o.sections)) {
    throw new Error(`line ${lineNo}: sections must be an array of strings`);
  }
  if (o.url !== undefined && typeof o.url !== "string") {
    throw new Error(`line ${lineNo}: url must be a string when present`);
  }

  return {
    id: o.id,
    question: o.question,
    type: o.type as GoldenType,
    sections: o.sections,
    ...(o.url === undefined ? {} : { url: o.url }),
    note: o.note,
    line: lineNo,
  };
}

export async function loadGolden(path = "evals/golden.jsonl"): Promise<GoldenRow[]> {
  const text = await readFile(path, "utf8");
  const rows: GoldenRow[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    rows.push(parseGoldenLine(line, i + 1));
  });
  return rows;
}
