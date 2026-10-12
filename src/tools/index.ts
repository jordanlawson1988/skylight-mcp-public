import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAuthTools } from "./auth.js";
import { registerCalendarTools } from "./calendar.js";
import type { ToolContext } from "./context.js";
import { registerChoreTools } from "./chores.js";
import { registerListTools } from "./lists.js";
import { registerProfileTools } from "./profiles.js";
import { registerRewardTools } from "./rewards.js";

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerAuthTools(server, ctx);
  registerProfileTools(server, ctx);
  registerChoreTools(server, ctx);
  registerRewardTools(server, ctx);
  registerListTools(server, ctx);
  registerCalendarTools(server, ctx);
}
