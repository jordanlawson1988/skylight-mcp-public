import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ValidationError } from "../skylight/errors.js";
import { assertId, assertPoints } from "../skylight/ids.js";
import { mapRewardPoints, mapRewards, type Profile } from "../skylight/types.js";
import type { ProfileKind } from "../skylight/vocab.js";
import type { ToolContext } from "./context.js";
import { listProfiles } from "./profiles.js";
import { ANNOTATIONS, run } from "./result.js";

interface Balance { profileId: string; name: string | null; kind: ProfileKind | null; points: number; lifetimePoints: number | null }

async function readBalances(ctx: ToolContext, frameId: string): Promise<Balance[]> {
  const balances = mapRewardPoints(await ctx.client.request({ method: "GET", path: `/api/frames/${frameId}/reward_points` }));
  let profiles = new Map<string, Profile>();
  try {
    profiles = new Map((await listProfiles(ctx)).map((p) => [p.id, p]));
  } catch {
    // Names are a convenience; fall back to null rather than failing the read.
  }
  return balances.map((b) => {
    const p = profiles.get(b.profileId);
    return { profileId: b.profileId, name: p?.name ?? null, kind: p?.kind ?? null, points: b.points, lifetimePoints: b.lifetimePoints };
  });
}

export function registerRewardTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "skylight_get_reward_points",
    { title: "Get reward point balances", description: "Current reward point balance per profile, as { profileId, name, kind, points, lifetimePoints }. Labels such as Birthdays are included with kind: \"label\" (they never earn points). Profile ids and names come from skylight_list_profiles.", inputSchema: {}, annotations: ANNOTATIONS.read },
    () => run(async () => {
      const frameId = await ctx.frames.resolve();
      return readBalances(ctx, frameId);
    })
  );

  server.registerTool(
    "skylight_add_reward_points",
    {
      title: "Add or subtract reward points",
      description: "Adjust reward points for one or more profiles. Negative points subtract. Not idempotent: repeating the call adds the points again. Confirm the amount with the user before subtracting. Returns { added: { profileIds, points }, balances } where balances are re-read after the change as [{ profileId, name, kind, points, lifetimePoints }]. If the re-read fails, balances is null and a warning says the points were still added: do not retry the add, call skylight_get_reward_points instead. Profile ids come from skylight_list_profiles.",
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
      const added = { profileIds: ids, points };
      try {
        return { added, balances: await readBalances(ctx, frameId) };
      } catch {
        return { added, balances: null, warning: "Points were added, but balances could not be re-read. Call skylight_get_reward_points to confirm. Do not retry the add." };
      }
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
