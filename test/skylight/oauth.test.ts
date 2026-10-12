import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createPendingLogin, pkceChallenge, buildAuthorizeUrl, parseCallbackUrl, exchangeCode, refreshCredential,
} from "../../src/skylight/oauth.js";
import { AuthError } from "../../src/skylight/errors.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

const BASE = "https://app.ourskylight.com";

test("createPendingLogin produces base64url verifier of 43-128 chars and distinct state", () => {
  const a = createPendingLogin(1000);
  const b = createPendingLogin(1000);
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43,128}$/);
  assert.match(a.state, /^[A-Za-z0-9_-]{32,}$/);
  assert.match(a.fingerprint, /^[0-9a-f-]{36}$/);
  assert.notEqual(a.state, b.state);
  assert.equal(a.createdAt, 1000);
  assert.equal(a.method, "S256");
});

test("pkceChallenge S256 is base64url(sha256(verifier))", () => {
  const v = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const expected = createHash("sha256").update(v).digest("base64url");
  assert.equal(pkceChallenge(v, "S256"), expected);
  assert.equal(pkceChallenge(v, "plain"), v);
});

test("buildAuthorizeUrl includes PKCE, state and device fingerprint", () => {
  const p = createPendingLogin();
  const url = new URL(buildAuthorizeUrl(BASE, p));
  assert.equal(url.origin + url.pathname, `${BASE}/oauth/authorize`);
  const q = url.searchParams;
  assert.equal(q.get("client_id"), "skylight-mobile");
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("redirect_uri"), "https://ourskylight.com/welcome");
  assert.equal(q.get("scope"), "everything");
  assert.equal(q.get("state"), p.state);
  assert.equal(q.get("code_challenge"), pkceChallenge(p.verifier, "S256"));
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("skylight_api_client_device_fingerprint"), p.fingerprint);
});

test("parseCallbackUrl accepts matching state", () => {
  const p = createPendingLogin(1000);
  const r = parseCallbackUrl(`https://ourskylight.com/welcome?code=abc123&state=${p.state}`, p, 2000);
  assert.equal(r.code, "abc123");
});

test("parseCallbackUrl rejects state mismatch", () => {
  const p = createPendingLogin(1000);
  assert.throws(() => parseCallbackUrl("https://ourskylight.com/welcome?code=abc&state=WRONG", p, 2000), AuthError);
});

test("parseCallbackUrl rejects wrong host, path, scheme, missing code and stale login", () => {
  const p = createPendingLogin(1000);
  const s = p.state;
  assert.throws(() => parseCallbackUrl(`https://evil.com/welcome?code=a&state=${s}`, p, 2000), AuthError);
  assert.throws(() => parseCallbackUrl(`https://ourskylight.com/other?code=a&state=${s}`, p, 2000), AuthError);
  assert.throws(() => parseCallbackUrl(`http://ourskylight.com/welcome?code=a&state=${s}`, p, 2000), AuthError);
  assert.throws(() => parseCallbackUrl(`https://ourskylight.com/welcome?state=${s}`, p, 2000), AuthError);
  assert.throws(() => parseCallbackUrl(`https://ourskylight.com/welcome?code=a&state=${s}`, p, 1000 + 600_001), AuthError);
  assert.throws(() => parseCallbackUrl("not a url", p, 2000), AuthError);
});

test("parseCallbackUrl rejects userinfo, explicit port and trailing-dot host", () => {
  const p = createPendingLogin(1000);
  const s = p.state;
  assert.throws(() => parseCallbackUrl(`https://evil@ourskylight.com/welcome?code=a&state=${s}`, p, 2000), AuthError);
  assert.throws(() => parseCallbackUrl(`https://user:pw@ourskylight.com/welcome?code=a&state=${s}`, p, 2000), AuthError);
  assert.throws(() => parseCallbackUrl(`https://ourskylight.com:8443/welcome?code=a&state=${s}`, p, 2000), AuthError);
  assert.throws(() => parseCallbackUrl(`https://ourskylight.com./welcome?code=a&state=${s}`, p, 2000), AuthError);
});

test("exchangeCode posts form with verifier and returns credential", async () => {
  const p = createPendingLogin(1000);
  const { fetch, calls } = createMockFetch([
    { method: "POST", path: "/oauth/token", json: { access_token: "AT", refresh_token: "RT", expires_in: 3600 } },
  ]);
  const before = Date.now();
  const cred = await exchangeCode({ fetch, apiBaseUrl: BASE, code: "CODE", pending: p, timeoutMs: 1000 });
  assert.equal(cred.accessToken, "AT");
  assert.equal(cred.refreshToken, "RT");
  assert.equal(cred.fingerprint, p.fingerprint);
  assert.ok(cred.expiresAt >= before + 3600_000 - 50);
  const body = calls[0]!.body as Record<string, string>;
  assert.equal(calls[0]!.headers.get("content-type"), "application/x-www-form-urlencoded");
  assert.equal(body.grant_type, "authorization_code");
  assert.equal(body.code, "CODE");
  assert.equal(body.code_verifier, p.verifier);
  assert.equal(body.client_id, "skylight-mobile");
  assert.equal(body.redirect_uri, "https://ourskylight.com/welcome");
  assert.equal(body.skylight_api_client_device_fingerprint, p.fingerprint);
  assert.equal(body.source, "js-mobile");
});

test("exchangeCode surfaces server rejection without echoing tokens", async () => {
  const p = createPendingLogin();
  const code = "SECRETCODE12345";
  const rt = "FAKE-REFRESH-TOKEN-abcdef";
  const { fetch } = createMockFetch([
    {
      method: "POST", path: "/oauth/token", status: 400,
      json: {
        error: "invalid_grant", error_description: "Code challenge is required.",
        echoed: { code, code_verifier: p.verifier }, access_token: "FAKE-ACCESS-TOKEN-xyz", refresh_token: rt,
      },
    },
  ]);
  await assert.rejects(
    exchangeCode({ fetch, apiBaseUrl: BASE, code, pending: p, timeoutMs: 1000 }),
    (e: unknown) => {
      if (!(e instanceof AuthError)) return false;
      assert.match(e.message, /400/);
      assert.match(e.message, /Code challenge/);
      for (const secret of [code, p.verifier, rt, "FAKE-ACCESS-TOKEN-xyz"]) assert.ok(!e.message.includes(secret), `leaked ${secret}`);
      return true;
    }
  );
});

test("error excerpt is at most 500 characters", async () => {
  const p = createPendingLogin();
  const { fetch } = createMockFetch([{ method: "POST", path: "/oauth/token", status: 500, text: "x".repeat(2000) }]);
  await assert.rejects(
    exchangeCode({ fetch, apiBaseUrl: BASE, code: "CODE1234", pending: p, timeoutMs: 1000 }),
    (e: unknown) => {
      if (!(e instanceof AuthError)) return false;
      const excerptPart = e.message.slice(e.message.indexOf("): ") + 3);
      assert.equal(excerptPart.length, 500);
      return true;
    }
  );
});

test("token request is sent with redirect: error", async () => {
  const p = createPendingLogin();
  let redirect: RequestInit["redirect"];
  const { fetch } = createMockFetch([
    { method: "POST", path: "/oauth/token", handler: ({ init }) => { redirect = init.redirect; return { json: { access_token: "A", refresh_token: "R", expires_in: 10 } }; } },
  ]);
  await exchangeCode({ fetch, apiBaseUrl: BASE, code: "CODE1234", pending: p, timeoutMs: 1000 });
  assert.equal(redirect, "error");
});

test("refreshCredential posts refresh grant and keeps fingerprint", async () => {
  const { fetch, calls } = createMockFetch([
    { method: "POST", path: "/oauth/token", json: { access_token: "AT2", refresh_token: "RT2", expires_in: 100 } },
  ]);
  const cred = await refreshCredential({
    fetch, apiBaseUrl: BASE, timeoutMs: 1000,
    credential: { version: 1, accessToken: "AT", refreshToken: "RT", fingerprint: "fp", expiresAt: 0 },
  });
  assert.equal(cred.accessToken, "AT2");
  assert.equal(cred.refreshToken, "RT2");
  assert.equal(cred.fingerprint, "fp");
  const body = calls[0]!.body as Record<string, string>;
  assert.equal(body.grant_type, "refresh_token");
  assert.equal(body.refresh_token, "RT");
});

test("token response missing fields is an AuthError", async () => {
  const { fetch } = createMockFetch([{ method: "POST", path: "/oauth/token", json: { access_token: "x" } }]);
  await assert.rejects(
    refreshCredential({ fetch, apiBaseUrl: BASE, timeoutMs: 1000, credential: { version: 1, accessToken: "a", refreshToken: "r", fingerprint: "f", expiresAt: 0 } }),
    AuthError
  );
});

test("refresh without refresh_token keeps the previous one", async () => {
  const { fetch } = createMockFetch([{ method: "POST", path: "/oauth/token", json: { access_token: "AT3", expires_in: 50 } }]);
  const cred = await refreshCredential({
    fetch, apiBaseUrl: BASE, timeoutMs: 1000,
    credential: { version: 1, accessToken: "AT", refreshToken: "OLD-RT", fingerprint: "fp", expiresAt: 0 },
  });
  assert.equal(cred.accessToken, "AT3");
  assert.equal(cred.refreshToken, "OLD-RT");
});

test("code exchange still requires a refresh_token", async () => {
  const p = createPendingLogin();
  const { fetch } = createMockFetch([{ method: "POST", path: "/oauth/token", json: { access_token: "AT", expires_in: 50 } }]);
  await assert.rejects(exchangeCode({ fetch, apiBaseUrl: BASE, code: "CODE1234", pending: p, timeoutMs: 1000 }), AuthError);
});

test("non-finite expires_in is rejected", async () => {
  const { fetch } = createMockFetch([{ method: "POST", path: "/oauth/token", text: '{"access_token":"a","refresh_token":"r","expires_in":1e999}' }]);
  await assert.rejects(
    refreshCredential({ fetch, apiBaseUrl: BASE, timeoutMs: 1000, credential: { version: 1, accessToken: "a", refreshToken: "r", fingerprint: "f", expiresAt: 0 } }),
    AuthError
  );
});

test("refresh rejected with 400 or 401 gives the login hint without the body", async () => {
  for (const status of [400, 401]) {
    const { fetch } = createMockFetch([{ method: "POST", path: "/oauth/token", status, text: '{"error":"invalid_grant","refresh_token":"RT"}' }]);
    await assert.rejects(
      refreshCredential({ fetch, apiBaseUrl: BASE, timeoutMs: 1000, credential: { version: 1, accessToken: "a", refreshToken: "RT", fingerprint: "f", expiresAt: 0 } }),
      (e: unknown) => e instanceof AuthError && /expired or was revoked/.test(e.message) && /skylight-mcp login/.test(e.message) && !e.message.includes("invalid_grant")
    );
  }
});

test("other refresh failures append the login hint", async () => {
  const { fetch } = createMockFetch([{ method: "POST", path: "/oauth/token", status: 503, text: "down" }]);
  await assert.rejects(
    refreshCredential({ fetch, apiBaseUrl: BASE, timeoutMs: 1000, credential: { version: 1, accessToken: "a", refreshToken: "r", fingerprint: "f", expiresAt: 0 } }),
    (e: unknown) => e instanceof AuthError && /\(503\): down\. Run `skylight-mcp login` if this persists\.$/.test(e.message) && /skylight-mcp login/.test(e.message)
  );
});

test("refresh failure with an empty body has no double separator", async () => {
  const { fetch } = createMockFetch([{ method: "POST", path: "/oauth/token", status: 502, text: "" }]);
  await assert.rejects(
    refreshCredential({ fetch, apiBaseUrl: BASE, timeoutMs: 1000, credential: { version: 1, accessToken: "a", refreshToken: "r", fingerprint: "f", expiresAt: 0 } }),
    (e: unknown) => e instanceof AuthError && e.message === "Skylight token refresh failed (502). Run `skylight-mcp login` if this persists."
  );
});
