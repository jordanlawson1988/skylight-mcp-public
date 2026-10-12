import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../../src/skylight/client.js";
import { SkylightApiError, AuthError } from "../../src/skylight/errors.js";
import type { TokenProvider } from "../../src/skylight/auth.js";
import { loadConfig } from "../../src/skylight/config.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

const config = loadConfig({});
function tokens(seq: string[]): TokenProvider & { refreshes: number } {
  let i = 0;
  const tp = {
    refreshes: 0,
    async getAccessToken() { return seq[0]!; },
    async refreshAfterRejection() { tp.refreshes += 1; i += 1; return seq[i] ?? seq.at(-1)!; },
  };
  return tp;
}

test("sends auth and version headers, builds query, parses JSON", async () => {
  const { fetch, calls } = createMockFetch([{ method: "GET", path: "/api/frames/1/chores", json: { data: [] } }]);
  const client = createClient({ fetch, config, tokens: tokens(["AT"]) });
  const out = await client.request({ method: "GET", path: "/api/frames/1/chores", query: { after: "2026-01-01", include_late: true, skip: undefined } });
  assert.deepEqual(out, { data: [] });
  const c = calls[0]!;
  assert.equal(c.headers.get("authorization"), "Bearer AT");
  assert.equal(c.headers.get("skylight-api-version"), "2026-05-01");
  assert.equal(c.headers.get("accept"), "application/json");
  assert.equal(c.url.searchParams.get("after"), "2026-01-01");
  assert.equal(c.url.searchParams.get("include_late"), "true");
  assert.equal(c.url.searchParams.has("skip"), false);
});

test("JSON body is sent with content-type", async () => {
  const { fetch, calls } = createMockFetch([{ method: "POST", path: "/api/x", json: { ok: 1 } }]);
  const client = createClient({ fetch, config, tokens: tokens(["AT"]) });
  await client.request({ method: "POST", path: "/api/x", body: { a: 1 } });
  assert.equal(calls[0]!.headers.get("content-type"), "application/json");
  assert.deepEqual(calls[0]!.body, { a: 1 });
});

test("401 triggers exactly one refresh and retry", async () => {
  let n = 0;
  const { fetch, calls } = createMockFetch([{ method: "GET", path: "/api/x", handler: () => (n++ === 0 ? { status: 401, text: "nope" } : { json: { ok: true } }) }]);
  const tp = tokens(["AT1", "AT2"]);
  const client = createClient({ fetch, config, tokens: tp });
  assert.deepEqual(await client.request({ method: "GET", path: "/api/x" }), { ok: true });
  assert.equal(tp.refreshes, 1);
  assert.equal(calls[1]!.headers.get("authorization"), "Bearer AT2");
});

test("second 401 becomes an AuthError", async () => {
  const { fetch } = createMockFetch([{ method: "GET", path: "/api/x", status: 401, text: "nope" }]);
  const client = createClient({ fetch, config, tokens: tokens(["AT1", "AT2"]) });
  await assert.rejects(client.request({ method: "GET", path: "/api/x" }), (e: unknown) => e instanceof AuthError && /skylight-mcp login/.test(e.message));
});

test("non-2xx becomes SkylightApiError with sanitized, truncated excerpt", async () => {
  const { fetch } = createMockFetch([{ method: "DELETE", path: "/api/x", status: 422, text: `{"error":"${"x".repeat(900)}\u0007"}` }]);
  const client = createClient({ fetch, config, tokens: tokens(["AT"]) });
  await assert.rejects(client.request({ method: "DELETE", path: "/api/x" }), (e: unknown) => {
    assert.ok(e instanceof SkylightApiError);
    assert.equal(e.status, 422);
    assert.equal(e.method, "DELETE");
    assert.ok(e.message.length < 700);
    assert.ok(!e.message.includes("\u0007"));
    return true;
  });
});

test("empty body returns null; path outside /api or /oauth is rejected", async () => {
  const { fetch } = createMockFetch([{ method: "DELETE", path: "/api/x", status: 204, text: "" }]);
  const client = createClient({ fetch, config, tokens: tokens(["AT"]) });
  assert.equal(await client.request({ method: "DELETE", path: "/api/x" }), null);
  await assert.rejects(client.request({ method: "GET", path: "/admin" }), /path/);
});

test("429 message includes retry-after hint", async () => {
  const { fetch } = createMockFetch([{ method: "GET", path: "/api/x", status: 429, text: "slow down", headers: { "retry-after": "7" } }]);
  const client = createClient({ fetch, config, tokens: tokens(["AT"]) });
  await assert.rejects(client.request({ method: "GET", path: "/api/x" }), /retry after 7/i);
});
