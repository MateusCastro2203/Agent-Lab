import { test } from "node:test";
import assert from "node:assert/strict";
import { toUrl } from "./urls.ts";

test("drops the .md extension and adds a trailing slash", () => {
  assert.equal(
    toUrl("tutorial/query-params.md", "optional-parameters"),
    "https://fastapi.tiangolo.com/tutorial/query-params/#optional-parameters",
  );
});

test("collapses index.md to its directory", () => {
  assert.equal(
    toUrl("tutorial/index.md", "tutorial-user-guide"),
    "https://fastapi.tiangolo.com/tutorial/#tutorial-user-guide",
  );
});

test("handles a nested path", () => {
  assert.equal(
    toUrl("advanced/security/oauth2-scopes.md", "oauth2-scopes"),
    "https://fastapi.tiangolo.com/advanced/security/oauth2-scopes/#oauth2-scopes",
  );
});

test("rejects a path that is not markdown", () => {
  assert.throws(() => toUrl("tutorial/query-params.txt", "x"), /must end in \.md/);
});

test("rejects an anchor carrying a leading hash", () => {
  assert.throws(() => toUrl("tutorial/query-params.md", "#x"), /leading '#'/);
});
