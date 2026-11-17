import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeGuard, GLOBAL_RATE_LIMITS, IP_RATE_LIMITS, rateLimitKey, tokenRequestClientIds, type EdgeEnv, type RateLimiterLike } from "../../src/remote/edge-guard.js";

const ORIGIN = "https://skylight-mcp-staging.example.workers.dev";

function limiter(limit: number) {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const l: RateLimiterLike = { async limit({ key }) { keys.push(key); const n = (counts.get(key) ?? 0) + 1; counts.set(key, n); return { success: n <= limit }; } };
  return { l, keys };
}

function env() {
  const out: EdgeEnv = {};
  const keys: Record<string, string[]> = {};
  for (const { binding, limit } of [...Object.values(IP_RATE_LIMITS), ...Object.values(GLOBAL_RATE_LIMITS)]) {
    const { l, keys: k } = limiter(limit);
    out[binding] = l;
    keys[binding] = k;
  }
  return { env: out, keys };
}

test("IPv4 addresses are keyed in full; IPv6 addresses by their /64", () => {
  assert.equal(rateLimitKey("203.0.113.7"), "203.0.113.7");
  assert.equal(rateLimitKey("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd"), "2001:db8:1234:5678::/64");
  assert.equal(rateLimitKey("2001:0DB8:1234:5678::1"), "2001:db8:1234:5678::/64");
  assert.equal(rateLimitKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(rateLimitKey("::1"), "0:0:0:0::/64");
  assert.equal(rateLimitKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(rateLimitKey("::ffff:198.51.100.9"), "198.51.100.9", "IPv4-mapped is the IPv4 address");
  assert.equal(rateLimitKey("2001:db8:1:2:3:4:192.0.2.1"), "2001:db8:1:2::/64");
  assert.equal(rateLimitKey(null), "unknown");
  assert.equal(rateLimitKey("not an ip"), "unknown");
});

test("hosts within one IPv6 /64 share a /register budget", async () => {
  const e = env();
  for (let i = 1; i <= 5; i++) assert.equal(await edgeGuard(new Request(`${ORIGIN}/register`, { method: "POST", headers: { "CF-Connecting-IP": `2001:db8:aa:bb::${i}` } }), e.env), null);
  const sixth = await edgeGuard(new Request(`${ORIGIN}/register`, { method: "POST", headers: { "CF-Connecting-IP": "2001:db8:aa:bb:ffff::9" } }), e.env);
  assert.equal(sixth?.status, 429);
  assert.equal(await edgeGuard(new Request(`${ORIGIN}/register`, { method: "POST", headers: { "CF-Connecting-IP": "2001:db8:aa:cc::1" } }), e.env), null, "another /64 has its own budget");
});

test("/register also has one global budget of 20 a minute across all IPs", async () => {
  assert.deepEqual(GLOBAL_RATE_LIMITS, { "/register": { binding: "RL_REGISTER_GLOBAL", limit: 20 } });
  const e = env();
  for (let i = 1; i <= 20; i++) assert.equal(await edgeGuard(new Request(`${ORIGIN}/register`, { method: "POST", headers: { "CF-Connecting-IP": `198.51.100.${i}` } }), e.env), null, `ip ${i}`);
  const res = await edgeGuard(new Request(`${ORIGIN}/register`, { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.99" } }), e.env);
  assert.equal(res?.status, 429);
  assert.deepEqual([...new Set(e.keys.RL_REGISTER_GLOBAL)], ["global"]);
  assert.equal(await edgeGuard(new Request(`${ORIGIN}/token`, { method: "POST", headers: { "CF-Connecting-IP": "198.51.100.99" } }), e.env), null, "other endpoints are not on the global budget");
});

const tokenRequest = (body: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}/token`, {
  method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded", "CF-Connecting-IP": "203.0.113.7", ...headers },
});

test("tokenRequestClientIds reads client_id from the form body and the Basic auth user, leaving the request readable", async () => {
  const req = tokenRequest("grant_type=refresh_token&client_id=HTTPS%3A%2F%2Fevil.example%2Fc&refresh_token=x");
  assert.deepEqual(await tokenRequestClientIds(req), ["HTTPS://evil.example/c"]);
  assert.match(await req.text(), /grant_type=refresh_token/, "the original body is untouched");
  const basic = tokenRequest("grant_type=refresh_token&refresh_token=x", { authorization: `Basic ${btoa(`${encodeURIComponent("https://evil.example/c")}:secret`)}` });
  assert.deepEqual(await tokenRequestClientIds(basic), ["https://evil.example/c"]);
  const both = tokenRequest("client_id=client-1", { authorization: `Basic ${btoa("other-id:secret")}` });
  assert.deepEqual(await tokenRequestClientIds(both), ["client-1", "other-id"]);
  assert.deepEqual(await tokenRequestClientIds(tokenRequest("grant_type=refresh_token")), []);
  assert.deepEqual(await tokenRequestClientIds(new Request(`${ORIGIN}/token`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } })), []);
});

test("POST /token with a foreign URL client_id is refused with 401 invalid_client before the library runs", async () => {
  const e = env();
  for (const id of ["https://evil.example/c", "HTTPS://evil.example/c", "hTtPs://EVIL.example/c", "ftp://claude.ai/c"]) {
    const res = await edgeGuard(tokenRequest(`grant_type=authorization_code&code=x&client_id=${encodeURIComponent(id)}`), e.env);
    assert.equal(res?.status, 401, id);
    assert.deepEqual(await res!.json(), { error: "invalid_client" });
  }
  const basic = await edgeGuard(tokenRequest("grant_type=refresh_token&refresh_token=x", { authorization: `Basic ${btoa("https%3A%2F%2Fevil.example%2Fc:s")}` }), e.env);
  assert.equal(basic?.status, 401);
  const smuggled = await edgeGuard(tokenRequest("client_id=client-1", { authorization: `Basic ${btoa("HTTPS%3A%2F%2Fevil.example%2Fc:s")}` }), e.env);
  assert.equal(smuggled?.status, 401, "an allowed form id does not hide a foreign Basic id");
  for (const ok of ["client-123", "https://claude.ai/oauth/claude.json"]) {
    assert.equal(await edgeGuard(tokenRequest(`grant_type=authorization_code&code=x&client_id=${encodeURIComponent(ok)}`), e.env), null, ok);
  }
  assert.equal(await edgeGuard(tokenRequest("grant_type=refresh_token&refresh_token=x"), e.env), null, "no client_id: the library decides");
});
