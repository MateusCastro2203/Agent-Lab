import type { Section } from "../corpus/sections.ts";
import { GOLDEN_TYPES, normalizeQuestion, type GoldenRow } from "./golden.ts";

export interface Problem {
  rowId: string | null;
  line: number | null;
  kind: string;
  message: string;
  fatal: boolean;
}

export interface ValidateOptions {
  enforceCounts: boolean;
}

const ID_FORMAT = /^q\d{3}$/;
const EXPECTED_PER_LABEL = 10;

export function validateGolden(
  rows: GoldenRow[],
  sections: Section[],
  options: ValidateOptions,
): Problem[] {
  const problems: Problem[] = [];
  const byId = new Map<string, Section>(sections.map((s) => [s.id, s]));
  const seenIds = new Set<string>();
  const seenQuestions = new Map<string, string>();

  const add = (row: GoldenRow | null, kind: string, message: string, fatal = true) =>
    problems.push({
      rowId: row?.id ?? null,
      line: row?.line ?? null,
      kind,
      message,
      fatal,
    });

  for (const row of rows) {
    if (!ID_FORMAT.test(row.id)) {
      add(row, "bad-id-format", `id ${JSON.stringify(row.id)} does not match q\\d{3}`);
    }
    if (seenIds.has(row.id)) add(row, "duplicate-id", `id ${row.id} appears more than once`);
    seenIds.add(row.id);

    const normalized = normalizeQuestion(row.question);
    const previous = seenQuestions.get(normalized);
    if (previous !== undefined) {
      add(row, "duplicate-question", `question collides with ${previous} after normalization`);
    } else {
      seenQuestions.set(normalized, row.id);
    }

    if (row.note.trim() === "") add(row, "empty-note", "note must explain the section choice");

    if (row.type === "out_of_scope") {
      if (row.sections.length > 0) {
        add(row, "out-of-scope-has-sections", "an out_of_scope row must have sections: []");
      }
      if (row.url !== undefined) {
        add(row, "out-of-scope-has-url", "an out_of_scope row must not carry a url");
      }
      continue;
    }

    if (row.sections.length === 0) {
      add(row, "missing-sections", "an in-scope row must name at least one section");
      continue;
    }

    for (const id of row.sections) {
      const section = byId.get(id);
      if (section === undefined) {
        add(row, "unknown-section", `no section in the corpus has id ${id}`);
        continue;
      }
      if (section.anchorSource === "slugified") {
        add(
          row,
          "slugified-anchor",
          `${id} has no anchor declared upstream; its id depends on our slugify rule`,
          false,
        );
      }
    }

    const primary = byId.get(row.sections[0]!);
    if (primary !== undefined && row.url !== primary.url) {
      add(row, "url-mismatch", `url should be ${primary.url}`);
    }
  }

  if (options.enforceCounts) {
    for (const type of GOLDEN_TYPES) {
      const n = rows.filter((r) => r.type === type).length;
      if (n !== EXPECTED_PER_LABEL) {
        add(null, "label-count", `expected ${EXPECTED_PER_LABEL} ${type} rows, found ${n}`);
      }
    }
  }

  return problems;
}
