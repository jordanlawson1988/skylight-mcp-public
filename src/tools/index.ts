import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOLSETS, type Toolset } from "../skylight/vocab.js";
import { registerAuthTools } from "./auth.js";
import { registerCalendarTools } from "./calendar.js";
import type { ToolContext } from "./context.js";
import { registerChoreTools } from "./chores.js";
import { registerListTools } from "./lists.js";
import { registerProfileTools } from "./profiles.js";
import { registerRewardTools } from "./rewards.js";

type Registrar = (server: McpServer, ctx: ToolContext) => void;

const none: Registrar = () => {};

/** One registrar per toolset (SKYLIGHT_TOOLSETS picks which run). */
const REGISTRARS: Record<Toolset, Registrar> = {
  profiles: registerProfileTools,
  chores: registerChoreTools,
  rewards: registerRewardTools,
  lists: registerListTools,
  calendar: registerCalendarTools,
  meals: none,
  photos: none,
  devices: none,
  frame: none,
  account: none,
};

/** skylight_auth_status is always registered; every other group only when its toolset is enabled. */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerAuthTools(server, ctx);
  for (const toolset of TOOLSETS) {
    if (ctx.config.toolsets.has(toolset)) REGISTRARS[toolset](server, ctx);
  }
}
