import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  buildGoogleAuthUrl, consentPage, decodeJwtPayload, escapeHtml, exchangeGoogleCode, FAMILY_LIST_MESSAGE, handleAuthorize, handleCallback,
  isAllowed, parseAllowlist, verifyIdTokenClaims,
} from "../../src/remote/google.js";
import type { RemoteEnv } from "../../src/remote/env.js";
import { createFakeOAuth } from "../helpers/fake-oauth.js";
import { createMemoryKv } from "../helpers/memory-kv.js";
import { createMockFetch, type MockRoute } from "../helpers/mock-fetch.js";

const CLIENT_ID = "google-client.apps.googleusercontent.com";
const NOW = Date.parse("2026-10-12T12:00:00Z");
const ENV: RemoteEnv = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "google-secret-value", ALLOWED_EMAILS: "Jordan@Example.com, wife@example.com" };
const ORIGIN = "https://skylight-mcp-staging.example.workers.dev";

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
function idToken(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.c2lnbmF0dXJl`;
}
function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "123", email: "Jordan@Example.com", email_verified: true, name: "Jordan", exp: NOW / 1000 + 3600, iat: NOW / 1000, ...over };
}

// ---- pure helpers ----

test("parseAllowlist trims, lower-cases and de-duplicates; an empty list is a startup error", () => {
  assert.deepEqual(parseAllowlist(" Jordan@Example.com ,wife@example.com,jordan@example.com,, "), ["jordan@example.com", "wife@example.com"]);
  for (const bad of [undefined, "", " , ", "not-an-email"]) assert.throws(() => parseAllowlist(bad), /ALLOWED_EMAILS/, String(bad));
});

test("isAllowed needs a verified email on the list, compared case-insensitively", () => {
  const list = parseAllowlist("jordan@example.com");
  assert.equal(isAllowed("JORDAN@example.com", true, list), true);
  assert.equal(isAllowed("jordan@example.com", false, list), false);
  assert.equal(isAllowed("someone@example.com", true, list), false);
  assert.equal(isAllowed("jordan@example.com.evil.test", true, list), false);
  assert.equal(isAllowed("", true, list), false);
});

test("buildGoogleAuthUrl asks for openid email profile with PKCE S256, state, nonce and the account chooser", () => {
  const url = new URL(buildGoogleAuthUrl({ clientId: CLIENT_ID, redirectUri: `${ORIGIN}/callback`, state: "S", codeChallenge: "C", nonce: "N" }));
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const q = Object.fromEntries(url.searchParams);
  assert.deepEqual(q, {
    client_id: CLIENT_ID, redirect_uri: `${ORIGIN}/callback`, response_type: "code", scope: "openid email profile", state: "S",
    code_challenge: "C", code_challenge_method: "S256", prompt: "select_account", nonce: "N",
  });
});

test("verifyIdTokenClaims accepts Google's token and returns the lower-cased email", () => {
  assert.deepEqual(verifyIdTokenClaims(claims(), { clientId: CLIENT_ID, now: NOW }), { email: "jordan@example.com", name: "Jordan", sub: "123" });
  assert.deepEqual(verifyIdTokenClaims(claims({ iss: "accounts.google.com", name: undefined }), { clientId: CLIENT_ID, now: NOW }), { email: "jordan@example.com", name: "jordan@example.com", sub: "123" });
  assert.equal(verifyIdTokenClaims(claims({ email_verified: "true", nonce: "N" }), { clientId: CLIENT_ID, now: NOW, nonce: "N" }).email, "jordan@example.com");
});

test("verifyIdTokenClaims refuses the wrong issuer, audience, expiry, nonce or an unverified email", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["issuer", { iss: "https://evil.example" }],
    ["audience", { aud: "someone-else" }],
    ["audience list without us", { aud: ["someone-else"] }],
    ["expired", { exp: NOW / 1000 - 1 }],
    ["no expiry", { exp: undefined }],
    ["unverified", { email_verified: false }],
    ["unverified string", { email_verified: "false" }],
    ["no email", { email: undefined }],
    ["nonce", { nonce: "OTHER" }],
  ];
  for (const [why, over] of bad) assert.throws(() => verifyIdTokenClaims(claims(over), { clientId: CLIENT_ID, now: NOW, nonce: "N" }), Error, why);
  assert.throws(() => verifyIdTokenClaims(claims(), { clientId: CLIENT_ID, now: NOW, nonce: "N" }), Error, "missing nonce when one was sent");
});

test("decodeJwtPayload reads the middle part and rejects anything else", () => {
  assert.equal(decodeJwtPayload(idToken({ a: 1 })).a, 1);
  for (const bad of ["", "a.b", "a.b.c.d", "x.###.y", `${b64url({})}.${Buffer.from("[1]").toString("base64url")}.s`]) assert.throws(() => decodeJwtPayload(bad), Error, bad);
});

test("escapeHtml escapes every character that could break out of text or an attribute", () => {
  assert.equal(escapeHtml(`<script>"x" & 'y'</script>`), "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;");
});

test("the consent page shows the app, where access goes and the family Skylight, escaping everything", () => {
  const html = consentPage({ clientName: `<img src=x onerror=alert(1)>`, clientId: "abc", redirectUri: "https://claude.ai/api/mcp/auth_callback", handle: `h"><b>` });
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes("claude.ai"));
  assert.ok(html.includes("This connects to the family Skylight."));
  assert.ok(html.includes(`value="h&quot;&gt;&lt;b&gt;"`));
  assert.match(html, /name="decision" value="approve"/);
  assert.match(html, /\(not verified\)\. It registered itself with this server\./);
  const cimd = consentPage({ clientName: "ChatGPT", clientId: "https://chatgpt.com/oauth/client.json", redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect", handle: "h" });
  assert.match(cimd, /Its description is published by chatgpt\.com\./);
  const local = consentPage({ clientName: "CLI", clientId: "abc", redirectUri: "http://localhost:3334/callback", handle: "h" });
  assert.match(local, /Allow Claude Code on this computer to use the family Skylight/);
});

test("the consent page names the family when SKYLIGHT_FAMILY_NAME is set, escaped", () => {
  const html = consentPage({ clientName: "Claude", clientId: "abc", redirectUri: "https://claude.ai/api/mcp/auth_callback", handle: "h", familyName: "Rivera <b>" });
  assert.ok(html.includes("This connects to the Rivera &lt;b&gt; family Skylight."));
  assert.ok(!html.includes("Rivera <b>"));
});

// ---- token exchange ----

test("exchangeGoogleCode posts the code with PKCE and returns the ID token", async () => {
  const { fetch, calls } = createMockFetch([{ method: "POST", path: "/token", json: { id_token: "ID.TOKEN.X", access_token: "ya29" } }]);
  const token = await exchangeGoogleCode({ fetch, clientId: CLIENT_ID, clientSecret: "google-secret-value", code: "G-CODE", codeVerifier: "VERIFIER", redirectUri: `${ORIGIN}/callback` });
  assert.equal(token, "ID.TOKEN.X");
  assert.equal(calls[0]!.url.toString(), "https://oauth2.googleapis.com/token");
  assert.deepEqual(calls[0]!.body, { grant_type: "authorization_code", code: "G-CODE", client_id: CLIENT_ID, client_secret: "google-secret-value", redirect_uri: `${ORIGIN}/callback`, code_verifier: "VERIFIER" });
});

test("a failed Google exchange names the status and Google's standard error code, never the body or the secret", async () => {
  const { fetch } = createMockFetch([{ method: "POST", path: "/token", status: 401, json: { error: "invalid_client", error_description: "Unauthorized", echo: "google-secret-value" } }]);
  await assert.rejects(
    exchangeGoogleCode({ fetch, clientId: CLIENT_ID, clientSecret: "google-secret-value", code: "G-CODE", codeVerifier: "V", redirectUri: `${ORIGIN}/callback` }),
    (e: unknown) => e instanceof Error && e.message === "Google token exchange failed (401 invalid_client).",
  );
});

test("the Google exchange is sent with redirect: manual (Workers rejects \"error\"), and a redirect answer is a failure", async () => {
  let redirect: RequestInit["redirect"];
  const { fetch } = createMockFetch([{ method: "POST", path: "/token", handler: ({ init }) => { redirect = init.redirect; return { json: { id_token: "ID.TOKEN.X" } }; } }]);
  await exchangeGoogleCode({ fetch, clientId: CLIENT_ID, clientSecret: "google-secret-value", code: "G-CODE", codeVerifier: "V", redirectUri: `${ORIGIN}/callback` });
  assert.equal(redirect, "manual");
  const { fetch: redirecting } = createMockFetch([{ method: "POST", path: "/token", status: 302, text: "" }]);
  await assert.rejects(
    exchangeGoogleCode({ fetch: redirecting, clientId: CLIENT_ID, clientSecret: "google-secret-value", code: "G-CODE", codeVerifier: "V", redirectUri: `${ORIGIN}/callback` }),
    (e: unknown) => e instanceof Error && e.message === "Google token exchange failed (302).",
  );
});

test("an error code outside OAuth's standard list is left out of the message", async () => {
  for (const error of ["google-secret-value", "<b>invalid_client</b>", 42]) {
    const { fetch } = createMockFetch([{ method: "POST", path: "/token", status: 400, json: { error } }]);
    await assert.rejects(
      exchangeGoogleCode({ fetch, clientId: CLIENT_ID, clientSecret: "google-secret-value", code: "G-CODE", codeVerifier: "V", redirectUri: `${ORIGIN}/callback` }),
      (e: unknown) => e instanceof Error && e.message === "Google token exchange failed (400).",
    );
  }
});

// ---- the /authorize and /callback handlers ----

async function startFlow(env: RemoteEnv = ENV, routes: MockRoute[] = []) {
  const fake = createFakeOAuth();
  const { fetch, calls } = createMockFetch(routes);
  const deps = { oauth: fake.oauth, env, fetch, now: () => NOW, identities: createMemoryKv() };
  const page = await handleAuthorize(new Request(`${ORIGIN}/authorize?client_id=client-1`), deps);
  return { fake, deps, page, calls };
}

async function approve(deps: Parameters<typeof handleAuthorize>[1], handle: string) {
  const body = new URLSearchParams({ handle, decision: "approve" });
  return handleAuthorize(new Request(`${ORIGIN}/authorize`, { method: "POST", body }), deps);
}

test("GET /authorize renders the consent page with the library's binding and anti-framing headers", async () => {
  const { page, fake } = await startFlow();
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /frame-ancestors 'none'/);
  // form-action would also govern the redirect to Google after Allow (and back to the app after Cancel).
  assert.doesNotMatch(csp, /form-action/);
  assert.match(page.headers.get("set-cookie") ?? "", /__Host-oauth-consent/);
  const html = await page.text();
  assert.match(html, /Claude/);
  assert.ok(fake.consents.has("handle-1"));
  assert.ok(html.includes('value="handle-1"'));
});

test("approving starts Google sign-in with PKCE and a state bound to this browser", async () => {
  const { deps, fake } = await startFlow();
  const res = await approve(deps, "handle-1");
  assert.equal(res.status, 302);
  const to = new URL(res.headers.get("location")!);
  assert.equal(to.origin, "https://accounts.google.com");
  assert.equal(to.searchParams.get("redirect_uri"), `${ORIGIN}/callback`);
  const state = to.searchParams.get("state")!;
  const saved = fake.upstreams.get(state)!;
  const data = saved.data as { verifier: string; nonce: string };
  assert.equal(to.searchParams.get("code_challenge"), createHash("sha256").update(data.verifier).digest("base64url"));
  assert.equal(to.searchParams.get("nonce"), data.nonce);
  assert.deepEqual(saved.request.scope, ["skylight"]);
  assert.match(res.headers.get("set-cookie") ?? "", /__Host-oauth-upstream/);
  // The consent handle works once.
  const again = await approve(deps, "handle-1");
  assert.equal(again.status, 400);
});

test("declining sends the app an access_denied redirect", async () => {
  const { deps } = await startFlow();
  const res = await handleAuthorize(new Request(`${ORIGIN}/authorize`, { method: "POST", body: new URLSearchParams({ handle: "handle-1", decision: "deny" }) }), deps);
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location") ?? "", /error=access_denied/);
});

async function callbackWith(tokenClaims: Record<string, unknown>, env: RemoteEnv = ENV) {
  const { deps, fake } = await startFlow(env);
  const res = await approve(deps, "handle-1");
  const to = new URL(res.headers.get("location")!);
  const state = to.searchParams.get("state")!;
  const nonce = to.searchParams.get("nonce")!;
  const { fetch, calls } = createMockFetch([{ method: "POST", path: "/token", json: { id_token: idToken({ ...tokenClaims, nonce }) } }]);
  const cbDeps = { ...deps, fetch };
  const cbUrl = `${ORIGIN}/callback?code=G-CODE&state=${state}`;
  const out = await handleCallback(new Request(cbUrl), cbDeps);
  return { out, fake, calls, cbDeps, cbUrl, state };
}

test("an allowlisted, verified Google account completes the MCP authorization as its lower-cased email", async () => {
  const { out, fake, calls } = await callbackWith(claims());
  assert.equal(out.status, 302);
  assert.match(out.headers.get("location") ?? "", /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?code=MCP-CODE/);
  assert.deepEqual(fake.completed, [{ userId: "jordan@example.com", scope: ["skylight"], props: { email: "jordan@example.com", name: "Jordan", sub: "123" }, metadata: { label: "Jordan" } }]);
  assert.equal((calls[0]!.body as Record<string, string>).code, "G-CODE");
});

test("a failed Google exchange shows the retry page and logs one line with Google's error code", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  const { deps } = await startFlow();
  const to = new URL((await approve(deps, "handle-1")).headers.get("location")!);
  const { fetch } = createMockFetch([{ method: "POST", path: "/token", status: 401, json: { error: "invalid_client", echo: "google-secret-value" } }]);
  const out = await handleCallback(new Request(`${ORIGIN}/callback?code=G-CODE&state=${to.searchParams.get("state")}`), { ...deps, fetch });
  assert.equal(out.status, 502);
  assert.equal(logged.mock.callCount(), 1);
  const line = String(logged.mock.calls[0]!.arguments[0]);
  assert.deepEqual(JSON.parse(line), { path: "/callback", error: "Google token exchange failed (401 invalid_client)." });
  assert.ok(!line.includes("google-secret-value") && !line.includes("G-CODE"));
});

test("the callback state works once", async () => {
  const { cbDeps, cbUrl, fake } = await callbackWith(claims());
  const again = await handleCallback(new Request(cbUrl), cbDeps);
  assert.equal(again.status, 400);
  assert.equal(fake.completed.length, 1);
});

test("an account that is not on the list gets the family-list page and no grant", async () => {
  for (const over of [{ email: "stranger@example.com" }, { email_verified: false }, { aud: "other" }, { exp: NOW / 1000 - 10 }]) {
    const { out, fake } = await callbackWith(claims(over));
    assert.equal(out.status, 403, JSON.stringify(over));
    const html = await out.text();
    assert.ok(html.includes(FAMILY_LIST_MESSAGE));
    assert.equal(FAMILY_LIST_MESSAGE, "This Google account is not on the family list.");
    assert.ok(!html.includes("stranger@example.com"));
    assert.equal(fake.completed.length, 0);
  }
});

test("Google sending back an error answers the app with access_denied", async () => {
  const { deps } = await startFlow();
  const res = await approve(deps, "handle-1");
  const state = new URL(res.headers.get("location")!).searchParams.get("state")!;
  const out = await handleCallback(new Request(`${ORIGIN}/callback?error=access_denied&state=${state}`), deps);
  assert.equal(out.status, 302);
  const to = new URL(out.headers.get("location")!);
  assert.equal(to.searchParams.get("error"), "access_denied");
  assert.equal(to.searchParams.get("state"), "client-state");
  assert.equal(to.searchParams.get("iss"), "https://example.test");
});

test("a server without its Google settings says it is not set up instead of starting sign-in", async () => {
  for (const env of [{ ...ENV, GOOGLE_CLIENT_SECRET: undefined }, { ...ENV, ALLOWED_EMAILS: "" }, {}]) {
    const { page } = await startFlow(env as RemoteEnv);
    assert.equal(page.status, 503);
    assert.match(await page.text(), /not finished setting up/);
  }
});

test("an invalid authorization request is rendered locally, or redirected only when the library vouches for the redirect", async () => {
  const local = createFakeOAuth({ parseError: Object.assign(new Error("bad"), { name: "AuthorizationError", code: "invalid_request", description: "Unknown <client>" }) });
  const res = await handleAuthorize(new Request(`${ORIGIN}/authorize`), { oauth: local.oauth, env: ENV, fetch: createMockFetch([]).fetch, now: () => NOW, identities: createMemoryKv() });
  assert.equal(res.status, 400);
  assert.ok((await res.text()).includes("Unknown &lt;client&gt;"));
  const redirect = createFakeOAuth({ parseError: Object.assign(new Error("bad"), { name: "AuthorizationError", code: "invalid_scope", description: "nope", redirectUri: "https://claude.ai/api/mcp/auth_callback", state: "s", issuer: "https://example.test" }) });
  const r2 = await handleAuthorize(new Request(`${ORIGIN}/authorize`), { oauth: redirect.oauth, env: ENV, fetch: createMockFetch([]).fetch, now: () => NOW, identities: createMemoryKv() });
  assert.equal(r2.status, 302);
  const to = new URL(r2.headers.get("location")!);
  assert.equal(to.searchParams.get("error"), "invalid_scope");
  assert.equal(to.searchParams.get("iss"), "https://example.test");
  const unknown = createFakeOAuth({ client: null });
  const r3 = await handleAuthorize(new Request(`${ORIGIN}/authorize`), { oauth: unknown.oauth, env: ENV, fetch: createMockFetch([]).fetch, now: () => NOW, identities: createMemoryKv() });
  assert.equal(r3.status, 400);
});
