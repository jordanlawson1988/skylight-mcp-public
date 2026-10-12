#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertMacOS, createRuntime } from "./runtime.js";
import type { ToolContext } from "./tools/context.js";
import { registerAllTools } from "./tools/index.js";
import { VERSION } from "./version.js";

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: "skylight-mcp", version: VERSION },
    { instructions: "Unofficial Skylight Calendar tools for chores, rewards and profiles. Destructive tools (delete chore, delete profile) require confirm: true; always show the user what will be deleted and get their agreement first. To retire a person without losing their events, prefer skylight_update_profile with kind \"label\" over deleting the profile." }
  );
  registerAllTools(server, ctx);
  return server;
}

async function main(): Promise<void> {
  assertMacOS();
  const server = createServer(createRuntime());
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[skylight-mcp] ${VERSION} ready on stdio\n`);
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

if (isDirectRun()) {
  main().catch((e) => {
    process.stderr.write(`[skylight-mcp] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
