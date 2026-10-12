import { test } from "node:test";
import assert from "node:assert/strict";
import { excerpt } from "../../src/skylight/redact.js";

test("masks JSON string values under secret keys", () => {
  const out = excerpt('{"access_token":"abc","refresh_token" : "def","code":"ghi","code_verifier":"jkl","other":"keep"}');
  for (const v of ["abc", "def", "ghi", "jkl"]) assert.ok(!out.includes(v), v);
  assert.match(out, /"access_token":"\[redacted\]"/);
  assert.match(out, /"other":"keep"/);
});

test("masks Bearer credentials", () => {
  const out = excerpt("authorization=Bearer abc.DEF-123_x/y+z== trailing");
  assert.equal(out, "authorization=Bearer [redacted] trailing");
});

test("masks known secrets in raw, URL-encoded and JSON-escaped forms", () => {
  const secret = 'a b/"c';
  const text = `raw ${secret} enc ${encodeURIComponent(secret)} json ${JSON.stringify(secret).slice(1, -1)}`;
  const out = excerpt(text, [secret, ""]);
  assert.equal(out, "raw [redacted] enc [redacted] json [redacted]");
});

test("strips control characters, collapses whitespace and trims", () => {
  assert.equal(excerpt("  a\u0007b\n\n  c\t d  "), "a b c d");
});

test("truncates to max characters including the ellipsis", () => {
  const out = excerpt("x".repeat(2000));
  assert.equal(out.length, 500);
  assert.ok(out.endsWith("…"));
  assert.equal(excerpt("y".repeat(50), [], 10).length, 10);
  assert.equal(excerpt("short"), "short");
});
