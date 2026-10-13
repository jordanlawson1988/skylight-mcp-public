import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_REDIRECT_URIS, CIMD_CLIENT_HOSTS, clientRegistrationCallback, isAllowedCimdClientId, isAllowedRedirectUri, isCimdClientId,
} from "../../src/remote/redirects.js";

test("the exact redirect allowlist: Claude, ChatGPT and loopback /callback for Claude Code", () => {
  assert.deepEqual([...ALLOWED_REDIRECT_URIS], [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
  ]);
  for (const ok of [
    ...ALLOWED_REDIRECT_URIS,
    "https://chatgpt.com/connector/oauth/abc_DEF-123",
    "http://localhost:3334/callback",
    "http://127.0.0.1:65535/callback",
    "http://localhost:1/callback",
  ]) assert.equal(isAllowedRedirectUri(ok), true, ok);
});

test("anything else is refused, including near misses", () => {
  for (const bad of [
    "https://claude.ai/api/mcp/auth_callback/",
    "https://claude.ai/api/mcp/auth_callback?x=1",
    "https://claude.ai/api/mcp/auth_callback#f",
    "http://claude.ai/api/mcp/auth_callback",
    "https://CLAUDE.ai/api/mcp/auth_callback",
    "https://evil.claude.ai/api/mcp/auth_callback",
    "https://claude.ai.evil.test/api/mcp/auth_callback",
    "https://claude.ai:443/api/mcp/auth_callback",
    "https://chatgpt.com/connector/oauth/",
    "https://chatgpt.com/connector/oauth/a/b",
    "https://chatgpt.com/connector/oauth/a.b",
    "https://chatgpt.com/connector/oauth/a%2Fb",
    "https://chatgpt.com/connector_platform_oauth_redirect/x",
    "http://localhost/callback",
    "http://localhost:3334/other",
    "http://localhost:3334/callback/",
    "http://localhost:3334/callback?x=1",
    "https://localhost:3334/callback",
    "http://localhost:99999/callback",
    "http://localhost:0/callback",
    "http://127.0.0.2:3334/callback",
    "http://[::1]:3334/callback",
    "http://user@localhost:3334/callback",
    "https://attacker.example/callback",
    "",
    " https://claude.ai/api/mcp/auth_callback",
  ]) assert.equal(isAllowedRedirectUri(bad), false, bad);
  for (const notString of [undefined, null, 5, ["https://claude.ai/api/mcp/auth_callback"], {}]) assert.equal(isAllowedRedirectUri(notString), false);
});

test("CIMD client ids are allowed only from Claude's and OpenAI's own hosts", () => {
  assert.deepEqual([...CIMD_CLIENT_HOSTS], ["claude.ai", "claude.com", "chatgpt.com", "openai.com"]);
  assert.equal(isCimdClientId("https://claude.ai/oauth/claude-client.json"), true);
  assert.equal(isCimdClientId("3fGhTq9a"), false);
  for (const ok of ["https://claude.ai/oauth/client.json", "https://claude.com/x", "https://chatgpt.com/oauth/client", "https://openai.com/c.json"]) {
    assert.equal(isAllowedCimdClientId(ok), true, ok);
  }
  for (const bad of ["https://evil.example/client.json", "https://claude.ai.evil.example/c", "https://sub.chatgpt.com/c", "http://claude.ai/c", "https://user@claude.ai/c", "https://claude.ai:8443/c", "not a url"]) {
    assert.equal(isAllowedCimdClientId(bad), false, bad);
  }
});

test("dynamic client registration is refused unless every redirect_uri is on the allowlist", () => {
  const call = (clientMetadata: Record<string, unknown>) => clientRegistrationCallback({ clientMetadata, request: new Request("https://x.test/register", { method: "POST" }) });
  assert.equal(call({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }), undefined);
  assert.equal(call({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "http://localhost:4000/callback"] }), undefined);
  for (const bad of [
    { redirect_uris: ["https://claude.ai/api/mcp/auth_callback", "https://attacker.example/cb"] },
    { redirect_uris: [] },
    { redirect_uris: "https://claude.ai/api/mcp/auth_callback" },
    { redirect_uris: [5] },
    {},
  ]) {
    const r = call(bad as Record<string, unknown>);
    assert.ok(r, JSON.stringify(bad));
    assert.equal(r.code, "invalid_redirect_uri");
    assert.equal(r.status, 400);
    assert.ok(!(r.description ?? "").includes("attacker"), "the refusal does not echo the input");
  }
});
