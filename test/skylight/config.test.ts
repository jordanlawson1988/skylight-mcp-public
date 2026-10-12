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
  assert.equal(c.timezone, "America/New_York");
  assert.equal(c.timezoneExplicit, false);
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

test("SKYLIGHT_TIMEZONE sets the zone, is validated, and marks itself explicit", () => {
  const c = loadConfig({ SKYLIGHT_TIMEZONE: " Europe/London " });
  assert.deepEqual([c.timezone, c.timezoneExplicit], ["Europe/London", true]);
  assert.equal(loadConfig({ SKYLIGHT_TIMEZONE: "" }).timezoneExplicit, false);
  assert.throws(() => loadConfig({ SKYLIGHT_TIMEZONE: "Mars/Olympus" }), (e: unknown) => e instanceof ValidationError && e.field === "SKYLIGHT_TIMEZONE");
  assert.throws(() => loadConfig({ SKYLIGHT_TIMEZONE: "EST5EDT garbage" }), ValidationError);
});
