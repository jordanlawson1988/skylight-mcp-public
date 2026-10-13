import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { excerpt } from "./skylight/redact.js";
import { auditEntry } from "./tools/audit.js";
import type { ToolContext } from "./tools/context.js";
import { logUnexpectedToStderr, UNEXPECTED_ERROR, type ToolResult } from "./tools/result.js";
import { registerAllTools } from "./tools/index.js";
import { VERSION } from "./version.js";

export const SERVER_INSTRUCTIONS = "Unofficial Skylight Calendar tools for chores, routines, rewards, lists, calendar events, profiles, the meal plan and recipes, photos and albums, devices, frame settings and sharing, and the account's plan. Destructive tools (delete chore, reward, list, list items, event, meal, recipe, photos, album and profile, block frame user, plus redeem reward) require confirm: true; always show the user what the preview says and get their agreement first. Deleting photos is permanent for everyone who shares the frame. Resetting or removing a device also needs confirmName, the device name exactly as the user types it; never fill that in yourself. Inviting someone to share the frame (skylight_invite_frame_user, confirm: true) and inviting people to an event (invitedEmails with confirmInvites: true) email real people outside the family, so confirm with the user first. All times you send and receive are in the configured time zone (default America/New_York, Eastern time) unless you add an explicit offset: pass local times like 2026-10-12T18:30 and the tools convert them, because Skylight itself reads bare times as UTC. Events synced from Google or another calendar cannot be changed here. Deleting a recurring event by its plain id removes the whole series. A repeating meal needs an explicit applyTo (one, future or all) to change or delete; applyTo one gives that date a new mealId. Meals and recipes take a meal slot by id or by name. Photo files and links, share links and personal account details are never returned, and who can see the family's photos is not available. To retire a person without losing their events, prefer skylight_update_profile with kind \"label\" over deleting the profile. The server may expose only some tool groups (SKYLIGHT_TOOLSETS); skylight_auth_status always works. On the shared family server (Claude or ChatGPT over the internet) every change is logged with the family member who made it, and skylight_recent_activity shows that log.";

type ToolHandler = (...args: unknown[]) => ToolResult | Promise<ToolResult>;

/**
 * Wraps every tool: an unexpected error (thrown, or carried by run()'s result) goes to ctx.logError, or to stderr on the
 * Mac; and after every call of a tool whose annotations lack readOnlyHint: true, ctx.audit gets the tool, its id
 * arguments and the outcome. Audit failures never change the tool's answer.
 */
function wrapTools(server: McpServer, ctx: ToolContext): void {
  const audit = ctx.audit;
  const logError = ctx.logError ?? logUnexpectedToStderr;
  const register = server.registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: ToolHandler) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, cb) => {
    const annotations = config.annotations as { readOnlyHint?: boolean } | undefined;
    const audited = audit !== undefined && annotations?.readOnlyHint !== true;
    const hasInput = config.inputSchema !== undefined;
    return register(name, config, async (...cbArgs: unknown[]) => {
      let result: ToolResult;
      try {
        result = await cb(...cbArgs);
      } catch (e) {
        logError(e);
        throw e;
      }
      if (UNEXPECTED_ERROR in result) {
        logError(result[UNEXPECTED_ERROR]);
        delete result[UNEXPECTED_ERROR];
      }
      if (audited) {
        try {
          await audit(auditEntry(name, hasInput ? cbArgs[0] : undefined, result));
        } catch (e) {
          console.error(`[skylight-mcp] audit log write failed for ${name}: ${excerpt(e instanceof Error ? e.message : String(e), [], 200)}`);
        }
      }
      return result;
    });
  };
}

/** The MCP server with every enabled tool. Shared by the Mac stdio entry (src/server.ts) and the Worker. */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "skylight-mcp", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  wrapTools(server, ctx);
  registerAllTools(server, ctx);
  return server;
}
