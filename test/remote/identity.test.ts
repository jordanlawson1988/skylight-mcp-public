import { test } from "node:test";
import assert from "node:assert/strict";
import { bindIdentity, clearIdentity, identityKey, isPlainEmail } from "../../src/remote/identity.js";
import { createMemoryKv } from "../helpers/memory-kv.js";

test("isPlainEmail accepts printable-ASCII addresses with one @ and a dotted domain", () => {
  for (const ok of ["jordan@example.com", "a.b+c@sub.example.co.uk", "UPPER@Example.COM", "x_y-z@e.io"]) assert.equal(isPlainEmail(ok), true, ok);
});

test("isPlainEmail refuses look-alikes, control characters, spaces, commas, a second @ and dotless domains", () => {
  for (const bad of [
    "jоrdan@example.com", // Cyrillic o
    "jordan@examрle.com", // Cyrillic r
    "jordan@example.com​", // zero-width space
    "jor\u0000dan@example.com",
    "jordan@example.com\n",
    "jor dan@example.com",
    "jordan@example.com,wife@example.com",
    "jordan@@example.com",
    "jordan@ex@ample.com",
    "jordan@localhost",
    "@example.com",
    "jordan@",
    "",
    "x".repeat(250) + "@example.com",
  ]) assert.equal(isPlainEmail(bad), false, JSON.stringify(bad));
});

test("the first sign-in binds an email to its Google sub; later sign-ins must match", async () => {
  const kv = createMemoryKv();
  assert.equal(await bindIdentity(kv, "jordan@example.com", "google-sub-1"), true);
  assert.equal(kv.data.get(identityKey("jordan@example.com")), "google-sub-1");
  const writes = kv.writes;
  assert.equal(await bindIdentity(kv, "jordan@example.com", "google-sub-1"), true);
  assert.equal(kv.writes, writes, "a matching sign-in writes nothing");
  assert.equal(await bindIdentity(kv, "jordan@example.com", "google-sub-2"), false);
  assert.equal(kv.data.get(identityKey("jordan@example.com")), "google-sub-1", "a mismatch never rebinds");
  assert.equal(await bindIdentity(kv, "wife@example.com", "google-sub-2"), true, "bindings are per email");
});

test("clearIdentity resets a binding so the next sign-in binds again", async () => {
  const kv = createMemoryKv();
  await bindIdentity(kv, "jordan@example.com", "google-sub-1");
  assert.equal(await clearIdentity(kv, "jordan@example.com"), true);
  assert.equal(await clearIdentity(kv, "jordan@example.com"), false);
  assert.equal(await bindIdentity(kv, "jordan@example.com", "google-sub-9"), true);
  assert.equal(kv.data.get(identityKey("jordan@example.com")), "google-sub-9");
});
