#!/usr/bin/env bash
set -euo pipefail

TAG="0.141.1"
SHA="95f8322ee1dcda7ceace7b1c4f6c9915b36d748f"
UPSTREAM="https://github.com/fastapi/fastapi.git"
SUBDIRS=(tutorial advanced how-to deployment)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$TMP" init -q
git -C "$TMP" remote add origin "$UPSTREAM"
git -C "$TMP" config core.sparseCheckout true
git -C "$TMP" sparse-checkout set --no-cone \
  'docs/en/docs/tutorial/**' \
  'docs/en/docs/advanced/**' \
  'docs/en/docs/how-to/**' \
  'docs/en/docs/deployment/**'
git -C "$TMP" fetch -q --depth 1 origin "refs/tags/$TAG"
git -C "$TMP" checkout -q FETCH_HEAD

RESOLVED="$(git -C "$TMP" rev-parse HEAD)"
if [[ "$RESOLVED" != "$SHA" ]]; then
  echo "PIN MISMATCH: tag $TAG resolves to $RESOLVED, expected $SHA" >&2
  exit 1
fi

rm -rf "$REPO_ROOT/corpus"
mkdir -p "$REPO_ROOT/corpus"
for d in "${SUBDIRS[@]}"; do
  cp -R "$TMP/docs/en/docs/$d" "$REPO_ROOT/corpus/$d"
done

FILE_COUNT="$(find "$REPO_ROOT/corpus" -name '*.md' | wc -l | tr -d ' ')"

cat > "$REPO_ROOT/corpus/SOURCE.md" <<EOF
# Corpus source

Vendored from [fastapi/fastapi]($UPSTREAM).

- **Tag:** \`$TAG\`
- **Commit:** \`$SHA\`
- **Upstream path:** \`docs/en/docs/\`
- **Subpaths:** ${SUBDIRS[*]}
- **Markdown files:** $FILE_COUNT

Regenerate with \`npm run corpus:fetch\`. The script fails if the tag no longer
resolves to the pinned commit.

The FastAPI documentation is © Sebastián Ramírez, MIT licensed. It is included
here as a retrieval corpus only.
EOF

echo "vendored $FILE_COUNT markdown files at $TAG ($SHA)"
