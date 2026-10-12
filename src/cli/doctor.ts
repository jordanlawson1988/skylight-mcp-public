import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Runtime } from "../runtime.js";
import { listProfiles } from "../tools/profiles.js";
import { status } from "./commands.js";

export async function doctor(rt: Runtime, opts: { serverPath?: string } = {}): Promise<string> {
  const serverPath = opts.serverPath ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "server.js");
  const lines: string[] = [`skylight-mcp doctor`, ``];
  const s = await status(rt);
  lines.push(`API host:   ${s.apiHost}`);
  if (!s.loggedIn) {
    if (s.credentialError) lines.push(`Login:      credential problem: ${s.credentialError}`);
    else lines.push(`Login:      not logged in. Run: skylight-mcp login`);
  } else {
    lines.push(`Login:      Logged in (token valid until ${s.tokenExpiresAt})`);
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
  const config = { mcpServers: { skylight: { command: "node", args: [serverPath], ...(Object.keys(env).length ? { env } : {}) } } };
  lines.push(``, `Claude Desktop config (~/Library/Application Support/Claude/claude_desktop_config.json):`, ``, JSON.stringify(config, null, 2), ``);
  return `${lines.join("\n")}\n`;
}
