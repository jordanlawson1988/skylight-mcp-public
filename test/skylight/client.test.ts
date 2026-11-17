import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient } from "../../src/skylight/client.js";
import { SkylightApiError, AuthError } from "../../src/skylight/errors.js";
import type { TokenProvider } from "../../src/skylight/auth.js";
import { parseConfig } from "../../src/skylight/config.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

const config = parseConfig({});
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

test("the relogin hint after a second 401 is configurable (the shared server names its own command)", async () => {
  const { fetch } = createMockFetch([{ method: "GET", path: "/api/x", status: 401, text: "nope" }]);
  const client = createClient({ fetch, config, tokens: tokens(["AT1", "AT2"]), reloginHint: "The server owner needs to run `skylight-mcp remote login`." });
  await assert.rejects(client.request({ method: "GET", path: "/api/x" }), (e: unknown) => e instanceof AuthError && e.message === "Skylight rejected the credentials after a refresh. The server owner needs to run `skylight-mcp remote login`.");
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
  const client = createClient({ fetch, config, tokens: tokens(["AT"]), sleep: async () => {} });
  await assert.rejects(client.request({ method: "GET", path: "/api/x" }), /retry after 7/i);
});

test("a 500 body echoing the bearer token does not leak it into the error message", async () => {
  const { fetch } = createMockFetch([{ method: "GET", path: "/api/x", status: 500, text: "request echo: authorization=Bearer SECRETTOKEN123 and SECRETTOKEN123" }]);
  const client = createClient({ fetch, config, tokens: tokens(["SECRETTOKEN123"]), sleep: async () => {} });
  await assert.rejects(client.request({ method: "GET", path: "/api/x" }), (e: unknown) => {
    assert.ok(e instanceof SkylightApiError);
    assert.ok(!e.message.includes("SECRETTOKEN123"));
    assert.match(e.message, /\[redacted\]/);
    return true;
  });
});

test("the refreshed token is also redacted after a 401 retry", async () => {
  let n = 0;
  const { fetch } = createMockFetch([{ method: "GET", path: "/api/x", handler: () => (n++ === 0 ? { status: 401, text: "nope" } : { status: 500, text: "echo NEWTOKEN999 OLDTOKEN111" }) }]);
  const client = createClient({ fetch, config, tokens: tokens(["OLDTOKEN111", "NEWTOKEN999"]), sleep: async () => {} });
  await assert.rejects(client.request({ method: "GET", path: "/api/x" }), (e: unknown) => {
    assert.ok(e instanceof SkylightApiError);
    assert.ok(!e.message.includes("NEWTOKEN999") && !e.message.includes("OLDTOKEN111"));
    return true;
  });
});

function retryHarness(responses: Array<{ status: number; json?: unknown; text?: string; retryAfter?: string }>) {
  let n = 0;
  const sleeps: number[] = [];
  const { fetch, calls } = createMockFetch([{ method: "GET", path: "/api/x", handler: () => responses[Math.min(n++, responses.length - 1)]! }, { method: "POST", path: "/api/x", handler: () => responses[Math.min(n++, responses.length - 1)]! }]);
  // The mock route headers are static, so wrap fetch to inject retry-after per response.
  const wrapped = (async (input: string | URL, init?: RequestInit) => {
    const res = await fetch(input, init);
    const idx = calls.length - 1;
    const ra = responses[Math.min(idx, responses.length - 1)]?.retryAfter;
    return ra === undefined ? res : new Response(await res.text(), { status: res.status, headers: { "retry-after": ra } });
  }) as typeof globalThis.fetch;
  const client = createClient({ fetch: wrapped, config, tokens: tokens(["AT"]), sleep: async (ms) => { sleeps.push(ms); } });
  return { client, calls, sleeps };
}

test("GET retries once on 429 after min(retry-after, 2s)", async () => {
  const h = retryHarness([{ status: 429, text: "slow", retryAfter: "7" }, { status: 200, json: { ok: true } }]);
  assert.deepEqual(await h.client.request({ method: "GET", path: "/api/x" }), { ok: true });
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.sleeps, [2000]);
});

test("GET retries once on 5xx after 500ms, and honours a short retry-after", async () => {
  const a = retryHarness([{ status: 503, text: "down" }, { status: 200, json: { ok: 1 } }]);
  assert.deepEqual(await a.client.request({ method: "GET", path: "/api/x" }), { ok: 1 });
  assert.deepEqual(a.sleeps, [500]);
  const b = retryHarness([{ status: 429, text: "slow", retryAfter: "1" }, { status: 200, json: { ok: 2 } }]);
  await b.client.request({ method: "GET", path: "/api/x" });
  assert.deepEqual(b.sleeps, [1000]);
});

test("GET gives up after one retry and reports the second failure", async () => {
  const h = retryHarness([{ status: 500, text: "first" }, { status: 502, text: "second" }, { status: 200, json: {} }]);
  await assert.rejects(h.client.request({ method: "GET", path: "/api/x" }), (e: unknown) => e instanceof SkylightApiError && e.status === 502);
  assert.equal(h.calls.length, 2);
});

test("GET does not retry other errors, and writes are never retried", async () => {
  const notFound = retryHarness([{ status: 404, text: "nope" }, { status: 200, json: {} }]);
  await assert.rejects(notFound.client.request({ method: "GET", path: "/api/x" }), (e: unknown) => e instanceof SkylightApiError && e.status === 404);
  assert.equal(notFound.calls.length, 1);
  for (const status of [429, 500]) {
    const post = retryHarness([{ status, text: "fail" }, { status: 200, json: {} }]);
    await assert.rejects(post.client.request({ method: "POST", path: "/api/x", body: {} }), (e: unknown) => e instanceof SkylightApiError && e.status === status);
    assert.equal(post.calls.length, 1);
    assert.deepEqual(post.sleeps, []);
  }
});

test("GET retries only 429, 500, 502, 503 and 504", async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    const h = retryHarness([{ status, text: "x" }, { status: 200, json: {} }]);
    await h.client.request({ method: "GET", path: "/api/x" });
    assert.equal(h.calls.length, 2, String(status));
  }
  for (const status of [400, 404, 422, 501, 505, 599]) {
    const h = retryHarness([{ status, text: "x" }, { status: 200, json: {} }]);
    await assert.rejects(h.client.request({ method: "GET", path: "/api/x" }));
    assert.equal(h.calls.length, 1, String(status));
  }
});

test("PUT and DELETE are never retried", async () => {
  for (const method of ["PUT", "DELETE"] as const) {
    let n = 0;
    const { fetch, calls } = createMockFetch([{ method, path: "/api/x", handler: () => ({ status: n++ === 0 ? 503 : 200, text: "x" }) }]);
    const sleeps: number[] = [];
    const client = createClient({ fetch, config, tokens: tokens(["AT"]), sleep: async (ms) => { sleeps.push(ms); } });
    await assert.rejects(client.request({ method, path: "/api/x", body: {} }), (e: unknown) => e instanceof SkylightApiError && e.status === 503);
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  }
});
