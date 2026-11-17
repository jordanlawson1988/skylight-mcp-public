import { test } from "node:test";
import assert from "node:assert/strict";
import { providerPolicy } from "../../src/remote/provider-options.js";
import { familyLabel } from "../../src/remote/env.js";
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
  assert.equal(p.resourceMetadata.resource_name, "Family Skylight");
});

test("the provider policy names the family when one is configured", () => {
  assert.equal(providerPolicy("https://x.example.workers.dev", "Rivera").resourceMetadata.resource_name, "Rivera family Skylight");
});

test("familyLabel: no name, a blank name or a missing var gives the generic label; a name is trimmed, collapsed and capped at 40 characters", () => {
  assert.equal(familyLabel(undefined), "family Skylight");
  assert.equal(familyLabel("   "), "family Skylight");
  assert.equal(familyLabel("  The   Riveras "), "The Riveras family Skylight");
  assert.equal(familyLabel("x".repeat(60)), `${"x".repeat(40)} family Skylight`);
});
