import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AccountCore, accountRpc, type AccountRpc } from "../../src/remote/account-core.js";
import type { RemoteEnv } from "../../src/remote/env.js";
import { createMcpHandler, MAX_BATCH_MESSAGES } from "../../src/remote/mcp-handler.js";
import { parseConfig } from "../../src/skylight/config.js";
import { createMemoryKv } from "../helpers/memory-kv.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

const ORIGIN = "https://skylight-mcp-staging.example.workers.dev";
const ENV: RemoteEnv = { ALLOWED_EMAILS: "jordan@example.com" };

function core() {
  return new AccountCore({ storage: createMemoryKv(), keyB64: randomBytes(32).toString("base64"), fetch: createMockFetch([]).fetch, config: parseConfig({}), now: () => 1_800_000_000_000 });
}

function setup() {
  const allows: Array<{ who: string; cost: number }> = [];
  const real = accountRpc(core());
  const account: AccountRpc = { ...real, allow: async (who, bucket, cost) => { allows.push({ who, cost: cost ?? 1 }); return real.allow(who, bucket, cost); } };
  const handler = createMcpHandler({ account: () => account, fetch: createMockFetch([]).fetch });
  const post = (body: string, headers: Record<string, string> = {}) => handler.fetch(new Request(`${ORIGIN}/mcp`, {
    method: "POST", body, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
  }), ENV, { props: { email: "jordan@example.com", name: "J", sub: "sub-j" } });
  return { post, allows };
}

const list = (id: number) => ({ jsonrpc: "2.0", id, method: "tools/list" });

test("a batch counts every message toward the person's limit, and gets one answer per request", async () => {
  const { post, allows } = setup();
  const res = await post(JSON.stringify([list(1), list(2), list(3)]));
  assert.equal(res.status, 200);
  const body = await res.json() as Array<{ id: number }>;
  assert.deepEqual(body.map((m) => m.id).sort(), [1, 2, 3]);
  assert.deepEqual(allows, [{ who: "jordan@example.com", cost: 3 }]);
  await post(JSON.stringify(list(4)));
  assert.deepEqual(allows.at(-1), { who: "jordan@example.com", cost: 1 });
});

test(`a batch of more than ${MAX_BATCH_MESSAGES} messages is refused with a JSON-RPC error before counting`, async () => {
  assert.equal(MAX_BATCH_MESSAGES, 10);
  const { post, allows } = setup();
  const ok = await post(JSON.stringify(Array.from({ length: 10 }, (_, i) => list(i))));
  assert.equal(ok.status, 200);
  const res = await post(JSON.stringify(Array.from({ length: 11 }, (_, i) => list(i))));
  assert.equal(res.status, 400);
  const body = await res.json() as { jsonrpc: string; error: { code: number; message: string }; id: null };
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.error.code, -32600);
  assert.match(body.error.message, /at most 10/);
  assert.equal(allows.length, 1, "the oversized batch was not counted");
});

test("malformed JSON is a JSON-RPC parse error; an oversized body is 413", async () => {
  const { post, allows } = setup();
  const bad = await post("{not json");
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { error: { code: number } }).error.code, -32700);
  const huge = await post(JSON.stringify({ ...list(1), params: { pad: "x".repeat(4 * 1024 * 1024) } }));
  assert.equal(huge.status, 413);
  assert.equal(allows.length, 0);
});

test("AccountCore.allow charges a cost and refuses a call that would go over without using up the rest", async () => {
  const c = core();
  for (let i = 0; i < 29; i++) assert.equal(await c.allow("a@example.com", "mcp", 10), true);
  assert.equal(await c.allow("a@example.com", "mcp", 11), false, "11 more would make 301");
  assert.equal(await c.allow("a@example.com", "mcp", 10), true, "exactly 300");
  assert.equal(await c.allow("a@example.com", "mcp"), false);
  for (const bad of [0, -1, 1.5, Number.NaN]) await assert.rejects(c.allow("a@example.com", "mcp", bad), /cost/);
});
