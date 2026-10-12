import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/skylight/config.js";
import { ValidationError } from "../../src/skylight/errors.js";

test("defaults", () => {
  const c = loadConfig({});
  assert.equal(c.apiBaseUrl, "https://app.ourskylight.com");
  assert.equal(c.apiVersion, "2026-05-01");
  assert.equal(c.requestTimeoutMs, 30000);
  assert.equal(c.frameId, null);
  assert.match(c.credentialsDir, /Library\/Application Support\/skylight-mcp\/credentials$/);
});

test("overrides and validation", () => {
  assert.equal(loadConfig({ SKYLIGHT_API_BASE: "https://example.test/" }).apiBaseUrl, "https://example.test");
  assert.equal(loadConfig({ SKYLIGHT_API_BASE: "http://127.0.0.1:8080" }).apiBaseUrl, "http://127.0.0.1:8080");
  assert.throws(() => loadConfig({ SKYLIGHT_API_BASE: "http://example.test" }), ValidationError);
  assert.throws(() => loadConfig({ SKYLIGHT_API_BASE: "https://example.test/api?x=1" }), ValidationError);
  assert.equal(loadConfig({ SKYLIGHT_FRAME_ID: "123" }).frameId, "123");
  assert.throws(() => loadConfig({ SKYLIGHT_FRAME_ID: "../x" }), ValidationError);
  assert.equal(loadConfig({ SKYLIGHT_CREDENTIALS_DIR: "/tmp/x" }).credentialsDir, "/tmp/x");
  assert.throws(() => loadConfig({ SKYLIGHT_REQUEST_TIMEOUT_MS: "abc" }), ValidationError);
});
