import { test } from "node:test";
import assert from "node:assert/strict";
import { startLogin, completeLogin, logout, status } from "../../src/cli/commands.js";
import { createRuntime, assertMacOS } from "../../src/runtime.js";
import { createFakeKeychain } from "../helpers/fake-keychain.js";
import { createMockFetch, type MockRoute } from "../helpers/mock-fetch.js";
import { makeTmpDir } from "../helpers/tmp-dir.js";

async function rt(routes: MockRoute[]) {
  const { dir, cleanup } = await makeTmpDir();
  const { runner, items } = createFakeKeychain();
  const { fetch, calls } = createMockFetch(routes);
  const runtime = createRuntime({ env: { SKYLIGHT_CREDENTIALS_DIR: dir }, fetch, runner });
  return { runtime, calls, items, cleanup };
}

test("assertMacOS", () => {
  assertMacOS("darwin");
  assert.throws(() => assertMacOS("linux"), /macOS only/);
});

test("login start writes pending file; complete exchanges, stores, clears pending", async () => {
  const { runtime, calls, cleanup } = await rt([
    { method: "POST", path: "/oauth/token", json: { access_token: "AT", refresh_token: "RT", expires_in: 3600 } },
  ]);
  const { url } = await startLogin(runtime);
  const state = new URL(url).searchParams.get("state")!;
  assert.ok(await runtime.store.readPendingLogin());
  const r = await completeLogin(runtime, `https://ourskylight.com/welcome?code=C&state=${state}`);
  assert.ok(r.expiresAt > Date.now());
  assert.equal((await runtime.store.read())!.accessToken, "AT");
  assert.equal(await runtime.store.readPendingLogin(), null);
  assert.equal((calls[0]!.body as Record<string, string>).code_verifier!.length >= 43, true);
  await cleanup();
});

test("completeLogin with no pending login fails clearly", async () => {
  const { runtime, cleanup } = await rt([]);
  await assert.rejects(completeLogin(runtime, "https://ourskylight.com/welcome?code=C&state=S"), /skylight-mcp login/);
  await cleanup();
});

test("status reports logged out, then logged in with frame", async () => {
  const { runtime, cleanup } = await rt([
    { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77", attributes: { household_name: "L" } }] } },
  ]);
  let s = await status(runtime);
  assert.equal(s.loggedIn, false);
  assert.equal(s.apiHost, "app.ourskylight.com");
  await runtime.store.write({ version: 1, accessToken: "AT", refreshToken: "RT", fingerprint: "f", expiresAt: Date.now() + 10_000_000 });
  s = await status(runtime);
  assert.equal(s.loggedIn, true);
  assert.equal(s.frameId, "77");
  assert.ok(s.tokenExpiresAt);
  assert.ok(!JSON.stringify(s).includes("AT"));
  await cleanup();
});

test("status surfaces credential read failures instead of reporting logged out", async () => {
  const { runtime, items, cleanup } = await rt([]);
  await runtime.store.write({ version: 1, accessToken: "AT", refreshToken: "RT", fingerprint: "f", expiresAt: Date.now() + 10_000_000 });
  for (const k of items.keys()) items.set(k, Buffer.alloc(32, 7).toString("base64"));
  const s = await status(runtime);
  assert.equal(s.loggedIn, false);
  assert.match(s.credentialError ?? "", /could not be decrypted/);
  assert.equal(s.frameId, null);
  const clean = await status((await rt([])).runtime);
  assert.equal(clean.credentialError, null);
  await cleanup();
});

test("status flags needsLogin when a refresh is rejected", async () => {
  const { runtime, cleanup } = await rt([{ method: "POST", path: "/oauth/token", status: 400, text: '{"error":"invalid_grant"}' }]);
  await runtime.store.write({ version: 1, accessToken: "AT", refreshToken: "RT", fingerprint: "f", expiresAt: Date.now() - 1000 });
  const s = await status(runtime);
  assert.equal(s.loggedIn, true);
  assert.equal(s.needsLogin, true);
  assert.equal(s.frameId, null);
  assert.match(s.frameError ?? "", /skylight-mcp login/);
  await cleanup();
});

test("status needsLogin is false when logged in and the frame resolves, true when logged out", async () => {
  const { runtime, cleanup } = await rt([{ method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77" }] } }]);
  assert.equal((await status(runtime)).needsLogin, true);
  await runtime.store.write({ version: 1, accessToken: "AT", refreshToken: "RT", fingerprint: "f", expiresAt: Date.now() + 10_000_000 });
  assert.equal((await status(runtime)).needsLogin, false);
  await cleanup();
});

test("logout removes credential", async () => {
  const { runtime, cleanup } = await rt([]);
  assert.equal(await logout(runtime), false);
  await runtime.store.write({ version: 1, accessToken: "AT", refreshToken: "RT", fingerprint: "f", expiresAt: 1 });
  assert.equal(await logout(runtime), true);
  assert.equal(await runtime.store.read(), null);
  await cleanup();
});
