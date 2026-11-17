import { test } from "node:test";
import assert from "node:assert/strict";
import type { RemoteEnv } from "../../src/remote/env.js";
import { handleAuthorize } from "../../src/remote/google.js";
import { isAllowedCimdClientId, isCimdClientId } from "../../src/remote/redirects.js";
import { createFakeOAuth } from "../helpers/fake-oauth.js";
import { createMemoryKv } from "../helpers/memory-kv.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

const ORIGIN = "https://skylight-mcp-staging.example.workers.dev";
const ENV: RemoteEnv = { GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret-value", ALLOWED_EMAILS: "jordan@example.com" };

function authorize(fake: ReturnType<typeof createFakeOAuth>, query: string) {
  return handleAuthorize(new Request(`${ORIGIN}/authorize?${query}`), { oauth: fake.oauth, env: ENV, fetch: createMockFetch([]).fetch, now: () => Date.now(), identities: createMemoryKv() });
}

test("any client_id containing :// is URL-shaped, whatever the scheme's case", () => {
  for (const id of ["https://claude.ai/c", "HTTPS://evil.example/c", "hTtPs://evil.example/c", "http://x.test/c", "ftp://x.test/c", "javascript://x", "a://b"]) {
    assert.equal(isCimdClientId(id), true, id);
  }
  for (const id of ["3fGhTq9a", "abc:def", "https:/single-slash", ""]) assert.equal(isCimdClientId(id), false, id);
});

test("isAllowedCimdClientId parses the URL and compares the protocol and lower-cased hostname exactly", () => {
  for (const ok of ["HTTPS://claude.ai/oauth/c.json", "hTtPs://chatgpt.com/c", "https://CLAUDE.AI/c", "https://OpenAI.com/c"]) assert.equal(isAllowedCimdClientId(ok), true, ok);
  for (const bad of ["HTTPS://evil.example/c", "hTtPs://EVIL.example/c", "HTTP://claude.ai/c", "ftp://claude.ai/c", "https://claude.ai.EVIL.example/c", "https://CLAUDE.ai:444/c", "https:/claude.ai/c"]) {
    assert.equal(isAllowedCimdClientId(bad), false, bad);
  }
});

test("/authorize refuses upper- and mixed-case CIMD ids for foreign hosts before the library sees them", async () => {
  for (const id of ["HTTPS://evil.example/client.json", "hTtPs://evil.example/client.json", "HTTPS://EVIL.EXAMPLE/client.json"]) {
    const fake = createFakeOAuth({ request: { clientId: id } });
    const res = await authorize(fake, `client_id=${encodeURIComponent(id)}`);
    assert.equal(res.status, 400, id);
    assert.equal(await res.text(), "This app cannot connect to the family Skylight.");
    assert.equal(fake.counts.parse, 0, `${id}: parseAuthRequest was not called`);
  }
});

test("a parsed request whose client id is a mixed-case foreign URL is refused too", async () => {
  const fake = createFakeOAuth({ request: { clientId: "HTTPS://evil.example/c" } });
  const res = await authorize(fake, "client_id=client-1");
  assert.equal(res.status, 400);
});

test("an authorization error redirects only to an allowlisted redirect_uri; otherwise it is a plain error page", async () => {
  const errorFor = (redirectUri: string) => Object.assign(new Error("bad"), { name: "AuthorizationError", code: "invalid_scope", description: "Scope not allowed", redirectUri, state: "s", issuer: ORIGIN });
  for (const redirectUri of ["https://attacker.example/cb", "HTTPS://claude.ai/api/mcp/auth_callback", "https://claude.ai/api/mcp/auth_callback/"]) {
    const res = await authorize(createFakeOAuth({ parseError: errorFor(redirectUri) }), "client_id=client-1");
    assert.notEqual(res.status, 302, redirectUri);
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("location"), null);
    assert.match(await res.text(), /Scope not allowed/);
  }
  const ok = await authorize(createFakeOAuth({ parseError: errorFor("https://claude.ai/api/mcp/auth_callback") }), "client_id=client-1");
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get("location") ?? "", /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?error=invalid_scope/);
});
