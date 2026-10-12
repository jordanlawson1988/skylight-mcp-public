#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { assertMacOS, createRuntime } from "./runtime.js";
import { createServer } from "./server-core.js";
import { VERSION } from "./version.js";

export { createServer } from "./server-core.js";

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
