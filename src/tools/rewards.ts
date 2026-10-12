import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ValidationError } from "../skylight/errors.js";
import { assertId, assertPoints } from "../skylight/ids.js";
import { mapRewardPoints, mapRewards } from "../skylight/types.js";
import type { ToolContext } from "./context.js";
import { listProfiles } from "./profiles.js";
import { ANNOTATIONS, run } from "./result.js";

async function readBalances(ctx: ToolContext, frameId: string): Promise<Array<{ profileId: string; name: string | null; points: number }>> {
  const balances = mapRewardPoints(await ctx.client.request({ method: "GET", path: `/api/frames/${frameId}/reward_points` }));
  const names = new Map((await listProfiles(ctx)).map((p) => [p.id, p.name]));
  return balances.map((b) => ({ profileId: b.profileId, name: names.get(b.profileId) ?? null, points: b.points }));
}

export function registerRewardTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "skylight_get_reward_points",
    { title: "Get reward point balances", description: "Current reward point balance per profile, as { profileId, name, points }. Profile ids and names come from skylight_list_profiles.", inputSchema: {}, annotations: ANNOTATIONS.read },
    () => run(async () => {
      const frameId = await ctx.frames.resolve();
      return readBalances(ctx, frameId);
    })
  );

  server.registerTool(
    "skylight_add_reward_points",
    {
      title: "Add or subtract reward points",
      description: "Adjust reward points for one or more profiles. Negative points subtract. Not idempotent: repeating the call adds the points again. Confirm the amount with the user before subtracting. Returns the balances re-read after the change as { profileId, name, points }. Profile ids come from skylight_list_profiles.",
      inputSchema: {
        profileIds: z.array(z.string()).min(1).max(20).describe("Profile ids from skylight_list_profiles."),
        points: z.number().int().describe("Points to add (negative subtracts). Range -10000 to 10000."),
      },
      annotations: ANNOTATIONS.mutate,
    },
    (args) => run(async () => {
      const ids = args.profileIds.map((p) => assertId(p, "profileIds"));
      if (new Set(ids).size !== ids.length) throw new ValidationError("profileIds", "must not repeat");
      const points = assertPoints(args.points, "points");
      const frameId = await ctx.frames.resolve();
      await ctx.client.request({ method: "POST", path: `/api/frames/${frameId}/reward_points`, body: { category_ids: ids, points } });
      return readBalances(ctx, frameId);
    })
  );

  server.registerTool(
    "skylight_list_rewards",
    { title: "List rewards", description: "List rewards the family has set up, with point cost and redemption state.", inputSchema: {}, annotations: ANNOTATIONS.read },
    () => run(async () => {
      const frameId = await ctx.frames.resolve();
      return mapRewards(await ctx.client.request({ method: "GET", path: `/api/frames/${frameId}/rewards` }));
    })
  );
}
