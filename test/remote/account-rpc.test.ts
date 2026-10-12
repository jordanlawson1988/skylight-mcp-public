import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AccountCore, ACCOUNT_MESSAGES, accountRpc, kvFromStorage, tokenResult, unwrapToken } from "../../src/remote/account-core.js";
import { configFromEnv, GENERATED_SECRETS, REMOTE_SECRETS, secretValues } from "../../src/remote/env.js";
import { parseConfig } from "../../src/skylight/config.js";
import { AuthError, ValidationError } from "../../src/skylight/errors.js";
import { createMemoryKv } from "../helpers/memory-kv.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

test("the RPC surface turns AuthErrors into values and back, and lets other errors through", async () => {
  assert.deepEqual(await tokenResult(async () => "AT"), { ok: true, token: "AT" });
  assert.deepEqual(await tokenResult(async () => { throw new AuthError("sign in again"); }), { ok: false, error: "sign in again" });
  await assert.rejects(tokenResult(async () => { throw new TypeError("bug"); }), TypeError);
  assert.equal(unwrapToken({ ok: true, token: "AT" }), "AT");
  assert.throws(() => unwrapToken({ ok: false, error: "sign in again" }), (e: unknown) => e instanceof AuthError && e.message === "sign in again");
});

test("accountRpc exposes AccountCore over plain values", async () => {
  const core = new AccountCore({ storage: createMemoryKv(), keyB64: randomBytes(32).toString("base64"), fetch: createMockFetch([]).fetch, config: parseConfig({}), now: () => Date.now() });
  const rpc = accountRpc(core);
  assert.deepEqual(await rpc.getAccessToken(), { ok: false, error: ACCOUNT_MESSAGES.notSignedIn });
  await rpc.setCredential({ version: 1, accessToken: "AT-1", refreshToken: "RT-1", fingerprint: "fp", expiresAt: Date.now() + 3_600_000 });
  assert.deepEqual(await rpc.getAccessToken(), { ok: true, token: "AT-1" });
  assert.deepEqual(await rpc.refreshAfterRejection("OTHER"), { ok: true, token: "AT-1" });
  assert.equal((await rpc.status()).loggedIn, true);
  await rpc.appendAudit({ at: new Date().toISOString(), who: "a@example.com", tool: "skylight_create_list", targets: [], ok: true });
  assert.equal((await rpc.recentAudit(5)).length, 1);
  assert.equal(await rpc.allow("a@example.com", "mcp"), true);
  assert.equal(await rpc.clearCredential(), true);
  assert.deepEqual(await rpc.getAccessToken(), { ok: false, error: ACCOUNT_MESSAGES.notSignedIn });
});

test("kvFromStorage maps Durable Object storage (undefined when absent) onto KvLike", async () => {
  const map = new Map<string, unknown>();
  const kv = kvFromStorage({
    get: async (k) => map.get(k),
    put: async (k, v) => { map.set(k, v); },
    delete: async (k) => map.delete(k),
  });
  assert.equal(await kv.get("a"), null);
  await kv.put("a", "1");
  assert.equal(await kv.get("a"), "1");
  map.set("b", 5);
  assert.equal(await kv.get("b"), null);
  await kv.delete("a");
  assert.equal(await kv.get("a"), null);
});

test("configFromEnv reads only the SKYLIGHT_* settings from the Worker env, ignoring bindings and secrets", () => {
  const env = { SKYLIGHT_TIMEZONE: "America/Chicago", SKYLIGHT_TOOLSETS: "lists,chores", SKYLIGHT_TOKEN_KEY: "k".repeat(44), ADMIN_TOKEN: "t".repeat(43), OAUTH_KV: {}, SKYLIGHT_ACCOUNT: {} };
  const config = configFromEnv(env);
  assert.equal(config.timezone, "America/Chicago");
  assert.deepEqual([...config.toolsets].sort(), ["chores", "lists"]);
  assert.equal(config.apiBaseUrl, "https://app.ourskylight.com");
  assert.throws(() => configFromEnv({ SKYLIGHT_TOOLSETS: "gizmos" }), ValidationError);
});

test("the secret list is complete and the generated ones are a subset; secretValues masks only real values", () => {
  assert.deepEqual([...REMOTE_SECRETS], ["SKYLIGHT_TOKEN_KEY", "ADMIN_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ALLOWED_EMAILS"]);
  for (const s of GENERATED_SECRETS) assert.ok((REMOTE_SECRETS as readonly string[]).includes(s));
  assert.deepEqual(secretValues({ ADMIN_TOKEN: "admin-token-123", GOOGLE_CLIENT_SECRET: "gsecret-456789", SKYLIGHT_TOKEN_KEY: "", GOOGLE_CLIENT_ID: "public-id" }), ["admin-token-123", "gsecret-456789"]);
});
