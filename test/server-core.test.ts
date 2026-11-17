import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server-core.js";
import { auditEntry, auditTargets, MAX_AUDIT_TARGETS } from "../src/tools/audit.js";
import { createServer as stdioCreateServer } from "../src/server.js";
import { createClient } from "../src/skylight/client.js";
import { parseConfig } from "../src/skylight/config.js";
import { createFrameResolver } from "../src/skylight/frame.js";
import { LOGIN_HINTS } from "../src/skylight/status.js";
import type { AuditEntry, ToolContext } from "../src/tools/context.js";
import { connectTestClient } from "./helpers/test-server.js";
import { createMockFetch, type MockRoute } from "./helpers/mock-fetch.js";

/** A ToolContext like the Worker's: no Mac store, a token provider from elsewhere, an audit sink. */
function fakeRemoteCtx(routes: MockRoute[], env: Record<string, string> = {}) {
  const config = parseConfig(env);
  const { fetch, calls } = createMockFetch(routes);
  const tokens = { getAccessToken: async () => "AT", refreshAfterRejection: async () => "AT" };
  const client = createClient({ fetch, config, tokens, sleep: async () => {} });
  const frames = createFrameResolver({ client, configuredFrameId: config.frameId });
  const audits: AuditEntry[] = [];
  const ctx: ToolContext = {
    config, client, frames, now: () => new Date("2026-10-12T12:00:00Z"),
    authStatus: async () => ({ loggedIn: true, needsLogin: false, apiHost: "app.ourskylight.com", tokenExpiresAt: null, tokenExpiresAtLocal: null, tokenExpiresWhen: null, timezone: config.timezone, frameId: "77", frameError: null, credentialError: null, loginHint: LOGIN_HINTS.remote }),
    audit: async (e) => { audits.push(e); },
  };
  return { ctx, audits, calls };
}

async function connect(ctx: ToolContext) {
  const server = createServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(a);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const FRAMES: MockRoute = { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77", attributes: { household_name: "L" } }] } };

test("src/server.ts re-exports the shared createServer", () => {
  assert.equal(stdioCreateServer, createServer);
});

test("the stdio runtime and a remote-style context register the same tools", async () => {
  const stdio = await connectTestClient([]);
  const stdioNames = (await stdio.client.listTools()).tools.map((t) => t.name).sort();
  await stdio.close();
  const remote = await connect(fakeRemoteCtx([]).ctx);
  const remoteNames = (await remote.client.listTools()).tools.map((t) => t.name).sort();
  await remote.close();
  assert.ok(stdioNames.length > 60);
  assert.deepEqual(remoteNames, stdioNames);
});

test("SKYLIGHT_TOOLSETS trims the remote-style context too", async () => {
  const remote = await connect(fakeRemoteCtx([], { SKYLIGHT_TOOLSETS: "lists" }).ctx);
  const names = (await remote.client.listTools()).tools.map((t) => t.name);
  await remote.close();
  assert.ok(names.includes("skylight_auth_status"));
  assert.ok(names.includes("skylight_create_list"));
  assert.ok(!names.includes("skylight_create_chore"));
});

test("skylight_auth_status answers from ctx.authStatus, including the login hint", async () => {
  const { ctx } = fakeRemoteCtx([]);
  const remote = await connect(ctx);
  const r = await remote.client.callTool({ name: "skylight_auth_status", arguments: {} });
  await remote.close();
  const data = JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as Record<string, unknown>;
  assert.equal(data.loginHint, LOGIN_HINTS.remote);
  assert.equal(data.frameId, "77");
});

test("the stdio status carries the Mac login hint", async () => {
  const t = await connectTestClient([FRAMES]);
  const r = await t.callTool("skylight_auth_status");
  await t.close();
  assert.equal((r.data as Record<string, unknown>).loginHint, "run `skylight-mcp login` in a terminal on the Mac");
});

test("a write tool call is audited once with its id arguments; a read tool call is not audited", async () => {
  const { ctx, audits } = fakeRemoteCtx([
    FRAMES,
    { method: "GET", path: "/api/frames/77/lists", json: { data: [] } },
    { method: "POST", path: "/api/frames/77/lists/5/list_items", json: { data: { id: "9", type: "list_item", attributes: { label: "Milk", status: "pending" } } } },
  ]);
  const remote = await connect(ctx);
  await remote.client.callTool({ name: "skylight_list_lists", arguments: {} });
  assert.equal(audits.length, 0);
  const r = await remote.client.callTool({ name: "skylight_add_list_items", arguments: { listId: "5", items: [{ title: "Milk" }] } });
  await remote.close();
  assert.notEqual(r.isError, true, JSON.stringify(r.content));
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0], { tool: "skylight_add_list_items", targets: ["5"], ok: true });
});

test("a preview (confirm missing) is audited as a preview; a failed call records a short error", async () => {
  const { ctx, audits } = fakeRemoteCtx([
    FRAMES,
    { method: "GET", path: "/api/frames/77/lists/5", json: { data: { id: "5", type: "list", attributes: { label: "Groceries", kind: "shopping" }, relationships: { list_items: { data: [] } } } } },
  ]);
  const remote = await connect(ctx);
  await remote.client.callTool({ name: "skylight_delete_list", arguments: { listId: "5" } });
  const bad = await remote.client.callTool({ name: "skylight_delete_list", arguments: { listId: "../x", confirm: true } });
  await remote.close();
  assert.equal(bad.isError, true);
  assert.equal(audits.length, 2);
  assert.equal(audits[0]!.preview, true);
  assert.equal(audits[0]!.ok, true);
  assert.equal(audits[1]!.ok, false);
  assert.deepEqual(audits[1]!.targets, []);
  assert.ok(audits[1]!.error && audits[1]!.error.length <= 200);
});

test("an audit sink that throws never changes the tool's answer", async () => {
  const { ctx } = fakeRemoteCtx([FRAMES, { method: "POST", path: "/api/frames/77/lists", json: { data: { id: "8", type: "list", attributes: { label: "Trip", kind: "to_do" } } } }]);
  ctx.audit = async () => { throw new Error("storage down"); };
  const originalError = console.error;
  const logged: string[] = [];
  console.error = (m: string) => { logged.push(m); };
  try {
    const remote = await connect(ctx);
    const r = await remote.client.callTool({ name: "skylight_create_list", arguments: { title: "Trip" } });
    await remote.close();
    assert.notEqual(r.isError, true, JSON.stringify(r.content));
  } finally {
    console.error = originalError;
  }
  assert.ok(logged.some((m) => m.includes("audit log write failed for skylight_create_list")));
});

test("without ctx.audit nothing is wrapped (the Mac stdio server keeps no activity log)", async () => {
  const { ctx } = fakeRemoteCtx([]);
  delete ctx.audit;
  const remote = await connect(ctx);
  assert.ok((await remote.client.listTools()).tools.length > 60);
  await remote.close();
});

test("auditTargets keeps only id-shaped values of keys ending in Id or Ids, at most 20", () => {
  assert.deepEqual(auditTargets({ listId: "5", itemIds: ["1", "2"], title: "Milk", profileId: 7, id: "x", frameIds: "not an id" }), ["5", "1", "2", "7"]);
  assert.deepEqual(auditTargets({ listId: "a b", mealId: "../etc", choreId: "x".repeat(65) }), []);
  assert.deepEqual(auditTargets(undefined), []);
  assert.deepEqual(auditTargets(["listId"]), []);
  const many = auditTargets({ photoIds: Array.from({ length: 50 }, (_, i) => String(i)) });
  assert.equal(many.length, MAX_AUDIT_TARGETS);
});

test("auditEntry marks dry runs and confirm previews, and redacts error text", () => {
  const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });
  assert.equal(auditEntry("t", {}, ok({ dryRun: true })).preview, true);
  assert.equal(auditEntry("t", {}, ok({ confirmed: false })).preview, true);
  assert.equal(auditEntry("t", {}, ok({ dryRun: false, created: 1 })).preview, undefined);
  const failed = auditEntry("t", {}, { isError: true, content: [{ type: "text", text: 'Skylight said {"access_token":"SECRET123"} Bearer abc.def' }] });
  assert.equal(failed.ok, false);
  assert.ok(!failed.error!.includes("SECRET123"));
  assert.ok(!failed.error!.includes("abc.def"));
});

test("the server instructions say every change on the shared server is logged with who made it", async () => {
  const remote = await connect(fakeRemoteCtx([]).ctx);
  const instructions = remote.client.getInstructions() ?? "";
  await remote.close();
  assert.match(instructions, /shared family server .* every change is logged with the family member who made it/);
});
