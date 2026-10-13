import { test } from "node:test";
import assert from "node:assert/strict";
import type { RemoteEnv } from "../../src/remote/env.js";
import { handleAuthorize } from "../../src/remote/google.js";
import { createFakeOAuth } from "../helpers/fake-oauth.js";
import { createMemoryKv } from "../helpers/memory-kv.js";
import { createMockFetch } from "../helpers/mock-fetch.js";

const ORIGIN = "https://skylight-mcp-staging.example.workers.dev";
const ENV: RemoteEnv = { GOOGLE_CLIENT_ID: "google-client", GOOGLE_CLIENT_SECRET: "google-secret-value", ALLOWED_EMAILS: "jordan@example.com" };

async function authorizeWith(fake: ReturnType<typeof createFakeOAuth>, query = "client_id=client-1") {
  return handleAuthorize(new Request(`${ORIGIN}/authorize?${query}`), { oauth: fake.oauth, env: ENV, fetch: createMockFetch([]).fetch, now: () => Date.now(), identities: createMemoryKv() });
}

async function assertRefused(res: Response) {
  assert.equal(res.status, 400);
  assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
  assert.equal(await res.text(), "This app cannot connect to the family Skylight.");
}

test("/authorize refuses a CIMD client from any host but Claude's and OpenAI's, before fetching its metadata", async () => {
  const evilId = "https://evil.example/client.json";
  const fake = createFakeOAuth({ request: { clientId: evilId } });
  await assertRefused(await authorizeWith(fake, `client_id=${encodeURIComponent(evilId)}`));
  assert.equal(fake.counts.parse, 0, "parseAuthRequest (which fetches the CIMD document) was not called");
  assert.equal(fake.counts.consent, 0);
  // Even if the query and the parsed request disagree, the parsed client id is checked too.
  const sneaky = createFakeOAuth({ request: { clientId: evilId } });
  await assertRefused(await authorizeWith(sneaky, "client_id=client-1"));
  const claudeId = "https://claude.ai/oauth/claude-client.json";
  const claude = createFakeOAuth({ request: { clientId: claudeId } });
  assert.equal((await authorizeWith(claude, `client_id=${encodeURIComponent(claudeId)}`)).status, 200);
});

test("/authorize re-checks every registered redirect_uri and the requested one against the allowlist", async () => {
  const registered = createFakeOAuth({ client: { redirectUris: ["https://claude.ai/api/mcp/auth_callback", "https://attacker.example/cb"] } });
  await assertRefused(await authorizeWith(registered));
  assert.equal(registered.counts.consent, 0);
  const requested = createFakeOAuth({ request: { redirectUri: "https://attacker.example/cb" }, client: { redirectUris: ["https://attacker.example/cb"] } });
  await assertRefused(await authorizeWith(requested));
  const chatgpt = createFakeOAuth({ request: { redirectUri: "https://chatgpt.com/connector/oauth/abc123" } });
  assert.equal((await authorizeWith(chatgpt)).status, 200);
  const claudeCode = createFakeOAuth({ request: { redirectUri: "http://localhost:43123/callback" } });
  assert.equal((await authorizeWith(claudeCode)).status, 200);
});
