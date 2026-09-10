export const DOCS_BASE = "https://fastapi.tiangolo.com/";

export function toUrl(relPath: string, anchor: string): string {
  if (!relPath.endsWith(".md")) {
    throw new Error(`path must end in .md: ${relPath}`);
  }
  if (anchor.startsWith("#")) {
    throw new Error(`anchor must not carry a leading '#': ${anchor}`);
  }
  const withoutExt = relPath.slice(0, -".md".length);
  const docPath = withoutExt.endsWith("/index")
    ? withoutExt.slice(0, -"index".length)
    : withoutExt === "index"
      ? ""
      : `${withoutExt}/`;
  return `${DOCS_BASE}${docPath}#${anchor}`;
}
