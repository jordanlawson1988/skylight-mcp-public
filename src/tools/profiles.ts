import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mapProfiles } from "../skylight/types.js";
import type { ToolContext } from "./context.js";
import { ANNOTATIONS, run } from "./result.js";

export async function listProfiles(ctx: ToolContext) {
  const frameId = await ctx.frames.resolve();
  return mapProfiles(await ctx.client.request({ method: "GET", path: `/api/frames/${frameId}/categories` }));
}

export function registerProfileTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "skylight_list_profiles",
    {
      title: "List family profiles",
      description: "List the family member profiles on the Skylight frame with their ids. Chores and reward points are assigned by profile id, so call this first when the user names a person.",
      inputSchema: {},
      annotations: ANNOTATIONS.read,
    },
    () => run(() => listProfiles(ctx))
  );
}
