import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeGuard, IP_RATE_LIMITS, RATE_LIMIT_PERIOD_SECONDS, type EdgeEnv, type RateLimiterLike } from "../../src/remote/edge-guard.js";

const ORIGIN = "https://skylight-mcp-staging.example.workers.dev";

/** A limiter like the Workers binding: a fixed limit per key within the window. */
function limiter(limit: number) {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const l: RateLimiterLike = {
    async limit({ key }) { keys.push(key); const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return { success: n <= limit }; },
  };
  return { l, keys };
}

function env(): { env: EdgeEnv; keys: Record<string, string[]> } {
  const out: EdgeEnv = {};
  const keys: Record<string, string[]> = {};
  for (const { binding, limit } of Object.values(IP_RATE_LIMITS)) {
    const { l, keys: k } = limiter(limit);
    out[binding] = l;
    keys[binding] = k;
  }
  return { env: out, keys };
}

const req = (path: string, ip = "203.0.113.7", base = ORIGIN, method = "GET") => new Request(`${base}${path}`, { method, headers: { "CF-Connecting-IP": ip } });

test("the per-IP limits: /register 5, /authorize 20, /callback 20, /token 60 per minute", () => {
  assert.equal(RATE_LIMIT_PERIOD_SECONDS, 60);
  assert.deepEqual(Object.fromEntries(Object.entries(IP_RATE_LIMITS).map(([p, v]) => [p, v.limit])), { "/register": 5, "/authorize": 20, "/callback": 20, "/token": 60 });
  assert.equal(new Set(Object.values(IP_RATE_LIMITS).map((v) => v.binding)).size, 4);
});

test("the 6th /register from one IP in a minute gets 429; another IP is not affected", async () => {
  const e = env();
  for (let i = 0; i < 5; i++) assert.equal(await edgeGuard(req("/register", "203.0.113.7", ORIGIN, "POST"), e.env), null, `call ${i + 1}`);
  const blocked = await edgeGuard(req("/register", "203.0.113.7", ORIGIN, "POST"), e.env);
  assert.equal(blocked?.status, 429);
  assert.equal(blocked?.headers.get("retry-after"), "60");
  assert.equal(await edgeGuard(req("/register", "198.51.100.9", ORIGIN, "POST"), e.env), null);
  assert.deepEqual([...new Set(e.keys.RL_REGISTER)], ["203.0.113.7", "198.51.100.9"]);
});

test("each endpoint has its own limiter and limit", async () => {
  const e = env();
  for (let i = 0; i < 20; i++) assert.equal(await edgeGuard(req("/authorize"), e.env), null);
  assert.equal((await edgeGuard(req("/authorize"), e.env))?.status, 429);
  assert.equal(await edgeGuard(req("/callback"), e.env), null, "/callback has its own budget");
  for (let i = 0; i < 59; i++) await edgeGuard(req("/token", "203.0.113.7", ORIGIN, "POST"), e.env);
  assert.equal(await edgeGuard(req("/token", "203.0.113.7", ORIGIN, "POST"), e.env), null, "60th /token passes");
  assert.equal((await edgeGuard(req("/token", "203.0.113.7", ORIGIN, "POST"), e.env))?.status, 429);
});

test("other paths are not rate limited here (/mcp has its per-person limit, /admin its own)", async () => {
  const e = env();
  for (const path of ["/mcp", "/health", "/admin/skylight-credential", "/.well-known/oauth-authorization-server", "/register/extra"]) {
    assert.equal(await edgeGuard(req(path), e.env), null, path);
  }
  assert.equal(Object.values(e.keys).flat().length, 0);
});

test("plain http is refused with 400 before anything else, except localhost for wrangler dev", async () => {
  const e = env();
  const res = await edgeGuard(req("/mcp", "203.0.113.7", "http://skylight-mcp-staging.example.workers.dev"), e.env);
  assert.equal(res?.status, 400);
  assert.match(await res!.text(), /https/);
  assert.equal(await edgeGuard(req("/health", "1.2.3.4", "http://localhost:8787"), e.env), null);
  assert.equal(await edgeGuard(req("/health", "1.2.3.4", "http://127.0.0.1:8787"), e.env), null);
  assert.equal((await edgeGuard(req("/health", "1.2.3.4", "http://localhost.evil.test"), e.env))?.status, 400);
});

test("a missing limiter binding fails closed (503); a limiter error fails open and is logged", async () => {
  const res = await edgeGuard(req("/register", "203.0.113.7", ORIGIN, "POST"), {});
  assert.equal(res?.status, 503);
  const broken: EdgeEnv = { ...env().env, RL_TOKEN: { limit: async () => { throw new Error("limiter down"); } } };
  const original = console.error;
  const logged: string[] = [];
  console.error = (m: string) => { logged.push(m); };
  try {
    assert.equal(await edgeGuard(req("/token", "203.0.113.7", ORIGIN, "POST"), broken), null);
  } finally {
    console.error = original;
  }
  assert.ok(logged.some((m) => m.includes("rate limiter unavailable")));
});

test("requests without CF-Connecting-IP share one bucket", async () => {
  const e = env();
  await edgeGuard(new Request(`${ORIGIN}/register`, { method: "POST" }), e.env);
  assert.deepEqual(e.keys.RL_REGISTER, ["unknown"]);
});
