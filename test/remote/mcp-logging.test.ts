import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AccountCore, accountRpc, type AccountRpc } from "../../src/remote/account-core.js";
import type { RemoteEnv } from "../../src/remote/env.js";
import { createMcpHandler } from "../../src/remote/mcp-handler.js";
import { parseConfig } from "../../src/skylight/config.js";
import { createMemoryKv } from "../helpers/memory-kv.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

const ADMIN_TOKEN = "admin-token-0123456789abcdefghijklmnopqrstuv";
const ENV: RemoteEnv = { ALLOWED_EMAILS: "jordan@example.com", ADMIN_TOKEN };

test("an unexpected tool error on the Worker is logged as one redacted line, without its stack", async () => {
  const core = new AccountCore({ storage: createMemoryKv(), keyB64: randomBytes(32).toString("base64"), fetch: createMockFetch([]).fetch, config: parseConfig({}), now: () => Date.now() });
  const account: AccountRpc = { ...accountRpc(core), recentAudit: async () => { throw new TypeError(`storage exploded near ${ADMIN_TOKEN}`); } };
  const handler = createMcpHandler({ account: () => account, fetch: createMockFetch([]).fetch });
  const original = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  let res: Response;
  try {
    res = await handler.fetch(new Request("https://x.workers.dev/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "skylight_recent_activity", arguments: {} } }),
    }), ENV, { props: { email: "jordan@example.com", name: "J", sub: "sub-j" } });
  } finally {
    console.error = original;
  }
  const body = await res.json() as { result: { isError: boolean; content: Array<{ text: string }> } };
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0]!.text, /Unexpected error inside skylight-mcp/);
  const logged = lines.filter((l) => l.includes("unexpected error"));
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /^\[skylight-mcp\] unexpected error: TypeError: storage exploded near \[redacted\]$/);
  assert.ok(!logged[0]!.includes(ADMIN_TOKEN));
  assert.ok(!logged[0]!.includes("\n"));
});
