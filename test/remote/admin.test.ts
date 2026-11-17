import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AccountCore, accountRpc, type AccountRpc } from "../../src/remote/account-core.js";
import { ADMIN_CREDENTIAL_PATH, ADMIN_GRANTS_PATH, ADMIN_IDENTITY_PATH, handleAdmin, isAdminRequest } from "../../src/remote/admin.js";
import { bindIdentity, identityKey } from "../../src/remote/identity.js";
import type { RemoteEnv } from "../../src/remote/env.js";
import { parseConfig } from "../../src/skylight/config.js";
import { createFakeOAuth } from "../helpers/fake-oauth.js";
import { createMemoryKv } from "../helpers/memory-kv.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

const ADMIN_TOKEN = randomBytes(32).toString("base64url");
const ORIGIN = "https://skylight-mcp-staging.example.workers.dev";

function setup(env: RemoteEnv = { ADMIN_TOKEN }) {
  const core = new AccountCore({ storage: createMemoryKv(), keyB64: randomBytes(32).toString("base64"), fetch: createMockFetch([]).fetch, config: parseConfig({}), now: () => Date.now() });
  const rpc = accountRpc(core);
  const seen: Parameters<AccountRpc["setCredential"]>[0][] = [];
  const account: AccountRpc = { ...rpc, setCredential: async (c) => { seen.push(c); await rpc.setCredential(c); } };
  const fake = createFakeOAuth();
  const identities = createMemoryKv();
  const call = (path: string, init: RequestInit & { token?: string | null } = {}) => {
    const headers = new Headers(init.headers);
    const token = init.token === undefined ? ADMIN_TOKEN : init.token;
    if (token !== null) headers.set("authorization", `Bearer ${token}`);
    return handleAdmin(new Request(`${ORIGIN}${path}`, { ...init, headers }), env, { account: () => account, oauth: () => fake.oauth, identities: () => identities });
  };
  return { call, seen, fake, account, identities };
}

const CRED = { accessToken: "SKY-AT-secret", refreshToken: "SKY-RT-secret", expiresAt: Date.now() + 3_600_000, fingerprint: "fp-123" };

test("isAdminRequest accepts only the exact bearer token", async () => {
  const req = (h?: string) => new Request(ORIGIN, h === undefined ? {} : { headers: { authorization: h } });
  assert.equal(await isAdminRequest(req(`Bearer ${ADMIN_TOKEN}`), ADMIN_TOKEN), true);
  assert.equal(await isAdminRequest(req(`bearer ${ADMIN_TOKEN}`), ADMIN_TOKEN), true);
  for (const bad of [undefined, "", `Bearer ${ADMIN_TOKEN}x`, `Bearer ${ADMIN_TOKEN.slice(1)}`, `Basic ${ADMIN_TOKEN}`, ADMIN_TOKEN, `Bearer  `, `Bearer ${ADMIN_TOKEN} extra`]) {
    assert.equal(await isAdminRequest(req(bad), ADMIN_TOKEN), false, String(bad));
  }
});

test("missing or wrong admin token: a bare 401 with no detail", async () => {
  const { call, seen } = setup();
  for (const token of [null, "wrong", `${ADMIN_TOKEN}0`]) {
    const res = await call(ADMIN_CREDENTIAL_PATH, { method: "PUT", body: JSON.stringify(CRED), token });
    assert.equal(res.status, 401);
    assert.equal(await res.text(), "");
  }
  assert.equal(seen.length, 0);
});

test("without a configured ADMIN_TOKEN (or one too short) the admin routes are closed", async () => {
  for (const env of [{}, { ADMIN_TOKEN: "short" }]) {
    const res = await setup(env).call(ADMIN_CREDENTIAL_PATH, { token: "short" });
    assert.equal(res.status, 503);
  }
});

test("PUT stores the credential (fingerprint kept) and answers without echoing it", async () => {
  const { call, seen } = setup();
  const res = await call(ADMIN_CREDENTIAL_PATH, { method: "PUT", body: JSON.stringify({ ...CRED, tokenType: "Bearer", scope: "everything" }), headers: { "content-type": "application/json" } });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.ok(!text.includes("SKY-AT-secret") && !text.includes("SKY-RT-secret"));
  assert.deepEqual(JSON.parse(text), { ok: true, tokenExpiresAt: new Date(CRED.expiresAt).toISOString() });
  assert.deepEqual(seen, [{ version: 1, accessToken: "SKY-AT-secret", refreshToken: "SKY-RT-secret", fingerprint: "fp-123", expiresAt: CRED.expiresAt }]);
  const status = await call(ADMIN_CREDENTIAL_PATH);
  const s = await status.json() as Record<string, unknown>;
  assert.equal(s.loggedIn, true);
  assert.ok(!JSON.stringify(s).includes("SKY-"));
});

test("PUT without a fingerprint gets a fresh one", async () => {
  const { call, seen } = setup();
  const { fingerprint: _omit, ...rest } = CRED;
  assert.equal((await call(ADMIN_CREDENTIAL_PATH, { method: "PUT", body: JSON.stringify(rest) })).status, 200);
  assert.match(seen[0]!.fingerprint, /^[0-9a-f-]{36}$/);
});

test("a malformed credential body is refused naming fields only, never values", async () => {
  const { call, seen } = setup();
  const bodies = [
    "not json",
    JSON.stringify({ ...CRED, expiresAt: "soon" }),
    JSON.stringify({ ...CRED, accessToken: "" }),
    JSON.stringify({ ...CRED, extra: "SKY-EXTRA-secret" }),
    JSON.stringify([CRED]),
  ];
  for (const body of bodies) {
    const res = await call(ADMIN_CREDENTIAL_PATH, { method: "PUT", body });
    assert.equal(res.status, 400, body);
    const text = await res.text();
    for (const secret of ["SKY-AT-secret", "SKY-RT-secret", "SKY-EXTRA-secret", "soon"]) assert.ok(!text.includes(secret), `${body} echoed ${secret}`);
  }
  assert.equal(seen.length, 0);
});

test("an oversized body is refused before parsing", async () => {
  const { call } = setup();
  const res = await call(ADMIN_CREDENTIAL_PATH, { method: "PUT", body: JSON.stringify({ ...CRED, scope: "x".repeat(20_000) }) });
  assert.equal(res.status, 413);
});

test("DELETE removes the server's credential; GET then reports logged out", async () => {
  const { call } = setup();
  await call(ADMIN_CREDENTIAL_PATH, { method: "PUT", body: JSON.stringify(CRED) });
  assert.deepEqual(await (await call(ADMIN_CREDENTIAL_PATH, { method: "DELETE" })).json(), { removed: true });
  assert.deepEqual(await (await call(ADMIN_CREDENTIAL_PATH, { method: "DELETE" })).json(), { removed: false });
  assert.equal(((await (await call(ADMIN_CREDENTIAL_PATH)).json()) as Record<string, unknown>).loggedIn, false);
});

test("DELETE /admin/grants revokes every grant of that (lower-cased) email across pages", async () => {
  const { call, fake } = setup();
  fake.grants.set("wife@example.com", ["g1", "g2", "g3", "g4", "g5"]);
  fake.grants.set("jordan@example.com", ["j1"]);
  const res = await call(`${ADMIN_GRANTS_PATH}?email=Wife@Example.com`, { method: "DELETE" });
  assert.deepEqual(await res.json(), { email: "wife@example.com", revoked: 5 });
  assert.deepEqual(fake.revoked.map((r) => r.grantId), ["g1", "g2", "g3", "g4", "g5"]);
  assert.ok(fake.revoked.every((r) => r.userId === "wife@example.com"));
  assert.equal((await call(ADMIN_GRANTS_PATH, { method: "DELETE" })).status, 400);
  assert.equal((await call(`${ADMIN_GRANTS_PATH}?email=x`, { method: "GET" })).status, 405);
});

test("admin calls are rate-limited after authentication: 10 per 10 minutes", async () => {
  const { call } = setup();
  for (let i = 0; i < 10; i++) assert.equal((await call(ADMIN_CREDENTIAL_PATH)).status, 200, `call ${i + 1}`);
  const limited = await call(ADMIN_CREDENTIAL_PATH);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "600");
  // Unauthenticated noise does not use up the admin budget (and never reaches the account).
  assert.equal((await call(ADMIN_CREDENTIAL_PATH, { token: "wrong" })).status, 401);
});

test("unknown admin paths and methods", async () => {
  const { call } = setup();
  assert.equal((await call("/admin/other")).status, 404);
  assert.equal((await call(ADMIN_CREDENTIAL_PATH, { method: "POST", body: "{}" })).status, 405);
});

test("DELETE /admin/identity clears a family member's Google binding (lower-cased email)", async () => {
  const { call, identities } = setup();
  await bindIdentity(identities, "wife@example.com", "google-sub-w");
  assert.deepEqual(await (await call(`${ADMIN_IDENTITY_PATH}?email=Wife@Example.com`, { method: "DELETE" })).json(), { email: "wife@example.com", removed: true });
  assert.equal(identities.data.has(identityKey("wife@example.com")), false);
  assert.deepEqual(await (await call(`${ADMIN_IDENTITY_PATH}?email=wife@example.com`, { method: "DELETE" })).json(), { email: "wife@example.com", removed: false });
  assert.equal((await call(`${ADMIN_IDENTITY_PATH}?email=${encodeURIComponent("w\u0456fe@example.com")}`, { method: "DELETE" })).status, 400, "non-ASCII email");
  assert.equal((await call(ADMIN_IDENTITY_PATH, { method: "DELETE" })).status, 400);
  assert.equal((await call(`${ADMIN_IDENTITY_PATH}?email=wife@example.com`)).status, 405);
  assert.equal((await call(`${ADMIN_IDENTITY_PATH}?email=wife@example.com`, { method: "DELETE", token: "wrong" })).status, 401);
});
