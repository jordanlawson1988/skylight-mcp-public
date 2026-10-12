import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAuthTools } from "./auth.js";
import type { ToolContext } from "./context.js";
import { registerProfileTools } from "./profiles.js";

export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerAuthTools(server, ctx);
  registerProfileTools(server, ctx);
}
