import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AccountCore, accountRpc, type AccountRpc } from "../../src/remote/account-core.js";
import { REMOTE_ONLY_TOOLS } from "../../src/remote/activity-tool.js";
import type { RemoteEnv } from "../../src/remote/env.js";
import { createMcpHandler } from "../../src/remote/mcp-handler.js";
import { parseConfig } from "../../src/skylight/config.js";
import { connectTestClient } from "../helpers/test-server.js";
import { createMemoryKv } from "../helpers/memory-kv.js";
import { createMockFetch, type MockRoute } from "../helpers/mock-fetch.js";

const ORIGIN = "https://skylight-mcp-staging.example.workers.dev";
const ENV: RemoteEnv = { ALLOWED_EMAILS: "jordan@example.com,wife@example.com", SKYLIGHT_TIMEZONE: "America/New_York" };
const FRAMES: MockRoute = { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77", attributes: { household_name: "L" } }] } };

async function setup(routes: MockRoute[] = [], opts: { signedIn?: boolean; account?: (a: AccountRpc) => AccountRpc; skylightAuth?: MockRoute[] } = {}) {
  const core = new AccountCore({ storage: createMemoryKv(), keyB64: randomBytes(32).toString("base64"), fetch: createMockFetch(opts.skylightAuth ?? []).fetch, config: parseConfig({}), now: () => Date.now() });
  let account = accountRpc(core);
  if (opts.signedIn !== false) await account.setCredential({ version: 1, accessToken: "SKY-AT", refreshToken: "SKY-RT", fingerprint: "fp", expiresAt: Date.now() + 3_600_000 });
  if (opts.account) account = opts.account(account);
  const { fetch, calls } = createMockFetch(routes);
  const handler = createMcpHandler({ account: () => account, fetch, now: () => new Date("2026-10-12T16:00:00Z") });
  let id = 0;
  const rpc = async (method: string, params: unknown, who: string | null = "jordan@example.com", env: RemoteEnv = ENV) => {
    const res = await handler.fetch(new Request(`${ORIGIN}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    }), env, who === null ? {} : { props: { email: who, name: "Someone", sub: `sub-${who}` } });
    return res;
  };
  const tool = async (name: string, args: Record<string, unknown> = {}, who?: string) => {
    const res = await rpc("tools/call", { name, arguments: args }, who);
    assert.equal(res.status, 200);
    const body = await res.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    const text = body.result.content[0]!.text;
    let data: unknown = text;
    try { data = JSON.parse(text); } catch { /* text */ }
    return { isError: body.result.isError === true, data, text };
  };
  return { core, account, calls, rpc, tool, handler };
}

test("tools/list over /mcp is the stdio tool list plus skylight_recent_activity", async () => {
  const stdio = await connectTestClient([]);
  const stdioNames = (await stdio.client.listTools()).tools.map((t) => t.name);
  await stdio.close();
  const { rpc } = await setup();
  const res = await rpc("tools/list", {});
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  const names = ((await res.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
  assert.deepEqual([...names].sort(), [...stdioNames, ...REMOTE_ONLY_TOOLS].sort());
});

test("initialize works statelessly and returns the shared instructions", async () => {
  const { rpc } = await setup();
  const res = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude", version: "1" } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("mcp-session-id"), null);
  const body = await res.json() as { result: { instructions: string; serverInfo: { name: string } } };
  assert.equal(body.result.serverInfo.name, "skylight-mcp");
  assert.match(body.result.instructions, /logged with the family member who made it/);
});

test("a write tool call appends one audit entry naming who made it; a read call appends none", async () => {
  const { tool, account } = await setup([
    FRAMES,
    { method: "GET", path: "/api/frames/77/lists", json: { data: [] } },
    { method: "POST", path: "/api/frames/77/lists", json: { data: { id: "8", type: "list", attributes: { label: "Trip", kind: "to_do" } } } },
  ]);
  const read = await tool("skylight_list_lists");
  assert.equal(read.isError, false, read.text);
  assert.equal((await account.recentAudit(50)).length, 0);
  const write = await tool("skylight_create_list", { title: "Trip" }, "wife@example.com");
  assert.equal(write.isError, false, write.text);
  const log = await account.recentAudit(50);
  assert.equal(log.length, 1);
  assert.equal(log[0]!.who, "wife@example.com");
  assert.equal(log[0]!.tool, "skylight_create_list");
  assert.equal(log[0]!.ok, true);
  assert.equal(log[0]!.at, "2026-10-12T16:00:00.000Z");
  assert.ok(!JSON.stringify(log).includes("Trip"), "argument values are not logged");
});

test("Skylight calls carry the Durable Object's access token", async () => {
  const { tool, calls } = await setup([FRAMES, { method: "GET", path: "/api/frames/77/lists", json: { data: [] } }]);
  await tool("skylight_list_lists");
  assert.ok(calls.length >= 2);
  for (const c of calls) assert.equal(c.headers.get("authorization"), "Bearer SKY-AT");
});

test("skylight_recent_activity shows the log in the configured zone, newest first", async () => {
  const { tool, account } = await setup();
  await account.appendAudit({ at: "2026-10-12T16:00:00.000Z", who: "wife@example.com", tool: "skylight_create_list", targets: ["8"], ok: true });
  await account.appendAudit({ at: "2026-10-12T17:30:00.000Z", who: "jordan@example.com", tool: "skylight_delete_list", targets: ["8"], ok: true, preview: true });
  const r = await tool("skylight_recent_activity", { limit: 5 });
  assert.equal(r.isError, false, r.text);
  const data = r.data as { timezone: string; entries: Array<Record<string, unknown>> };
  assert.equal(data.timezone, "America/New_York");
  assert.deepEqual(data.entries.map((e) => e.tool), ["skylight_delete_list", "skylight_create_list"]);
  assert.match(String(data.entries[0]!.when), /1:30 PM EDT/);
  assert.equal(data.entries[0]!.preview, true);
  assert.equal(data.entries[0]!.atLocal, "2026-10-12T13:30:00-04:00");
  const tooMany = await tool("skylight_recent_activity", { limit: 51 });
  assert.equal(tooMany.isError, true);
});

test("skylight_auth_status reports the shared server's credential and the remote login hint", async () => {
  const { tool } = await setup([FRAMES]);
  const r = await tool("skylight_auth_status");
  const s = r.data as Record<string, unknown>;
  assert.equal(s.loggedIn, true);
  assert.equal(s.frameId, "77");
  assert.equal(s.loginHint, "The server owner needs to run `skylight-mcp remote login`");
  assert.ok(!r.text.includes("SKY-AT"));
});

test("a signed-out shared server answers tools with who needs to sign in", async () => {
  const { tool } = await setup([FRAMES], { signedIn: false });
  const r = await tool("skylight_list_lists");
  assert.equal(r.isError, true);
  assert.match(r.text, /The server owner needs to run `skylight-mcp remote login`/);
  const s = (await tool("skylight_auth_status")).data as Record<string, unknown>;
  assert.equal(s.loggedIn, false);
  assert.equal(s.needsLogin, true);
});

test("a Skylight refusal after refresh names the remote login command", async () => {
  const { tool } = await setup([{ method: "GET", path: "/api/frames/calendar", status: 401, text: "no" }], {
    skylightAuth: [{ method: "POST", path: "/oauth/token", json: { access_token: "SKY-AT-2", refresh_token: "SKY-RT-2", expires_in: 3600 } }],
  });
  const r = await tool("skylight_list_lists");
  assert.equal(r.isError, true);
  assert.match(r.text, /The server owner needs to run `skylight-mcp remote login`/);
  assert.doesNotMatch(r.text, /`skylight-mcp login`/);
});

test("over the rate limit: HTTP 429 with a JSON-RPC error", async () => {
  const { rpc } = await setup([], { account: (a) => ({ ...a, allow: async () => false }) });
  const res = await rpc("tools/list", {});
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "600");
  const body = await res.json() as { jsonrpc: string; error: { message: string } };
  assert.equal(body.jsonrpc, "2.0");
  assert.match(body.error.message, /300 calls per person every 10 minutes/);
});

test("someone removed from ALLOWED_EMAILS is refused even with a live token", async () => {
  const { rpc } = await setup();
  const res = await rpc("tools/list", {}, "jordan@example.com", { ...ENV, ALLOWED_EMAILS: "wife@example.com" });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /no longer on the family list/);
  const none = await rpc("tools/list", {}, null);
  assert.equal(none.status, 403);
  const unset = await rpc("tools/list", {}, "jordan@example.com", { ...ENV, ALLOWED_EMAILS: "" });
  assert.equal(unset.status, 503);
});

test("each person's calls count against their own rate limit", async () => {
  const seen: string[] = [];
  const { rpc } = await setup([], { account: (a) => ({ ...a, allow: async (who, bucket) => { seen.push(`${bucket}:${who}`); return true; } }) });
  await rpc("tools/list", {}, "Wife@Example.com");
  assert.deepEqual(seen, ["mcp:wife@example.com"]);
});

test("GET and DELETE on /mcp are 405 (stateless JSON server, no SSE stream or session)", async () => {
  const { handler } = await setup();
  for (const method of ["GET", "DELETE"]) {
    const res = await handler.fetch(new Request(`${ORIGIN}/mcp`, { method }), ENV, { props: { email: "jordan@example.com", name: "J", sub: "sub-j" } });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  }
});

test("SKYLIGHT_TOOLSETS trims the remote tool list but keeps auth status and recent activity", async () => {
  const { rpc } = await setup();
  const res = await rpc("tools/list", {}, "jordan@example.com", { ...ENV, SKYLIGHT_TOOLSETS: "lists" });
  const names = ((await res.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
  assert.ok(names.includes("skylight_auth_status"));
  assert.ok(names.includes("skylight_recent_activity"));
  assert.ok(names.includes("skylight_create_list"));
  assert.ok(!names.includes("skylight_create_chore"));
});

test("a grant without a Google sub (from before identity binding) must reconnect", async () => {
  const { handler } = await setup();
  const res = await handler.fetch(new Request(`${ORIGIN}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  }), ENV, { props: { email: "jordan@example.com", name: "J" } });
  assert.equal(res.status, 403);
  assert.match(await res.text(), /Reconnect the app/);
});
