import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { createCredentialStore } from "../../src/skylight/credentials.js";
import { AuthError } from "../../src/skylight/errors.js";
import { createFakeKeychain } from "../helpers/fake-keychain.js";
import { makeTmpDir } from "../helpers/tmp-dir.js";

const BASE = "https://app.ourskylight.com";
const cred = { version: 1 as const, accessToken: "AT", refreshToken: "RT", fingerprint: "fp", expiresAt: 123 };

test("write then read round-trips through encryption, file is not plaintext", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { runner, items } = createFakeKeychain();
  const store = createCredentialStore({ dir, apiBaseUrl: BASE, runner });
  assert.equal(await store.read(), null);
  await store.write(cred);
  assert.deepEqual(await store.read(), cred);
  const files = await readdir(dir);
  const file = files.find((f) => f.endsWith(".json") && !f.startsWith("pending"))!;
  const raw = await readFile(`${dir}/${file}`, "utf8");
  // Short tokens like "AT"/"RT" can occur by chance in random base64, so assert on structure and field names instead.
  assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["ciphertext", "iv", "tag", "version"]);
  assert.ok(!raw.includes("accessToken") && !raw.includes("refreshToken"));
  assert.equal((await stat(`${dir}/${file}`)).mode & 0o777, 0o600);
  assert.equal(items.size, 1);
  await cleanup();
});

test("a second store instance reads what the first wrote (no in-memory cache)", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { runner } = createFakeKeychain();
  const a = createCredentialStore({ dir, apiBaseUrl: BASE, runner });
  const b = createCredentialStore({ dir, apiBaseUrl: BASE, runner });
  await a.write(cred);
  await b.write({ ...cred, refreshToken: "RT2" });
  assert.equal((await a.read())!.refreshToken, "RT2");
  await cleanup();
});

test("delete removes file and key, returns false when nothing stored", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { runner, items } = createFakeKeychain();
  const store = createCredentialStore({ dir, apiBaseUrl: BASE, runner });
  assert.equal(await store.delete(), false);
  await store.write(cred);
  assert.equal(await store.delete(), true);
  assert.equal(await store.read(), null);
  assert.equal(items.size, 0);
  await cleanup();
});

test("wrong key fails closed with a helpful error", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { runner, items } = createFakeKeychain();
  const store = createCredentialStore({ dir, apiBaseUrl: BASE, runner });
  await store.write(cred);
  for (const k of items.keys()) items.set(k, Buffer.alloc(32, 7).toString("base64"));
  await assert.rejects(store.read(), /could not be decrypted/);
  await cleanup();
});

test("pending login round-trip and delete", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { runner } = createFakeKeychain();
  const store = createCredentialStore({ dir, apiBaseUrl: BASE, runner });
  assert.equal(await store.readPendingLogin(), null);
  const p = { state: "s", verifier: "v", fingerprint: "f", createdAt: 1, method: "S256" as const };
  await store.writePendingLogin(p);
  assert.deepEqual(await store.readPendingLogin(), p);
  await store.deletePendingLogin();
  assert.equal(await store.readPendingLogin(), null);
  await cleanup();
});

test("withRefreshLock serializes concurrent callers and clears stale locks", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { runner } = createFakeKeychain();
  let now = 1_000_000;
  const store = createCredentialStore({ dir, apiBaseUrl: BASE, runner, now: () => now });
  const order: string[] = [];
  await Promise.all([
    store.withRefreshLock(async () => { order.push("a-start"); await new Promise((r) => setTimeout(r, 50)); order.push("a-end"); }),
    store.withRefreshLock(async () => { order.push("b-start"); order.push("b-end"); }),
  ]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  // stale lock: create one by hand with an old mtime, then lock must still succeed
  const { writeFile, utimes } = await import("node:fs/promises");
  await writeFile(`${dir}/refresh.lock`, "x");
  const old = new Date(now - 120_000);
  await utimes(`${dir}/refresh.lock`, old, old);
  await store.withRefreshLock(async () => order.push("c"));
  assert.equal(order.at(-1), "c");
  await cleanup();
});

test("withRefreshLock serializes separate store instances sharing a directory (file lock, not just in-process queue)", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { runner } = createFakeKeychain();
  const a = createCredentialStore({ dir, apiBaseUrl: BASE, runner });
  const b = createCredentialStore({ dir, apiBaseUrl: BASE, runner });
  const order: string[] = [];
  const hold = (name: string) => async () => { order.push(`${name}-start`); await new Promise((r) => setTimeout(r, 50)); order.push(`${name}-end`); };
  await Promise.all([a.withRefreshLock(hold("a")), b.withRefreshLock(hold("b"))]);
  // Which instance wins the lockfile is a race; what matters is that the critical sections never overlap.
  assert.equal(order.length, 4);
  assert.match(order.join(","), /^(a-start,a-end,b-start,b-end|b-start,b-end,a-start,a-end)$/);
  await cleanup();
});

test("two instances racing over a pre-existing stale lock never overlap and leave no lockfile behind", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { runner } = createFakeKeychain();
  const { writeFile, utimes } = await import("node:fs/promises");
  await writeFile(`${dir}/refresh.lock`, "dead-owner");
  const old = new Date(Date.now() - 120_000);
  await utimes(`${dir}/refresh.lock`, old, old);
  const a = createCredentialStore({ dir, apiBaseUrl: BASE, runner });
  const b = createCredentialStore({ dir, apiBaseUrl: BASE, runner });
  let inside = 0;
  let maxInside = 0;
  const section = async () => {
    inside++;
    maxInside = Math.max(maxInside, inside);
    await new Promise((r) => setTimeout(r, 50));
    inside--;
  };
  await Promise.all([a.withRefreshLock(section), b.withRefreshLock(section)]);
  assert.equal(maxInside, 1);
  assert.deepEqual((await readdir(dir)).filter((f) => f.startsWith("refresh.lock")), []);
  await cleanup();
});

test("a holder whose lock was replaced does not delete the new owner's lockfile", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { runner } = createFakeKeychain();
  const { writeFile } = await import("node:fs/promises");
  const store = createCredentialStore({ dir, apiBaseUrl: BASE, runner });
  await store.withRefreshLock(async () => { await writeFile(`${dir}/refresh.lock`, "someone-else"); });
  assert.equal(await readFile(`${dir}/refresh.lock`, "utf8"), "someone-else");
  await cleanup();
});

test("a stored iv or tag of the wrong length fails closed", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { runner } = createFakeKeychain();
  const store = createCredentialStore({ dir, apiBaseUrl: BASE, runner });
  await store.write(cred);
  const { writeFile } = await import("node:fs/promises");
  const file = (await readdir(dir)).find((f) => f.endsWith(".json"))!;
  const enc = JSON.parse(await readFile(`${dir}/${file}`, "utf8"));
  await writeFile(`${dir}/${file}`, JSON.stringify({ ...enc, tag: Buffer.from(enc.tag, "base64").subarray(0, 4).toString("base64") }));
  await assert.rejects(store.read(), /could not be decrypted/);
  await writeFile(`${dir}/${file}`, JSON.stringify({ ...enc, iv: Buffer.alloc(16, 1).toString("base64") }));
  await assert.rejects(store.read(), /could not be decrypted/);
  await cleanup();
});

test("a corrupt pending-login file is an AuthError that does not echo its contents", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { runner } = createFakeKeychain();
  const store = createCredentialStore({ dir, apiBaseUrl: BASE, runner });
  const { writeFile } = await import("node:fs/promises");
  for (const bad of ["garbage-SECRET{", JSON.stringify({ state: "s" }), JSON.stringify({ state: "s", verifier: "v", fingerprint: "f", createdAt: "1", method: "S256" }), JSON.stringify({ state: "s", verifier: "v", fingerprint: "f", createdAt: 1, method: "md5" })]) {
    await writeFile(`${dir}/pending-login.json`, bad);
    await assert.rejects(store.readPendingLogin(), (e: unknown) => e instanceof AuthError && /pending login file is corrupt/.test(e.message) && !e.message.includes("SECRET"));
  }
  await cleanup();
});
