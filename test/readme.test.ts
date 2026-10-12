import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectTestClient } from "./helpers/test-server.js";
import { TOOLSETS } from "../src/skylight/vocab.js";

const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

test("the README tool table documents every registered tool, and names no tool that does not exist", async () => {
  const t = await connectTestClient([]);
  const names = (await t.client.listTools()).tools.map((x) => x.name);
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
