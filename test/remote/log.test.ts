import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describeError, workerErrorLogger } from "../../src/remote/log.js";
import { createServer } from "../../src/server-core.js";
import { parseConfig } from "../../src/skylight/config.js";
import { LOGIN_HINTS } from "../../src/skylight/status.js";
import type { ToolContext } from "../../src/tools/context.js";
import { ANNOTATIONS, run } from "../../src/tools/result.js";

function captureConsoleError(): { lines: string[]; restore: () => void } {
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.error = original; } };
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    config: parseConfig({}),
    client: { request: async <T>() => ({}) as T },
    frames: { resolve: async () => "77", list: async () => [] },
    now: () => new Date(),
    authStatus: async () => ({ loggedIn: false, needsLogin: true, apiHost: "x", tokenExpiresAt: null, tokenExpiresAtLocal: null, tokenExpiresWhen: null, timezone: "UTC", frameId: null, frameError: null, credentialError: null, loginHint: LOGIN_HINTS.remote }),
    ...over,
  };
}

async function callBoom(c: ToolContext, error: Error) {
  const server = createServer(c);
  server.registerTool("skylight_boom", { title: "boom", description: "throws", inputSchema: {}, annotations: ANNOTATIONS.read }, () => run(async () => { throw error; }));
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(a);
  const r = await client.callTool({ name: "skylight_boom", arguments: {} });
  await client.close();
  await server.close();
  return r;
}

test("stdio keeps logging an unexpected tool error with its stack to stderr", async () => {
  const cap = captureConsoleError();
  let r;
  try { r = await callBoom(ctx(), new TypeError("kaboom")); } finally { cap.restore(); }
  assert.equal(r.isError, true);
  assert.match((r.content as Array<{ text: string }>)[0]!.text, /Unexpected error inside skylight-mcp/);
  assert.equal(cap.lines.length, 1);
  assert.match(cap.lines[0]!, /^\[skylight-mcp\] unexpected error: TypeError: kaboom\n\s+at /);
});

test("a context's logError receives the unexpected error instead", async () => {
  const seen: unknown[] = [];
  const cap = captureConsoleError();
  try { await callBoom(ctx({ logError: (e) => { seen.push(e); } }), new RangeError("oops")); } finally { cap.restore(); }
  assert.equal(seen.length, 1);
  assert.ok(seen[0] instanceof RangeError);
  assert.deepEqual(cap.lines, []);
});

test("the Worker's logger drops stacks, masks secrets and stays under 300 characters", async () => {
  const secret = "admin-token-abcdefghijklmnop";
  const e = new Error(`failed with ${secret} and {"access_token":"AT-123"} ${"x".repeat(500)}`);
  const line = describeError(e, [secret]);
  assert.ok(line.length <= 300);
  assert.ok(line.startsWith("Error: failed with [redacted]"));
  assert.ok(!line.includes("AT-123"));
  assert.ok(!line.includes("    at "));
  const cap = captureConsoleError();
  try { workerErrorLogger([secret])(e); } finally { cap.restore(); }
  assert.equal(cap.lines.length, 1);
  assert.ok(!cap.lines[0]!.includes(secret));
  assert.ok(!cap.lines[0]!.includes("\n"), "single line, no stack");
  assert.equal(describeError("plain string", []), "plain string");
});
