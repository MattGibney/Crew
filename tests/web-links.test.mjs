import test from "node:test";
import assert from "node:assert/strict";
import { webLink } from "../runtime/shared/web-links.mjs";

test("untrusted links accept explicit HTTP(S) with canonical URL output", () => {
  assert.equal(
    webLink("HTTPS://Example.com/a?x=1&y=2#part"),
    "https://example.com/a?x=1&y=2#part",
  );
  assert.equal(
    webLink("http://127.0.0.1:4321/check"),
    "http://127.0.0.1:4321/check",
  );
  assert.equal(
    webLink("https://example.com/a%20b"),
    "https://example.com/a%20b",
  );
});

test("untrusted links reject privileged schemes, credentials, relative URLs and coercion", () => {
  for (const value of [
    null,
    42,
    {},
    { toString: () => "https://example.com" },
    "",
    "/api/work",
    "//example.com",
    "https:example.com",
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///tmp/private",
    "mailto:person@example.com",
    "codex://anything",
    "https://user:secret@example.com",
    "http://user@example.com",
    " https://example.com",
    "https://example.com/\nother",
    "https://example.com/has space",
    "https://",
    "https://example.com/" + "x".repeat(8192),
  ])
    assert.equal(webLink(value), null, String(value));
});
