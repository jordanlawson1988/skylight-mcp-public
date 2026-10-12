import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Runtime } from "../runtime.js";
import { listProfiles } from "../tools/profiles.js";
import { status } from "./commands.js";

export interface StableNodeOptions { execPath?: string; candidates?: string[]; realpath?: (p: string) => string }

/** Prefer a stable Homebrew symlink over the versioned Cellar path so the config survives `brew upgrade node`. */
export function stableNodePath(o: StableNodeOptions = {}): string {
  const execPath = o.execPath ?? process.execPath;
  const candidates = o.candidates ?? ["/opt/homebrew/bin/node", "/usr/local/bin/node"];
  const realpath = o.realpath ?? ((p: string) => realpathSync(p));
  let target: string;
  try { target = realpath(execPath); } catch { return execPath; }
  for (const c of candidates) {
    try { if (realpath(c) === target) return c; } catch { /* candidate missing: try the next */ }
  }
  return execPath;
}

export async function doctor(rt: Runtime, opts: { serverPath?: string } = {}): Promise<string> {
  const serverPath = opts.serverPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js");
  const lines: string[] = [`skylight-mcp doctor`, ``];
  const s = await status(rt);
  lines.push(`API host:   ${s.apiHost}`);
  if (!s.loggedIn) {
    if (s.credentialError) lines.push(`Login:      credential problem: ${s.credentialError}`);
    else lines.push(`Login:      not logged in. Run: skylight-mcp login`);
  } else if (s.needsLogin) {
    lines.push(`Login:      session expired or revoked. Run: skylight-mcp login`);
  } else {
    lines.push(`Login:      Logged in (token valid until ${s.tokenExpiresAt})`);
    try {
      const frames = await rt.frames.list();
      lines.push(`Frames:     ${frames.map((f) => `${f.id}${f.name ? ` (${f.name})` : ""}`).join(", ") || "none found"}`);
    } catch (e) {
      lines.push(`Frames:     could not load: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (s.frameId) lines.push(`Frame:      ${s.frameId}`);
    else lines.push(`Frame:      ${s.frameError ?? "unresolved"}`);
    if (s.frameId) {
      try {
        const profiles = await listProfiles(rt);
        lines.push(`Profiles:   ${profiles.map((p) => `${p.name} (${p.id})`).join(", ") || "none found"}`);
      } catch (e) {
        lines.push(`Profiles:   could not load: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  const env: Record<string, string> = {};
  if (rt.config.frameId) env.SKYLIGHT_FRAME_ID = rt.config.frameId;
  const config = { mcpServers: { skylight: { command: stableNodePath(), args: [serverPath], ...(Object.keys(env).length ? { env } : {}) } } };
  lines.push(``, `Claude Desktop config (~/Library/Application Support/Claude/claude_desktop_config.json):`, ``, JSON.stringify(config, null, 2), ``);
  return `${lines.join("\n")}\n`;
}
