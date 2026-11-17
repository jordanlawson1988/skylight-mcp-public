import { test } from "node:test";
import assert from "node:assert/strict";
import { consentPage } from "../../src/remote/google.js";
import { APP_NAMES, appNameForRedirect } from "../../src/remote/redirects.js";

const WARNING = "Only continue if you just started connecting from Claude, ChatGPT or Gemini.";

test("the app is named from its redirect host, not from what it calls itself", () => {
  assert.deepEqual({ ...APP_NAMES }, { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini", claudeCode: "Claude Code on this computer" });
  assert.equal(appNameForRedirect("https://claude.ai/api/mcp/auth_callback"), "Claude");
  assert.equal(appNameForRedirect("https://claude.com/api/mcp/auth_callback"), "Claude");
  assert.equal(appNameForRedirect("https://chatgpt.com/connector_platform_oauth_redirect"), "ChatGPT");
  assert.equal(appNameForRedirect("https://chatgpt.com/connector/oauth/abc"), "ChatGPT");
  assert.equal(appNameForRedirect("http://localhost:3334/callback"), "Claude Code on this computer");
  assert.equal(appNameForRedirect("http://127.0.0.1:3334/callback"), "Claude Code on this computer");
  assert.equal(appNameForRedirect("https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-abc123-skylight-mcp_example_workers_dev"), "Gemini");
  assert.equal(appNameForRedirect("https://oauth-redirect.googleusercontent.com/r/my-actions-project"), "an unknown app");
  assert.equal(appNameForRedirect("https://attacker.example/cb"), "an unknown app");
});

test("the heading names the app from the redirect; the self-reported name is small print, marked unverified", () => {
  const html = consentPage({ clientName: "Totally Claude <b>", clientId: "abc", redirectUri: "https://chatgpt.com/connector_platform_oauth_redirect", handle: "h" });
  assert.match(html, /<h1>Allow ChatGPT to use the family Skylight\?<\/h1>/);
  assert.match(html, /<title>Allow ChatGPT\?<\/title>/);
  assert.ok(!/<h1>[^<]*Totally Claude/.test(html), "the client's own name is not in the heading");
  assert.match(html, /<p class="muted">The app calls itself &quot;Totally Claude &lt;b&gt;&quot; \(not verified\)\./);
});

test("every client gets the only-continue-if-you-started-it warning", () => {
  for (const redirectUri of ["https://claude.ai/api/mcp/auth_callback", "https://chatgpt.com/connector/oauth/abc", "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-abc", "http://localhost:3334/callback"]) {
    const html = consentPage({ clientName: "X", clientId: "abc", redirectUri, handle: "h" });
    assert.ok(html.includes(WARNING), redirectUri);
  }
  const local = consentPage({ clientName: "X", clientId: "abc", redirectUri: "http://localhost:3334/callback", handle: "h" });
  assert.match(local, /<h1>Allow Claude Code on this computer to use the family Skylight\?<\/h1>/);
  const gemini = consentPage({ clientName: "X", clientId: "abc", redirectUri: "https://oauth-redirect.googleusercontent.com/r/user_bound_custom-mcp-abc", handle: "h" });
  assert.match(gemini, /<h1>Allow Gemini to use the family Skylight\?<\/h1>/);
});
