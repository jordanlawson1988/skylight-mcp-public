#!/usr/bin/env node
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { formatHuman } from "./skylight/time.js";
import { completeLogin, logout, startLogin, status } from "./cli/commands.js";
import { doctor } from "./cli/doctor.js";
import { runLoginPrompt, type LoginFlowIo } from "./cli/login-flow.js";
import { createWranglerRunner, REMOTE_USAGE, runRemote } from "./cli/remote.js";
import { appSupportDir } from "./node/config.js";
import { createKeychainRunner } from "./skylight/credentials.js";
import { assertMacOS, createRuntime } from "./runtime.js";
import { VERSION } from "./version.js";

const USAGE = `skylight-mcp ${VERSION}

Usage:
  skylight-mcp login [--pkce S256|plain]                   Sign in via Skylight's web page
  skylight-mcp login --complete <url>                        Finish a login started earlier (reuses its pending state)
  skylight-mcp logout                                        Remove the stored credential
  skylight-mcp status                                        Show login and frame status (no secrets)
  skylight-mcp doctor                                        Check setup and print Claude Desktop config

${REMOTE_USAGE}`;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function loggedInMessage(expiresAt: number, tz: string): string {
  return `\nLogged in. Access token valid until ${formatHuman(new Date(expiresAt).toISOString(), tz)}.\nRun \`skylight-mcp doctor\` to finish setup.\n`;
}

/** One readline interface for the whole login so piped input is not lost between prompts. */
function openPrompter(): { io: LoginFlowIo; close: () => void } {
  const rl = createInterface({ input: stdin, output: stdout });
  const lines = rl[Symbol.asyncIterator]();
  const io: LoginFlowIo = {
    async ask(prompt) {
      stdout.write(prompt);
      const next = await lines.next();
      return next.done ? null : next.value.trim();
    },
    write: (text) => { stdout.write(text); },
  };
  return { io, close: () => rl.close() };
}

async function main(argv: string[]): Promise<number> {
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h") { stdout.write(USAGE); return 0; }
  if (cmd === "--version") { stdout.write(`${VERSION}\n`); return 0; }
  assertMacOS();
  const rt = createRuntime();

  if (cmd === "login") {
    const completeUrl = arg(argv, "--complete");
    if (argv.includes("--complete")) {
      if (!completeUrl) throw new Error("--complete needs the full callback URL.");
      const { expiresAt } = await completeLogin(rt, completeUrl);
      stdout.write(loggedInMessage(expiresAt, rt.config.timezone));
      return 0;
    }
    const method = arg(argv, "--pkce") === "plain" ? "plain" : "S256";
    const { url } = await startLogin(rt, { method });
    stdout.write(`\n1. Open this link in your browser and sign in to Skylight:\n\n   ${url}\n\n2. After sign-in, Skylight bounces you straight to its home page, so you\n   usually can't copy the callback address. That's fine: just come back here.\n\n3. Press Enter to finish (reads the sign-in result from Chrome's history),\n   or paste the https://ourskylight.com/welcome?code=... address if you have it:\n\n`);
    const prompter = openPrompter();
    try {
      const result = await runLoginPrompt(rt, prompter.io);
      if (result.status === "quit") {
        stdout.write("Login not finished. The pending login stays valid for 10 minutes; run `skylight-mcp login --complete <url>` to finish it.\n");
        return 1;
      }
      stdout.write(loggedInMessage(result.expiresAt, rt.config.timezone));
      return 0;
    } finally {
      prompter.close();
    }
  }
  if (cmd === "remote") {
    const prompter = openPrompter();
    try {
      return await runRemote(argv.slice(1), {
        rt, runner: createKeychainRunner(), wrangler: createWranglerRunner(), configPath: path.join(appSupportDir(), "remote.json"), io: prompter.io,
      });
    } finally {
      prompter.close();
    }
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
