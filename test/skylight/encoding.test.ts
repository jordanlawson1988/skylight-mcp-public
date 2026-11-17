import { test } from "node:test";
import assert from "node:assert/strict";
import { base64ToBytes, bytesEqual, bytesToBase64, bytesToBase64Url, randomBytes, sha256, timingSafeEqualText, utf8 } from "../../src/skylight/encoding.js";

test("base64 and base64url round-trip arbitrary bytes, matching Node's encoders", () => {
  for (const length of [0, 1, 2, 3, 31, 32, 33, 60_000]) {
    const bytes = randomBytes(length);
    const b64 = bytesToBase64(bytes);
    assert.equal(b64, Buffer.from(bytes).toString("base64"));
    assert.equal(bytesToBase64Url(bytes), Buffer.from(bytes).toString("base64url"));
    assert.deepEqual(base64ToBytes(b64), bytes);
    assert.deepEqual(base64ToBytes(bytesToBase64Url(bytes)), bytes);
  }
});

test("base64ToBytes rejects text that is not base64", () => {
  for (const bad of ["not base64!", "abc=d", "a", "@@@@"]) assert.throws(() => base64ToBytes(bad), /not base64/, bad);
});

test("sha256 matches the known digest of abc", async () => {
  assert.equal(Buffer.from(await sha256("abc")).toString("hex"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.deepEqual(await sha256(utf8("abc")), await sha256("abc"));
});

test("bytesEqual and timingSafeEqualText compare exactly", async () => {
  assert.equal(bytesEqual(utf8("abc"), utf8("abc")), true);
  assert.equal(bytesEqual(utf8("abc"), utf8("abd")), false);
  assert.equal(bytesEqual(utf8("abc"), utf8("abcd")), false);
  assert.equal(await timingSafeEqualText("token-1", "token-1"), true);
  assert.equal(await timingSafeEqualText("token-1", "token-2"), false);
  assert.equal(await timingSafeEqualText("token-1", "token-1 "), false);
  assert.equal(await timingSafeEqualText("", ""), true);
});
