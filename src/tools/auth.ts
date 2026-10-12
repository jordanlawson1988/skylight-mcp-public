import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { status } from "../cli/commands.js";
import type { ToolContext } from "./context.js";
import { ANNOTATIONS, run } from "./result.js";

export function registerAuthTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "skylight_auth_status",
    {
      title: "Skylight login status",
      description: "Report whether this machine is logged in to Skylight, which API host and frame are in use, and when the token expires. Never returns secrets. If loggedIn is false, tell the user to run `skylight-mcp login` in a terminal.",
      inputSchema: {},
      annotations: ANNOTATIONS.read,
    },
    () => run(() => status(ctx))
  );
}
