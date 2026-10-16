import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GLOBAL_RATE_LIMITS, IP_RATE_LIMITS, RATE_LIMIT_PERIOD_SECONDS } from "../../src/remote/edge-guard.js";
import { ACCOUNT_OBJECT_NAME, REMOTE_SECRETS } from "../../src/remote/env.js";

/** Strips // and /* *\/ comments outside strings, then parses (wrangler.jsonc has no trailing commas). */
function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") { out += text[++i] ?? ""; continue; }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return JSON.parse(out);
}

interface EnvConfig {
  name: string;
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
  kv_namespaces: Array<{ binding: string; id?: string }>;
  ratelimits: Array<{ name: string; namespace_id: string; simple: { limit: number; period: number } }>;
  vars: Record<string, string>;
  secrets?: unknown;
  workers_dev: boolean;
  preview_urls: boolean;
}

const raw = readFileSync(new URL("../../wrangler.jsonc", import.meta.url), "utf8");
const config = parseJsonc(raw) as EnvConfig & {
  main: string; compatibility_date: string; compatibility_flags: string[];
  observability: { enabled: boolean; head_sampling_rate: number; redact_query_string: boolean; logs: { invocation_logs: boolean } };
  env: { staging: EnvConfig; production: EnvConfig };
};

test("wrangler.jsonc: one Worker entry, the compat flags CIMD needs, two environments with their own names", () => {
  // The top level is a local default only: deploys always name --env staging or --env production.
  assert.equal(config.name, "skylight-mcp-dev");
  assert.equal(config.workers_dev, false);
  assert.equal(config.main, "src/remote/worker.ts");
  assert.equal(config.compatibility_date, "2026-09-27");
  assert.deepEqual([...config.compatibility_flags].sort(), ["global_fetch_strictly_public", "nodejs_compat"]);
  assert.equal(config.env.staging.name, "skylight-mcp-staging");
  assert.equal(config.env.production.name, "skylight-mcp");
});

test("every environment repeats the Durable Object, its SQLite migration, the KV namespace and the vars", () => {
  for (const [label, env] of [["top", config], ["staging", config.env.staging], ["production", config.env.production]] as const) {
    assert.deepEqual(env.durable_objects.bindings, [{ name: "SKYLIGHT_ACCOUNT", class_name: "SkylightAccount" }], label);
    assert.deepEqual(env.migrations, [{ tag: "v1", new_sqlite_classes: ["SkylightAccount"] }], label);
    assert.deepEqual(env.kv_namespaces, [{ binding: "OAUTH_KV" }], label);
    assert.deepEqual(env.vars, { SKYLIGHT_TIMEZONE: "America/New_York" }, label);
    assert.equal(env.preview_urls, false, label);
  }
  assert.equal(ACCOUNT_OBJECT_NAME, "family");
  assert.equal(config.env.staging.workers_dev, true);
  assert.equal(config.env.production.workers_dev, true);
});

test("every environment has the per-client and global rate limiters with edge-guard's numbers and its own namespace ids", () => {
  const expected = [...Object.values(IP_RATE_LIMITS), ...Object.values(GLOBAL_RATE_LIMITS)].map((r) => ({ name: r.binding, limit: r.limit, period: RATE_LIMIT_PERIOD_SECONDS })).sort((a, b) => a.name.localeCompare(b.name));
  const ids: string[] = [];
  for (const [label, env] of [["top", config], ["staging", config.env.staging], ["production", config.env.production]] as const) {
    const got = env.ratelimits.map((r) => ({ name: r.name, limit: r.simple.limit, period: r.simple.period })).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(got, expected, label);
    for (const r of env.ratelimits) { assert.match(r.namespace_id, /^[1-9][0-9]*$/, label); ids.push(r.namespace_id); }
  }
  assert.equal(new Set(ids).size, ids.length, "namespace ids are unique across environments");
});

test("the npm scripts only deploy or run a named environment", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  for (const [name, cmd] of Object.entries(pkg.scripts).filter(([, c]) => /\bwrangler\b/.test(c))) {
    assert.match(cmd, /--env (staging|production)\b/, name);
  }
});

test("no environment declares required secrets (a new Worker could never deploy), and no secret is a plain var", () => {
  // wrangler refuses to deploy while a `secrets.required` name is unset, and secrets cannot be set on a Worker that
  // does not exist yet, so the first deploy would always fail. The Worker fails closed on each missing secret instead.
  for (const [label, env] of [["top", config], ["staging", config.env.staging], ["production", config.env.production]] as const) {
    assert.equal(env.secrets, undefined, label);
    for (const name of REMOTE_SECRETS) assert.ok(!(name in env.vars), `${name} must not be a var`);
  }
});

test("logging: invocation logs off and query strings redacted (the Worker logs method, path, status, duration)", () => {
  assert.equal(config.observability.enabled, true);
  assert.equal(config.observability.head_sampling_rate, 1);
  assert.equal(config.observability.redact_query_string, true);
  assert.equal(config.observability.logs.invocation_logs, false);
});
