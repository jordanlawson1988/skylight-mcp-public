import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  ADMIN_KEYCHAIN_SERVICE, normalizeServerUrl, parseRemoteArgs, readAdminToken, readRemoteConfig, REMOTE_COMMANDS, runRemote, storeAdminToken,
  type RemoteDeps,
} from "../../src/cli/remote.js";
import { GENERATED_SECRETS } from "../../src/remote/env.js";
import { createRuntime } from "../../src/runtime.js";
import { createFakeKeychain } from "../helpers/fake-keychain.js";
import { createMockFetch, type MockRoute } from "../helpers/mock-fetch.js";
import { makeTmpDir } from "../helpers/tmp-dir.js";

const URL_STAGING = "https://skylight-mcp-staging.example.workers.dev";

async function setup(routes: MockRoute[] = [], answers: Array<string | null> = []) {
  const { dir, cleanup } = await makeTmpDir();
  const keychain = createFakeKeychain();
  const { fetch, calls } = createMockFetch(routes);
  const rt = createRuntime({ env: { SKYLIGHT_CREDENTIALS_DIR: path.join(dir, "credentials") }, fetch, runner: keychain.runner });
  const out: string[] = [];
  const wranglerCalls: Array<{ args: string[]; stdin: string }> = [];
  let wranglerCode = 0;
  const configPath = path.join(dir, "app", "remote.json");
  const deps: RemoteDeps = {
    rt, runner: keychain.runner, configPath,
    wrangler: async (args, stdin) => { wranglerCalls.push({ args, stdin }); return { code: wranglerCode }; },
    io: { write: (t) => { out.push(t); }, ask: async (p) => { out.push(p); return answers.length > 0 ? answers.shift()! : null; } },
    find: async () => {
      const pending = await rt.store.readPendingLogin();
      return pending ? `https://ourskylight.com/welcome?code=SKY-CODE&state=${pending.state}` : null;
    },
  };
  return {
    deps, rt, calls, keychain, out, wranglerCalls, configPath, dir, cleanup,
    failWrangler: (code: number) => { wranglerCode = code; },
    text: () => out.join(""),
    run: (...argv: string[]) => runRemote(argv, deps),
  };
}

/** Everything a secret could have leaked into: printed output, remote.json, and every file under the temp dir we know of. */
async function assertNoLeak(t: Awaited<ReturnType<typeof setup>>, secrets: string[]) {
  const config = await readFile(t.configPath, "utf8").catch(() => "");
  for (const s of secrets) {
    assert.ok(!t.text().includes(s), "a secret was printed");
    assert.ok(!config.includes(s), "a secret was written to remote.json");
  }
}

const adminRoutes = (over: Partial<MockRoute> = {}): MockRoute[] => [
  { method: "GET", path: "/admin/skylight-credential", json: { loggedIn: true, needsLogin: false, tokenExpiresAt: "2026-10-13T18:05:00.000Z", credentialError: null }, ...over },
  { method: "PUT", path: "/admin/skylight-credential", json: { ok: true, tokenExpiresAt: "2026-10-13T18:05:00.000Z" } },
  { method: "DELETE", path: "/admin/skylight-credential", json: { removed: true } },
  { method: "DELETE", path: "/admin/grants", json: { email: "wife@example.com", revoked: 2 } },
];

async function withServer(t: Awaited<ReturnType<typeof setup>>, token = "ADMIN-TOKEN-0123456789abcdefghijklmnopqrstuv") {
  await t.run("setup", "--env", "staging", "--url", URL_STAGING);
  await storeAdminToken(t.keychain.runner, URL_STAGING, token);
  t.out.length = 0;
  t.wranglerCalls.length = 0;
  return token;
}

test("parseRemoteArgs needs --env staging or production and reads --url and the revoke email", () => {
  assert.deepEqual(parseRemoteArgs(["setup", "--env", "staging", "--url", URL_STAGING]), { sub: "setup", env: "staging", url: URL_STAGING, pkce: "S256" });
  assert.equal(parseRemoteArgs(["revoke", "Wife@Example.com", "--env", "production"]).email, "Wife@Example.com");
  assert.throws(() => parseRemoteArgs(["status"]), /--env staging or --env production/);
  assert.throws(() => parseRemoteArgs(["status", "--env", "prod"]), /staging or production/);
  assert.throws(() => parseRemoteArgs(["setup", "--env", "staging", "--url"]), /--url needs/);
  assert.deepEqual([...REMOTE_COMMANDS], ["setup", "login", "status", "logout", "revoke"]);
});

test("normalizeServerUrl keeps the https origin, accepts a trailing /mcp, refuses anything else", () => {
  assert.equal(normalizeServerUrl(`${URL_STAGING}/`), URL_STAGING);
  assert.equal(normalizeServerUrl(`${URL_STAGING}/mcp`), URL_STAGING);
  assert.equal(normalizeServerUrl("http://127.0.0.1:8787"), "http://127.0.0.1:8787");
  for (const bad of ["http://example.workers.dev", "https://u:p@example.workers.dev", "https://x.workers.dev/admin", "https://x.workers.dev/?a=1", "nope"]) {
    assert.throws(() => normalizeServerUrl(bad), Error, bad);
  }
});

test("setup saves the URL (0600), uploads both generated secrets through wrangler's stdin and keeps the admin token in the Keychain", async () => {
  const t = await setup();
  assert.equal(await t.run("setup", "--env", "staging", "--url", `${URL_STAGING}/mcp`), 0);
  assert.deepEqual(await readRemoteConfig(t.configPath), { staging: URL_STAGING });
  assert.equal((await stat(t.configPath)).mode & 0o777, 0o600);
  assert.deepEqual(t.wranglerCalls.map((c) => c.args), GENERATED_SECRETS.map((name) => ["secret", "put", name, "--env", "staging"]));
  const [key, admin] = t.wranglerCalls.map((c) => c.stdin);
  assert.equal(Buffer.from(key!, "base64").length, 32);
  assert.match(admin!, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(key, admin);
  assert.equal(await readAdminToken(t.keychain.runner, URL_STAGING), admin);
  assert.ok([...t.keychain.items.keys()].includes(`${URL_STAGING}|${ADMIN_KEYCHAIN_SERVICE}`));
  assert.ok(![...t.keychain.items.values()].includes(key!), "the token key is not kept on the Mac");
  await assertNoLeak(t, [key!, admin!]);
  const text = t.text();
  assert.ok(text.includes(`${URL_STAGING}/callback`));
  assert.ok(text.includes(`${URL_STAGING}/mcp`));
  for (const name of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ALLOWED_EMAILS"]) assert.ok(text.includes(`npx wrangler secret put ${name} --env staging`), name);
  await t.cleanup();
});

test("setup keeps other environments' URLs, and running it again replaces both secrets", async () => {
  const t = await setup();
  await t.run("setup", "--env", "production", "--url", "https://skylight-mcp.example.workers.dev");
  await t.run("setup", "--env", "staging", "--url", URL_STAGING);
  assert.deepEqual(await readRemoteConfig(t.configPath), { production: "https://skylight-mcp.example.workers.dev", staging: URL_STAGING });
  const first = t.wranglerCalls.filter((c) => c.args.includes("staging")).map((c) => c.stdin);
  await t.run("setup", "--env", "staging");
  const second = t.wranglerCalls.filter((c) => c.args.includes("staging")).slice(2).map((c) => c.stdin);
  assert.notDeepEqual(second, first);
  assert.equal(await readAdminToken(t.keychain.runner, URL_STAGING), second[1]);
  await t.cleanup();
});

test("setup without a URL, or with wrangler failing, stops with a clear message and stores no admin token", async () => {
  const t = await setup();
  await assert.rejects(t.run("setup", "--env", "staging"), /Pass --url/);
  t.failWrangler(1);
  await assert.rejects(t.run("setup", "--env", "staging", "--url", URL_STAGING), /wrangler secret put SKYLIGHT_TOKEN_KEY --env staging` failed \(exit 1\)/);
  assert.equal(t.wranglerCalls.length, 1, "stops at the first failure");
  await assert.rejects(readAdminToken(t.keychain.runner, URL_STAGING), /No admin token/);
  await t.cleanup();
});

test("remote login signs the server in with its own grant: PUT with the admin bearer, the Mac's credential untouched", async () => {
  const t = await setup([
    { method: "POST", path: "/oauth/token", json: { access_token: "SKY-REMOTE-AT", refresh_token: "SKY-REMOTE-RT", expires_in: 7200 } },
    ...adminRoutes(),
  ], [""]);
  const token = await withServer(t);
  assert.equal(await t.run("login", "--env", "staging"), 0);
  const admin = t.calls.filter((c) => c.url.pathname === "/admin/skylight-credential");
  assert.deepEqual(admin.map((c) => c.method), ["GET", "PUT"]);
  for (const c of admin) {
    assert.equal(c.url.origin, URL_STAGING);
    assert.equal(c.headers.get("authorization"), `Bearer ${token}`);
  }
  const body = admin[1]!.body as Record<string, unknown>;
  assert.equal(body.accessToken, "SKY-REMOTE-AT");
  assert.equal(body.refreshToken, "SKY-REMOTE-RT");
  assert.match(String(body.fingerprint), /^[0-9a-f-]{36}$/);
  assert.ok(Number(body.expiresAt) > Date.now());
  assert.equal(await t.rt.store.read(), null, "the Mac's own credential store stays empty");
  assert.equal(await t.rt.store.readPendingLogin(), null);
  assert.deepEqual([...t.keychain.items.keys()], [`${URL_STAGING}|${ADMIN_KEYCHAIN_SERVICE}`], "only the admin token is in the Keychain");
  assert.match(t.text(), /Shared server signed in to Skylight\. Token valid until /);
  await assertNoLeak(t, [token, "SKY-REMOTE-AT", "SKY-REMOTE-RT", "SKY-CODE"]);
  await t.cleanup();
});

test("remote login leaves an existing Mac login exactly as it was", async () => {
  const t = await setup([
    { method: "POST", path: "/oauth/token", json: { access_token: "SKY-REMOTE-AT", refresh_token: "SKY-REMOTE-RT", expires_in: 7200 } },
    ...adminRoutes(),
  ], [""]);
  await withServer(t);
  await t.rt.store.write({ version: 1, accessToken: "MAC-AT", refreshToken: "MAC-RT", fingerprint: "mac-fp", expiresAt: 42 });
  const before = new Map(t.keychain.items);
  await t.run("login", "--env", "staging");
  assert.deepEqual(await t.rt.store.read(), { version: 1, accessToken: "MAC-AT", refreshToken: "MAC-RT", fingerprint: "mac-fp", expiresAt: 42 });
  assert.deepEqual(t.keychain.items, before);
  await t.cleanup();
});

test("remote login checks the server first: a refused admin token stops it before any Skylight sign-in", async () => {
  const t = await setup([{ method: "GET", path: "/admin/skylight-credential", status: 401, text: "" }]);
  await withServer(t);
  await assert.rejects(t.run("login", "--env", "staging"), /answered 401: the server refused the admin token/);
  assert.equal(await t.rt.store.readPendingLogin(), null, "no Skylight sign-in was started");
  await t.cleanup();
});

test("HTTP errors name the status only, never a response body that might echo a secret", async () => {
  const t = await setup([
    { method: "POST", path: "/oauth/token", json: { access_token: "SKY-REMOTE-AT", refresh_token: "SKY-REMOTE-RT", expires_in: 7200 } },
    { method: "GET", path: "/admin/skylight-credential", json: {} },
    { method: "PUT", path: "/admin/skylight-credential", status: 400, text: '{"echo":"SKY-REMOTE-RT","token":"ADMIN-TOKEN"}' },
  ], [""]);
  const token = await withServer(t);
  await assert.rejects(t.run("login", "--env", "staging"), (e: unknown) => {
    const m = e instanceof Error ? e.message : "";
    assert.match(m, /answered 400/);
    for (const s of ["SKY-REMOTE-RT", "SKY-REMOTE-AT", token, "echo"]) assert.ok(!m.includes(s), `error leaked ${s}`);
    return true;
  });
  await t.cleanup();
});

test("a network failure is reported without the admin token", async () => {
  const t = await setup();
  const token = await withServer(t);
  t.deps.rt.fetch = (async () => { throw new Error(`connect failed with Bearer ${token}`); }) as typeof fetch;
  await assert.rejects(t.run("status", "--env", "staging"), (e: unknown) => e instanceof Error && /Could not reach the staging server/.test(e.message) && !e.message.includes(token));
  await t.cleanup();
});

test("remote status prints the server's sign-in with URLs, never a token", async () => {
  const t = await setup(adminRoutes());
  const token = await withServer(t);
  assert.equal(await t.run("status", "--env", "staging"), 0);
  const printed = JSON.parse(t.text()) as Record<string, unknown>;
  assert.equal(printed.url, URL_STAGING);
  assert.equal(printed.mcpUrl, `${URL_STAGING}/mcp`);
  assert.equal(printed.loggedIn, true);
  assert.match(String(printed.tokenExpiresWhen), /Oct 13/);
  await assertNoLeak(t, [token]);
  await t.cleanup();
});

test("remote logout asks first and only deletes on yes", async () => {
  const t = await setup(adminRoutes(), ["n", "y"]);
  await withServer(t);
  await t.run("logout", "--env", "staging");
  assert.equal(t.calls.filter((c) => c.method === "DELETE").length, 0);
  assert.match(t.text(), /Nothing removed/);
  await t.run("logout", "--env", "staging");
  assert.equal(t.calls.filter((c) => c.method === "DELETE").length, 1);
  assert.match(t.text(), /Removed the shared server's Skylight sign-in/);
  await t.cleanup();
});

test("remote revoke disconnects a family member's apps by lower-cased email", async () => {
  const t = await setup(adminRoutes());
  await withServer(t);
  await t.run("revoke", "Wife@Example.com", "--env", "staging");
  const call = t.calls.find((c) => c.url.pathname === "/admin/grants")!;
  assert.equal(call.method, "DELETE");
  assert.equal(call.url.searchParams.get("email"), "wife@example.com");
  assert.match(t.text(), /Revoked 2 connections for wife@example\.com/);
  await assert.rejects(t.run("revoke", "--env", "staging"), /Usage: skylight-mcp remote revoke <email>/);
  await t.cleanup();
});

test("commands for an environment that was never set up say how to set it up", async () => {
  const t = await setup();
  await assert.rejects(t.run("status", "--env", "production"), /remote setup --env production --url/);
  await t.cleanup();
});

test("remote with no or unknown subcommand prints the usage", async () => {
  const t = await setup();
  assert.equal(await t.run(), 2);
  assert.match(t.text(), /skylight-mcp remote setup --env staging\|production/);
  await assert.rejects(t.run("frobnicate", "--env", "staging"), /Unknown remote command "frobnicate"/);
  await t.cleanup();
});
