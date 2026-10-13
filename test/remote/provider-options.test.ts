import { test } from "node:test";
import assert from "node:assert/strict";
import { providerPolicy } from "../../src/remote/provider-options.js";
import { clientRegistrationCallback } from "../../src/remote/redirects.js";

test("the provider policy: one-hour tokens, DCR at /register guarded by the redirect allowlist, CIMD, resource = <origin>/mcp", () => {
  const p = providerPolicy("https://skylight-mcp.example.workers.dev");
  assert.equal(p.accessTokenTTL, 3600);
  assert.equal(p.clientRegistrationEndpoint, "/register");
  assert.equal(p.tokenEndpoint, "/token");
  assert.equal(p.authorizeEndpoint, "/authorize");
  assert.equal(p.clientIdMetadataDocumentEnabled, true);
  assert.equal(p.clientRegistrationCallback, clientRegistrationCallback);
  assert.deepEqual(p.scopesSupported, ["skylight"]);
  assert.equal(p.resourceMetadata.resource, "https://skylight-mcp.example.workers.dev/mcp");
});
