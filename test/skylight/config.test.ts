import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/node/config.js";
import { CONFIG_ENV_KEYS, parseConfig } from "../../src/skylight/config.js";
import { ValidationError } from "../../src/skylight/errors.js";
import { TOOLSETS } from "../../src/skylight/vocab.js";

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

test("SKYLIGHT_TOOLSETS defaults to every toolset and is not explicit", () => {
  const c = loadConfig({});
  assert.deepEqual([...c.toolsets], [...TOOLSETS]);
  assert.equal(c.toolsetsExplicit, false);
  assert.deepEqual([...loadConfig({ SKYLIGHT_TOOLSETS: "  " }).toolsets], [...TOOLSETS]);
  assert.equal(loadConfig({ SKYLIGHT_TOOLSETS: "" }).toolsetsExplicit, false);
});

test("SKYLIGHT_TOOLSETS picks a comma list: trimmed, lower-cased, de-duplicated, empties ignored", () => {
  const c = loadConfig({ SKYLIGHT_TOOLSETS: " Chores, lists ,chores,," });
  assert.deepEqual([...c.toolsets], ["chores", "lists"]);
  assert.equal(c.toolsetsExplicit, true);
});

test("SKYLIGHT_TOOLSETS rejects unknown names, naming them and the valid choices, and an empty list", () => {
  assert.throws(() => loadConfig({ SKYLIGHT_TOOLSETS: "chores,bogus" }), (e: unknown) => e instanceof ValidationError && e.field === "SKYLIGHT_TOOLSETS" && /"bogus"/.test(e.message) && /meals/.test(e.message));
  assert.throws(() => loadConfig({ SKYLIGHT_TOOLSETS: "chores,nope,worse" }), (e: unknown) => e instanceof ValidationError && /"nope"/.test(e.message) && /"worse"/.test(e.message));
  assert.throws(() => loadConfig({ SKYLIGHT_TOOLSETS: " , " }), (e: unknown) => e instanceof ValidationError && e.field === "SKYLIGHT_TOOLSETS");
});

test("parseConfig is the pure core: same settings as loadConfig, no credentialsDir, unrelated keys ignored", () => {
  const env = { SKYLIGHT_TIMEZONE: "America/Chicago", SKYLIGHT_TOOLSETS: "chores", SKYLIGHT_FRAME_ID: "42", SKYLIGHT_TOKEN_KEY: "not a setting", OTHER: "x" };
  const pure = parseConfig(env);
  assert.equal("credentialsDir" in pure, false);
  assert.equal(pure.timezone, "America/Chicago");
  assert.equal(pure.frameId, "42");
  assert.deepEqual([...pure.toolsets], ["chores"]);
  const { credentialsDir, ...node } = loadConfig(env);
  assert.ok(credentialsDir.length > 0);
  assert.deepEqual(node, pure);
});

test("CONFIG_ENV_KEYS lists exactly the variables parseConfig reads", () => {
  assert.deepEqual([...CONFIG_ENV_KEYS].sort(), ["SKYLIGHT_API_BASE", "SKYLIGHT_FRAME_ID", "SKYLIGHT_REQUEST_TIMEOUT_MS", "SKYLIGHT_TIMEZONE", "SKYLIGHT_TOOLSETS"]);
  assert.throws(() => parseConfig({ SKYLIGHT_REQUEST_TIMEOUT_MS: "0" }), ValidationError);
  assert.throws(() => parseConfig({ SKYLIGHT_API_BASE: "ftp://x" }), ValidationError);
});
