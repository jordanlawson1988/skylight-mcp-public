import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  AccountCore, ACCOUNT_MESSAGES, AUDIT_MAX_ENTRIES, AUDIT_RETENTION_MS, RATE_LIMITS, type AuditRecord,
} from "../../src/remote/account-core.js";
import { parseConfig } from "../../src/skylight/config.js";
import { AuthError } from "../../src/skylight/errors.js";
import type { OAuthCredential } from "../../src/skylight/oauth.js";
import { createMemoryKv } from "../helpers/memory-kv.js";
import { createMockFetch, type MockRoute } from "../helpers/mock-fetch.js";

const KEY = randomBytes(32).toString("base64");
/** Near the real clock (refreshCredential stamps expiry from Date.now()), aligned to a 10-minute rate window. */
const T0 = Math.floor(Date.now() / 600_000) * 600_000;

function cred(over: Partial<OAuthCredential> = {}): OAuthCredential {
  return { version: 1, accessToken: "AT-1", refreshToken: "RT-1", fingerprint: "fp-1", expiresAt: T0 + 3_600_000, ...over };
}

function setup(routes: MockRoute[] = [], opts: { keyB64?: string; storage?: ReturnType<typeof createMemoryKv>; now?: () => number } = {}) {
  const storage = opts.storage ?? createMemoryKv();
  const { fetch, calls } = createMockFetch(routes);
  let clock = T0;
  const core = new AccountCore({ storage, keyB64: opts.keyB64 ?? KEY, fetch, config: parseConfig({}), now: opts.now ?? (() => clock) });
  return { core, storage, calls, advance: (ms: number) => { clock += ms; }, setClock: (t: number) => { clock = t; } };
}

const tokenRoute = (json: unknown, status = 200): MockRoute => ({ method: "POST", path: "/oauth/token", status, json });

test("the credential is stored encrypted (AES-GCM, fresh IV per write) and reads back", async () => {
  const { core, storage } = setup();
  await core.setCredential(cred());
  const raw = storage.data.get("credential")!;
  for (const secret of ["AT-1", "RT-1", "fp-1"]) assert.ok(!raw.includes(secret), `stored plaintext ${secret}`);
  const first = JSON.parse(raw) as { v: number; iv: string; ct: string };
  assert.equal(first.v, 1);
  assert.equal(Buffer.from(first.iv, "base64").length, 12);
  await core.setCredential(cred());
  const second = JSON.parse(storage.data.get("credential")!) as { iv: string; ct: string };
  assert.notEqual(second.iv, first.iv);
  assert.notEqual(second.ct, first.ct);
  assert.equal(await core.getAccessToken(), "AT-1");
});

test("a credential written with another key cannot be decrypted and says how to fix it", async () => {
  const storage = createMemoryKv();
  await setup([], { storage }).core.setCredential(cred());
  const other = setup([], { storage, keyB64: randomBytes(32).toString("base64") }).core;
  await assert.rejects(other.getAccessToken(), (e: unknown) => e instanceof AuthError && /stored Skylight credential cannot be decrypted; run `skylight-mcp remote login`/.test(e.message));
  const s = await other.status();
  assert.equal(s.loggedIn, false);
  assert.equal(s.needsLogin, true);
  assert.match(s.credentialError ?? "", /cannot be decrypted/);
});

test("a tampered ciphertext is refused", async () => {
  const { core, storage } = setup();
  await core.setCredential(cred());
  const enc = JSON.parse(storage.data.get("credential")!) as { v: number; iv: string; ct: string };
  const ct = Buffer.from(enc.ct, "base64");
  ct[0] = ct[0]! ^ 1;
  storage.data.set("credential", JSON.stringify({ ...enc, ct: ct.toString("base64") }));
  await assert.rejects(core.getAccessToken(), /cannot be decrypted/);
});

test("SKYLIGHT_TOKEN_KEY must decode to exactly 32 bytes", async () => {
  for (const keyB64 of ["", "short", randomBytes(16).toString("base64"), "not base64 at all!"]) {
    const { core } = setup([], { keyB64 });
    await assert.rejects(core.setCredential(cred()), /SKYLIGHT_TOKEN_KEY must be 32 random bytes, base64-encoded/, keyB64);
  }
});

test("not signed in: getAccessToken explains who signs in, status reports logged out", async () => {
  const { core } = setup();
  await assert.rejects(core.getAccessToken(), (e: unknown) => e instanceof AuthError && e.message === ACCOUNT_MESSAGES.notSignedIn);
  assert.match(ACCOUNT_MESSAGES.notSignedIn, /Jordan needs to run `skylight-mcp remote login`/);
  assert.deepEqual(await core.status(), { loggedIn: false, needsLogin: true, tokenExpiresAt: null, credentialError: null });
});

test("a token more than 60 s from expiry is used as is; within 60 s it is refreshed and the rotation stored", async () => {
  const storage = createMemoryKv();
  const { core, calls, setClock } = setup([tokenRoute({ access_token: "AT-2", refresh_token: "RT-2", expires_in: 3600 })], { storage });
  await core.setCredential(cred({ expiresAt: T0 + 61_000 }));
  assert.equal(await core.getAccessToken(), "AT-1");
  assert.equal(calls.length, 0);
  setClock(T0 + 1_001);
  assert.equal(await core.getAccessToken(), "AT-2");
  assert.equal(calls.length, 1);
  const body = calls[0]!.body as Record<string, string>;
  assert.equal(body.grant_type, "refresh_token");
  assert.equal(body.refresh_token, "RT-1");
  assert.equal(body.skylight_api_client_device_fingerprint, "fp-1");
  // The rotated refresh token is what the next refresh sends.
  const again = setup([tokenRoute({ access_token: "AT-3", refresh_token: "RT-3", expires_in: 3600 })], { storage, now: () => Date.now() + 10 * 3_600_000 });
  assert.equal(await again.core.getAccessToken(), "AT-3");
  assert.equal((again.calls[0]!.body as Record<string, string>).refresh_token, "RT-2");
});

test("a refresh response without a refresh token keeps the previous one", async () => {
  const storage = createMemoryKv();
  const first = setup([tokenRoute({ access_token: "AT-2", expires_in: 3600 })], { storage });
  await first.core.setCredential(cred({ expiresAt: T0 - 1 }));
  assert.equal(await first.core.getAccessToken(), "AT-2");
  const second = setup([tokenRoute({ access_token: "AT-3", expires_in: 3600 })], { storage, now: () => T0 + 10 * 3_600_000 });
  assert.equal(await second.core.getAccessToken(), "AT-3");
  assert.equal((second.calls[0]!.body as Record<string, string>).refresh_token, "RT-1");
});

test("concurrent callers share one refresh request", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let requests = 0;
  const storage = createMemoryKv();
  const { fetch: inner } = createMockFetch([tokenRoute({ access_token: "AT-2", refresh_token: "RT-2", expires_in: 3600 })]);
  const fetch = (async (input: string | URL, init?: RequestInit) => { requests += 1; await gate; return inner(input, init); }) as typeof globalThis.fetch;
  const core = new AccountCore({ storage, keyB64: KEY, fetch, config: parseConfig({}), now: () => T0 });
  await core.setCredential(cred({ expiresAt: T0 - 1 }));
  const calls = [core.getAccessToken(), core.getAccessToken(), core.refreshAfterRejection("AT-1"), core.getAccessToken(), core.refreshAfterRejection("AT-1")];
  await new Promise((r) => setTimeout(r, 20));
  release();
  assert.deepEqual(await Promise.all(calls), ["AT-2", "AT-2", "AT-2", "AT-2", "AT-2"]);
  assert.equal(requests, 1);
  assert.equal(await core.getAccessToken(), "AT-2");
  assert.equal(requests, 1);
});

test("refreshAfterRejection refreshes only when the stored token is the rejected one", async () => {
  const { core, calls } = setup([tokenRoute({ access_token: "AT-2", refresh_token: "RT-2", expires_in: 3600 })]);
  await core.setCredential(cred());
  assert.equal(await core.refreshAfterRejection("SOMETHING-OLDER"), "AT-1");
  assert.equal(calls.length, 0);
  assert.equal(await core.refreshAfterRejection("AT-1"), "AT-2");
  assert.equal(calls.length, 1);
  assert.equal(await core.refreshAfterRejection("AT-1"), "AT-2");
  assert.equal(calls.length, 1);
});

test("invalid_grant (400 or 401) marks needsLogin, keeps the credential and stops further refresh attempts", async () => {
  for (const status of [400, 401]) {
    const { core, calls, storage } = setup([tokenRoute({ error: "invalid_grant" }, status)]);
    await core.setCredential(cred({ expiresAt: T0 - 1 }));
    await assert.rejects(core.getAccessToken(), (e: unknown) => e instanceof AuthError && e.message === ACCOUNT_MESSAGES.expired);
    assert.equal(ACCOUNT_MESSAGES.expired, "Skylight sign-in for the shared server expired; Jordan needs to run `skylight-mcp remote login`.");
    assert.ok(storage.data.has("credential"), "the credential is not cleared");
    const s = await core.status();
    assert.equal(s.loggedIn, true);
    assert.equal(s.needsLogin, true);
    await assert.rejects(core.getAccessToken(), (e: unknown) => e instanceof AuthError && e.message === ACCOUNT_MESSAGES.expired);
    await assert.rejects(core.refreshAfterRejection("AT-1"), (e: unknown) => e instanceof AuthError && e.message === ACCOUNT_MESSAGES.expired);
    assert.equal(calls.length, 1, "no second refresh after invalid_grant");
  }
});

test("a new credential clears needsLogin", async () => {
  const { core } = setup([tokenRoute({ error: "invalid_grant" }, 400)]);
  await core.setCredential(cred({ expiresAt: T0 - 1 }));
  await assert.rejects(core.getAccessToken());
  await core.setCredential(cred({ accessToken: "AT-NEW", refreshToken: "RT-NEW" }));
  assert.equal((await core.status()).needsLogin, false);
  assert.equal(await core.getAccessToken(), "AT-NEW");
});

test("a transient refresh failure names the remote login command and does not mark needsLogin", async () => {
  const { core } = setup([{ method: "POST", path: "/oauth/token", status: 503, text: "down" }]);
  await core.setCredential(cred({ expiresAt: T0 - 1 }));
  await assert.rejects(core.getAccessToken(), (e: unknown) => e instanceof AuthError && /503/.test(e.message) && /skylight-mcp remote login/.test(e.message) && !/`skylight-mcp login`/.test(e.message));
  assert.equal((await core.status()).needsLogin, false);
});

test("a credential set while a refresh is in flight is not overwritten by that refresh", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const { fetch: inner } = createMockFetch([tokenRoute({ access_token: "AT-OLDGRANT", refresh_token: "RT-OLDGRANT", expires_in: 3600 })]);
  const fetch = (async (input: string | URL, init?: RequestInit) => { await gate; return inner(input, init); }) as typeof globalThis.fetch;
  const core = new AccountCore({ storage: createMemoryKv(), keyB64: KEY, fetch, config: parseConfig({}), now: () => T0 });
  await core.setCredential(cred({ expiresAt: T0 - 1 }));
  const pending = core.getAccessToken();
  await new Promise((r) => setTimeout(r, 10));
  await core.setCredential(cred({ accessToken: "AT-NEWGRANT", refreshToken: "RT-NEWGRANT" }));
  release();
  assert.equal(await pending, "AT-NEWGRANT");
  assert.equal(await core.getAccessToken(), "AT-NEWGRANT");
});

test("setCredential refuses a malformed credential", async () => {
  const { core } = setup();
  for (const bad of [{ ...cred(), accessToken: "" }, { ...cred(), refreshToken: 5 }, { ...cred(), expiresAt: Number.NaN }, { ...cred(), version: 2 }, { ...cred(), fingerprint: "" }]) {
    await assert.rejects(core.setCredential(bad as unknown as OAuthCredential), /credential/i);
  }
});

test("clearCredential removes the credential and the needsLogin flag", async () => {
  const { core, storage } = setup();
  assert.equal(await core.clearCredential(), false);
  await core.setCredential(cred());
  storage.data.set("needs-login", "1");
  assert.equal(await core.clearCredential(), true);
  assert.equal(storage.data.has("credential"), false);
  assert.equal(storage.data.has("needs-login"), false);
  assert.equal((await core.status()).loggedIn, false);
});

test("status reports expiry in UTC and never a token", async () => {
  const { core } = setup();
  await core.setCredential(cred());
  const s = await core.status();
  assert.deepEqual(s, { loggedIn: true, needsLogin: false, tokenExpiresAt: new Date(T0 + 3_600_000).toISOString(), credentialError: null });
  assert.ok(!JSON.stringify(s).includes("AT-1") && !JSON.stringify(s).includes("RT-1"));
});

const entry = (over: Partial<AuditRecord> = {}): AuditRecord => ({ at: new Date(T0).toISOString(), who: "jordan@example.com", tool: "skylight_create_list", targets: [], ok: true, ...over });

test("audit entries come back newest first, limited", async () => {
  const { core } = setup();
  for (let i = 0; i < 5; i++) await core.appendAudit(entry({ at: new Date(T0 + i * 1000).toISOString(), targets: [String(i)] }));
  const recent = await core.recentAudit(3);
  assert.deepEqual(recent.map((e) => e.targets[0]), ["4", "3", "2"]);
  assert.equal((await core.recentAudit(50)).length, 5);
  assert.equal((await core.recentAudit(0)).length, 0);
});

test("audit keeps only the known fields: no argument values, no tokens", async () => {
  const { core } = setup();
  const sneaky = { ...entry({ targets: ["5", "not an id!", "6"], error: 'x {"access_token":"SECRET"} Bearer abc.def' }), args: { title: "Milk" }, token: "AT-1" } as unknown as AuditRecord;
  await core.appendAudit({ ...sneaky, ok: false });
  const [stored] = await core.recentAudit(1);
  assert.deepEqual(Object.keys(stored!).sort(), ["at", "error", "ok", "targets", "tool", "who"]);
  assert.deepEqual(stored!.targets, ["5", "6"]);
  assert.ok(!stored!.error!.includes("SECRET"));
  assert.ok(!stored!.error!.includes("abc.def"));
  assert.ok(!JSON.stringify(stored).includes("Milk"));
});

test("audit entries older than 90 days are pruned on append", async () => {
  const { core, setClock, storage } = setup();
  await core.appendAudit(entry({ at: new Date(T0).toISOString(), tool: "old" }));
  await core.appendAudit(entry({ at: new Date(T0 + 1000).toISOString(), tool: "old2" }));
  setClock(T0 + AUDIT_RETENTION_MS + 5000);
  await core.appendAudit(entry({ at: new Date(T0 + AUDIT_RETENTION_MS + 5000).toISOString(), tool: "new" }));
  assert.deepEqual((await core.recentAudit(50)).map((e) => e.tool), ["new"]);
  assert.equal([...storage.data.keys()].filter((k) => /^audit:\d+$/.test(k)).length, 1);
});

test("the audit log is capped at AUDIT_MAX_ENTRIES even within 90 days", async () => {
  const { core, storage } = setup();
  for (let i = 0; i < AUDIT_MAX_ENTRIES + 3; i++) await core.appendAudit(entry({ targets: [String(i)] }));
  assert.equal([...storage.data.keys()].filter((k) => /^audit:\d+$/.test(k)).length, AUDIT_MAX_ENTRIES);
  assert.equal((await core.recentAudit(1))[0]!.targets[0], String(AUDIT_MAX_ENTRIES + 2));
});

test("concurrent audit appends all land", async () => {
  const { core } = setup();
  await Promise.all(Array.from({ length: 20 }, (_, i) => core.appendAudit(entry({ targets: [String(i)] }))));
  assert.equal((await core.recentAudit(50)).length, 20);
});

test("rate limits: 300 MCP calls per user per 10 minutes, 10 admin calls, separate buckets and users, new window resets", async () => {
  assert.deepEqual(RATE_LIMITS, { mcp: { limit: 300, windowMs: 600_000 }, admin: { limit: 10, windowMs: 600_000 } });
  const { core, setClock } = setup();
  setClock(T0 - (T0 % 600_000));
  for (let i = 0; i < 300; i++) assert.equal(await core.allow("a@example.com", "mcp"), true, `call ${i + 1}`);
  assert.equal(await core.allow("a@example.com", "mcp"), false);
  assert.equal(await core.allow("b@example.com", "mcp"), true);
  for (let i = 0; i < 10; i++) assert.equal(await core.allow("admin", "admin"), true);
  assert.equal(await core.allow("admin", "admin"), false);
  setClock(T0 - (T0 % 600_000) + 600_000);
  assert.equal(await core.allow("a@example.com", "mcp"), true);
  assert.equal(await core.allow("admin", "admin"), true);
});

test("concurrent rate-limit checks never let more through than the limit", async () => {
  const { core } = setup();
  const results = await Promise.all(Array.from({ length: 15 }, () => core.allow("admin", "admin")));
  assert.equal(results.filter(Boolean).length, 10);
});
