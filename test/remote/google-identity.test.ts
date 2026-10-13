import { test } from "node:test";
import assert from "node:assert/strict";
import type { RemoteEnv } from "../../src/remote/env.js";
import { FAMILY_LIST_MESSAGE, handleAuthorize, handleCallback, parseAllowlist, verifyIdTokenClaims } from "../../src/remote/google.js";
import { identityKey } from "../../src/remote/identity.js";
import { createFakeOAuth } from "../helpers/fake-oauth.js";
import { createMemoryKv } from "../helpers/memory-kv.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

const CLIENT_ID = "google-client.apps.googleusercontent.com";
const ORIGIN = "https://skylight-mcp-staging.example.workers.dev";
const ENV: RemoteEnv = { GOOGLE_CLIENT_ID: CLIENT_ID, GOOGLE_CLIENT_SECRET: "google-secret-value", ALLOWED_EMAILS: "jordan@example.com" };
const NOW = Date.parse("2026-10-12T12:00:00Z");

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const idToken = (claims: Record<string, unknown>) => `${b64url({ alg: "RS256" })}.${b64url(claims)}.sig`;
const claims = (over: Record<string, unknown> = {}) => ({ iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "google-sub-1", email: "jordan@example.com", email_verified: true, name: "Jordan", exp: NOW / 1000 + 3600, ...over });

/** One full sign-in: consent page, Allow, Google's callback with an ID token carrying `tokenClaims`. */
async function signIn(identities: ReturnType<typeof createMemoryKv>, tokenClaims: Record<string, unknown>) {
  const fake = createFakeOAuth();
  const deps = { oauth: fake.oauth, env: ENV, fetch: createMockFetch([]).fetch, now: () => NOW, identities };
  await handleAuthorize(new Request(`${ORIGIN}/authorize?client_id=client-1`), deps);
  const approved = await handleAuthorize(new Request(`${ORIGIN}/authorize`, { method: "POST", body: new URLSearchParams({ handle: "handle-1", decision: "approve" }) }), deps);
  const to = new URL(approved.headers.get("location")!);
  const { fetch } = createMockFetch([{ method: "POST", path: "/token", json: { id_token: idToken({ ...tokenClaims, nonce: to.searchParams.get("nonce") }) } }]);
  const out = await handleCallback(new Request(`${ORIGIN}/callback?code=G&state=${to.searchParams.get("state")}`), { ...deps, fetch });
  return { out, fake };
}

test("the first sign-in binds the email to the Google sub and puts sub in the grant's props", async () => {
  const identities = createMemoryKv();
  const { out, fake } = await signIn(identities, claims());
  assert.equal(out.status, 302);
  assert.equal(identities.data.get(identityKey("jordan@example.com")), "google-sub-1");
  assert.deepEqual(fake.completed[0]!.props, { email: "jordan@example.com", name: "Jordan", sub: "google-sub-1" });
  const again = await signIn(identities, claims());
  assert.equal(again.out.status, 302, "the same Google account signs in again");
});

test("a different Google account claiming a bound email gets the family-list page and no grant", async () => {
  const identities = createMemoryKv();
  await signIn(identities, claims());
  const { out, fake } = await signIn(identities, claims({ sub: "google-sub-ATTACKER" }));
  assert.equal(out.status, 403);
  assert.ok((await out.text()).includes(FAMILY_LIST_MESSAGE));
  assert.equal(fake.completed.length, 0);
  assert.equal(identities.data.get(identityKey("jordan@example.com")), "google-sub-1", "the binding is unchanged");
});

test("an ID token without a usable sub, or with a non-ASCII email, is refused", () => {
  for (const over of [{ sub: undefined }, { sub: "" }, { sub: 5 }, { sub: "has space" }, { email: "jоrdan@example.com" }]) {
    assert.throws(() => verifyIdTokenClaims(claims(over), { clientId: CLIENT_ID, now: NOW }), Error, JSON.stringify(over));
  }
});

test("ALLOWED_EMAILS refuses entries that are not plain ASCII emails", () => {
  assert.throws(() => parseAllowlist("jordan@example.com,jоrdan@example.com"), /ALLOWED_EMAILS/);
  assert.throws(() => parseAllowlist("jordan@localhost"), /ALLOWED_EMAILS/);
});
