import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { status } from "../cli/commands.js";
import type { ToolContext } from "./context.js";
import { ANNOTATIONS, run } from "./result.js";

export function registerAuthTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "skylight_auth_status",
    {
      title: "Skylight login status",
      description: "Report whether this machine is logged in to Skylight, which API host and frame are in use, and when the token expires (tokenExpiresWhen and tokenExpiresAtLocal are in the configured time zone, tokenExpiresAt is UTC). Never returns secrets. If needsLogin is true (not logged in, a credentialError, or a frameError saying the session expired), tell the user to run `skylight-mcp login` in a terminal. credentialError explains an unreadable stored credential; frameError explains why the frame could not be resolved (for example several frames and no SKYLIGHT_FRAME_ID).",
      inputSchema: {},
      annotations: ANNOTATIONS.read,
    },
    () => run(() => status(ctx))
  );
}
