import { test } from "node:test";
import assert from "node:assert/strict";
import { createTokenProvider } from "../../src/skylight/auth.js";
import { createCredentialStore } from "../../src/skylight/credentials.js";
import { AuthError } from "../../src/skylight/errors.js";
import { createFakeKeychain } from "../helpers/fake-keychain.js";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { makeTmpDir } from "../helpers/tmp-dir.js";

const BASE = "https://app.ourskylight.com";

async function setup(expiresAt: number) {
  const { dir, cleanup } = await makeTmpDir();
  const { runner } = createFakeKeychain();
  const store = createCredentialStore({ dir, apiBaseUrl: BASE, runner });
  await store.write({ version: 1, accessToken: "AT1", refreshToken: "RT1", fingerprint: "fp", expiresAt });
  return { store, cleanup };
}

test("returns stored token when not near expiry", async () => {
  const { store, cleanup } = await setup(Date.now() + 3600_000);
  const { fetch, calls } = createMockFetch([]);
  const tp = createTokenProvider({ store, fetch, apiBaseUrl: BASE, timeoutMs: 1000 });
  assert.equal(await tp.getAccessToken(), "AT1");
  assert.equal(calls.length, 0);
  await cleanup();
});

test("refreshes when within 60s of expiry and persists the rotated token", async () => {
  const { store, cleanup } = await setup(Date.now() + 30_000);
  const { fetch, calls } = createMockFetch([
    { method: "POST", path: "/oauth/token", json: { access_token: "AT2", refresh_token: "RT2", expires_in: 3600 } },
  ]);
  const tp = createTokenProvider({ store, fetch, apiBaseUrl: BASE, timeoutMs: 1000 });
  assert.equal(await tp.getAccessToken(), "AT2");
  assert.equal(calls.length, 1);
  assert.equal((await store.read())!.refreshToken, "RT2");
  await cleanup();
});

test("skips network when token already rotated by another process", async () => {
  const { store, cleanup } = await setup(Date.now() - 1000);
  const { fetch, calls } = createMockFetch([]);
  const tp = createTokenProvider({ store, fetch, apiBaseUrl: BASE, timeoutMs: 1000 });
  // simulate another process rotating between first read and lock acquisition
  const originalLock = store.withRefreshLock.bind(store);
  store.withRefreshLock = async (fn) => {
    await store.write({ version: 1, accessToken: "AT9", refreshToken: "RT9", fingerprint: "fp", expiresAt: Date.now() + 3600_000 });
    return originalLock(fn);
  };
  assert.equal(await tp.getAccessToken(), "AT9");
  assert.equal(calls.length, 0);
  await cleanup();
});

test("refreshAfterRejection returns newer stored token without network if it differs", async () => {
  const { store, cleanup } = await setup(Date.now() + 3600_000);
  const { fetch, calls } = createMockFetch([]);
  const tp = createTokenProvider({ store, fetch, apiBaseUrl: BASE, timeoutMs: 1000 });
  assert.equal(await tp.refreshAfterRejection("OLD"), "AT1");
  assert.equal(calls.length, 0);
  await cleanup();
});

test("refreshAfterRejection refreshes when the rejected token is the stored one", async () => {
  const { store, cleanup } = await setup(Date.now() + 3600_000);
  const { fetch, calls } = createMockFetch([
    { method: "POST", path: "/oauth/token", json: { access_token: "AT2", refresh_token: "RT2", expires_in: 3600 } },
  ]);
  const tp = createTokenProvider({ store, fetch, apiBaseUrl: BASE, timeoutMs: 1000 });
  assert.equal(await tp.refreshAfterRejection("AT1"), "AT2");
  assert.equal(calls.length, 1);
  await cleanup();
});

test("no stored credential is an AuthError telling the user to log in", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { runner } = createFakeKeychain();
  const store = createCredentialStore({ dir, apiBaseUrl: BASE, runner });
  const { fetch } = createMockFetch([]);
  const tp = createTokenProvider({ store, fetch, apiBaseUrl: BASE, timeoutMs: 1000 });
  await assert.rejects(tp.getAccessToken(), (e: unknown) => e instanceof AuthError && /skylight-mcp login/.test(e.message));
  await cleanup();
});
