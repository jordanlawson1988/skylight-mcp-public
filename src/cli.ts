#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { completeLogin, logout, startLogin, status } from "./cli/commands.js";
import { doctor } from "./cli/doctor.js";
import { assertMacOS, createRuntime } from "./runtime.js";
import { VERSION } from "./version.js";

const USAGE = `skylight-mcp ${VERSION}

Usage:
  skylight-mcp login [--callback <url>] [--pkce S256|plain]   Sign in via Skylight's web page
  skylight-mcp logout                                        Remove the stored credential
  skylight-mcp status                                        Show login and frame status (no secrets)
  skylight-mcp doctor                                        Check setup and print Claude Desktop config
`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") { stdout.write(USAGE); return 0; }
  if (cmd === "--version") { stdout.write(`${VERSION}\n`); return 0; }
  assertMacOS();
  const rt = createRuntime();

  if (cmd === "login") {
    const method = arg(argv, "--pkce") === "plain" ? "plain" : "S256";
    const { url } = await startLogin(rt, { method });
    stdout.write(`\n1. Open this link in your browser and sign in to Skylight:\n\n   ${url}\n\n2. After sign-in you land on https://ourskylight.com/welcome?code=...\n   Copy that full address from the address bar.\n\n`);
    let callback = arg(argv, "--callback");
    if (!callback) {
      const rl = createInterface({ input: stdin, output: stdout });
      callback = (await rl.question("3. Paste it here: ")).trim();
      rl.close();
    }
    const { expiresAt } = await completeLogin(rt, callback);
    stdout.write(`\nLogged in. Access token valid until ${new Date(expiresAt).toLocaleString()}.\nRun \`skylight-mcp doctor\` to finish setup.\n`);
    return 0;
  }
  if (cmd === "logout") {
    const removed = await logout(rt);
    stdout.write(removed ? "Logged out. Credential removed.\n" : "Nothing to remove.\n");
    return 0;
  }
  if (cmd === "status") {
    const s = await status(rt);
    stdout.write(`${JSON.stringify(s, null, 2)}\n`);
    return 0;
  }
  if (cmd === "doctor") {
    stdout.write(await doctor(rt));
    return 0;
  }
  stderr.write(`Unknown command: ${cmd}\n${USAGE}`);
  return 2;
}

main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
  stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
