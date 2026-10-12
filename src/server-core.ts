import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { excerpt } from "./skylight/redact.js";
import type { AuditEntry, ToolContext } from "./tools/context.js";
import { registerAllTools } from "./tools/index.js";
import { VERSION } from "./version.js";

export const SERVER_INSTRUCTIONS = "Unofficial Skylight Calendar tools for chores, routines, rewards, lists, calendar events, profiles, the meal plan and recipes, photos and albums, devices, frame settings and sharing, and the account's plan. Destructive tools (delete chore, reward, list, list items, event, meal, recipe, photos, album and profile, block frame user, plus redeem reward) require confirm: true; always show the user what the preview says and get their agreement first. Deleting photos is permanent for everyone who shares the frame. Resetting or removing a device also needs confirmName, the device name exactly as the user types it; never fill that in yourself. Inviting someone to share the frame (skylight_invite_frame_user, confirm: true) and inviting people to an event (invitedEmails with confirmInvites: true) email real people outside the family, so confirm with the user first. All times you send and receive are in the configured time zone (default America/New_York, Eastern time) unless you add an explicit offset: pass local times like 2026-10-12T18:30 and the tools convert them, because Skylight itself reads bare times as UTC. Events synced from Google or another calendar cannot be changed here. Deleting a recurring event by its plain id removes the whole series. A repeating meal needs an explicit applyTo (one, future or all) to change or delete; applyTo one gives that date a new mealId. Meals and recipes take a meal slot by id or by name. Photo files and links, share links and personal account details are never returned, and who can see the family's photos is not available. To retire a person without losing their events, prefer skylight_update_profile with kind \"label\" over deleting the profile. The server may expose only some tool groups (SKYLIGHT_TOOLSETS); skylight_auth_status always works. On the shared family server (Claude or ChatGPT over the internet) every change is logged with the family member who made it, and skylight_recent_activity shows that log.";

const ID_ARGUMENT = /(?:Id|Ids)$/;
const ID_VALUE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_AUDIT_TARGETS = 20;

/** The id arguments of a call (keys ending in Id or Ids), id-shaped values only, at most MAX_AUDIT_TARGETS. */
export function auditTargets(args: unknown): string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (!ID_ARGUMENT.test(key)) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      const text = typeof v === "string" ? v : typeof v === "number" && Number.isSafeInteger(v) ? String(v) : null;
      if (text !== null && ID_VALUE.test(text)) out.push(text);
      if (out.length >= MAX_AUDIT_TARGETS) return out;
    }
  }
  return out;
}

function resultText(result: CallToolResult): string {
  const first = result.content?.find((c) => c.type === "text");
  return first && first.type === "text" ? first.text : "";
}

/** Turns a finished call into its audit entry: previews (confirmed: false, dryRun: true) are marked, errors shortened. */
export function auditEntry(tool: string, args: unknown, result: CallToolResult): AuditEntry {
  const entry: AuditEntry = { tool, targets: auditTargets(args), ok: result.isError !== true };
  if (result.isError === true) {
    entry.error = excerpt(resultText(result), [], 200);
    return entry;
  }
  try {
    const data = JSON.parse(resultText(result)) as Record<string, unknown> | null;
    if (data && typeof data === "object" && (data.confirmed === false || data.dryRun === true)) entry.preview = true;
  } catch { /* not JSON: nothing to mark */ }
  return entry;
}

type ToolHandler = (...args: unknown[]) => CallToolResult | Promise<CallToolResult>;

/**
 * After every call of a tool whose annotations lack readOnlyHint: true, hand ctx.audit the tool, its id arguments and
 * the outcome. Audit failures never change the tool's answer.
 */
function auditWrites(server: McpServer, ctx: ToolContext): void {
  const audit = ctx.audit;
  if (!audit) return;
  const register = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: ToolHandler) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, cb) => {
    const annotations = config.annotations as { readOnlyHint?: boolean } | undefined;
    if (annotations?.readOnlyHint === true) return register(name, config, cb);
    const hasInput = config.inputSchema !== undefined;
    return register(name, config, async (...cbArgs: unknown[]) => {
      const result = await cb(...cbArgs);
      try {
        await audit(auditEntry(name, hasInput ? cbArgs[0] : undefined, result));
      } catch (e) {
        console.error(`[skylight-mcp] audit log write failed for ${name}: ${excerpt(e instanceof Error ? e.message : String(e), [], 200)}`);
      }
      return result;
    });
  };
}

/** The MCP server with every enabled tool. Shared by the Mac stdio entry (src/server.ts) and the Worker. */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "skylight-mcp", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  auditWrites(server, ctx);
  registerAllTools(server, ctx);
  return server;
}
