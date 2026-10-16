import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectTestClient } from "./helpers/test-server.js";
import { TOOLSETS } from "../src/skylight/vocab.js";
import { REMOTE_ONLY_TOOLS } from "../src/remote/activity-tool.js";
import { REMOTE_COMMANDS } from "../src/cli/remote.js";
import { REMOTE_SECRETS } from "../src/remote/env.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("the README tool table documents every registered tool (stdio and shared server), and names no tool that does not exist", async () => {
  const t = await connectTestClient([]);
  const names = [...(await t.client.listTools()).tools.map((x) => x.name), ...REMOTE_ONLY_TOOLS];
  await t.close();
  const rows = new Set([...readme.matchAll(/^\| `(skylight_[a-z_]+)` \|/gm)].map((m) => m[1]!));
  for (const name of names) assert.ok(rows.has(name), `README is missing a row for ${name}`);
  for (const row of rows) assert.ok(names.includes(row), `README documents ${row}, which is not registered`);
});

test("the README documents SKYLIGHT_TOOLSETS and every toolset name", () => {
  assert.match(readme, /SKYLIGHT_TOOLSETS/);
  assert.match(readme, /trim the tool list/);
  for (const toolset of TOOLSETS) assert.ok(readme.includes(`| \`${toolset}\` |`), `README toolset table lacks ${toolset}`);
});

test("the server instructions cover the confirm-gated and email-sending actions", async () => {
  const t = await connectTestClient([]);
  const instructions = t.client.getInstructions() ?? "";
  await t.close();
  for (const phrase of ["confirmName", "invitedEmails", "confirmInvites", "permanent", "applyTo", "SKYLIGHT_TOOLSETS"]) assert.ok(instructions.includes(phrase), `instructions lack ${phrase}`);
});

test("the README explains the shared server: every remote command, every secret, the redirect and connector URLs", () => {
  const start = readme.indexOf("## Use from Claude, ChatGPT and Gemini on any device");
  assert.ok(start > 0, "README lacks the shared-server section");
  const section = readme.slice(start, readme.indexOf("\n## ", start + 10));
  for (const cmd of REMOTE_COMMANDS) assert.ok(section.includes(`skylight-mcp remote ${cmd}`), `section lacks remote ${cmd}`);
  for (const secret of REMOTE_SECRETS) assert.ok(section.includes(secret), `section lacks ${secret}`);
  for (const phrase of ["npx wrangler login", "/callback", ".workers.dev/mcp", "This Google account is not on the family list.", "skylight_recent_activity", "90 days", "Developer mode", "Add custom connector", "Custom apps", "Keep Activity", "oauth-redirect.googleusercontent.com"]) {
    assert.ok(section.includes(phrase), `section lacks ${phrase}`);
  }
});
