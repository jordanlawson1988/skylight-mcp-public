import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SkylightApiError, ValidationError } from "../skylight/errors.js";
import { assertId, assertPoints } from "../skylight/ids.js";
import { formatOffsetDateTime } from "../skylight/time.js";
import { buildRewardCreateBody, buildRewardUpdateBody, MAX_REWARD_COST, MAX_REWARD_TITLE_LENGTH } from "../skylight/reward-payload.js";
import { mapRewardPoints, mapRewardResponse, mapRewards, type Profile, type Reward } from "../skylight/types.js";
import type { ProfileKind } from "../skylight/vocab.js";
import type { ToolContext } from "./context.js";
import { assertPersonProfiles, listProfiles } from "./profiles.js";
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

/** A reward for display: redeemedAt in the configured zone. */
export const presentReward = <T extends { redeemedAt: string | null }>(r: T, tz: string): T => (r.redeemedAt === null ? r : { ...r, redeemedAt: formatOffsetDateTime(r.redeemedAt, tz) });

const rewardsPath = (frameId: string) => `/api/frames/${frameId}/rewards`;
/** Lower bound for the redeemed-rewards query: every redemption since the epoch. */
const REDEEMED_FROM = "1970-01-01T00:00:00Z";

async function getReward(ctx: ToolContext, frameId: string, id: string): Promise<Reward> {
  const reward = mapRewardResponse(await ctx.client.request({ method: "GET", path: `${rewardsPath(frameId)}/${id}` }))[0];
  if (!reward) throw new ValidationError("rewardId", "Skylight returned no reward with that id");
  return reward;
}

/** The reward plus its profile's name and current points; the balance lookup is a convenience and never blocks. */
async function redeemContext(ctx: ToolContext, frameId: string, id: string): Promise<{ reward: Reward; profileName: string | null; points: number | null }> {
  const reward = await getReward(ctx, frameId, id);
  if (reward.redeemed) throw new ValidationError("rewardId", "this reward is already redeemed; pick the active copy from skylight_list_rewards, or undo it with skylight_unredeem_reward");
  try {
    const mine = (await readBalances(ctx, frameId)).find((b) => b.profileId === reward.profileId);
    return { reward, profileName: mine?.name ?? null, points: mine?.points ?? null };
  } catch (e) {
    if (e instanceof SkylightApiError) return { reward, profileName: null, points: null };
    throw e;
  }
}

export function registerRewardTools(server: McpServer, ctx: ToolContext): void {
  const tz = ctx.config.timezone;
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
      description: "Adjust reward points for one or more profiles. Negative points subtract. Not idempotent: repeating the call adds the points again. Confirm the amount with the user before subtracting. Returns { added: { profileIds, points }, balances } where balances are re-read after the change as [{ profileId, name, kind, points, lifetimePoints }]. If the re-read fails, balances is null and a warning says the points were still added: do not retry the add, call skylight_get_reward_points instead. Profile ids come from skylight_list_profiles; labels such as Birthdays are rejected.",
      inputSchema: {
        profileIds: z.array(z.string()).min(1).max(20).describe("Profile ids from skylight_list_profiles."),
        points: z.number().int().min(-10000).max(10000).describe("Points to add (negative subtracts). Range -10000 to 10000."),
      },
      annotations: ANNOTATIONS.mutate,
    },
    (args) => run(async () => {
      const ids = args.profileIds.map((p) => assertId(p, "profileIds"));
      if (new Set(ids).size !== ids.length) throw new ValidationError("profileIds", "must not repeat");
      const points = assertPoints(args.points, "points");
      const frameId = await ctx.frames.resolve();
      await assertPersonProfiles(ctx, frameId, ids, "profileIds");
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
    {
      title: "List rewards",
      description: "List rewards the family has set up as { id, title, cost, emoji, description, respawnOnRedemption, redeemedAt, redeemed, profileId }. By default only unredeemed rewards are listed (a reward that respawns reappears with a new id after it is redeemed). includeRedeemed: true also returns past redemptions, marked redeemed: true. Reward ids are needed for update, redeem, unredeem and delete.",
      inputSchema: { includeRedeemed: z.boolean().optional().describe("Also list already-redeemed rewards (a second request). Default false.") },
      annotations: ANNOTATIONS.read,
    },
    (args) => run(async () => {
      const frameId = await ctx.frames.resolve();
      const open = mapRewards(await ctx.client.request({ method: "GET", path: rewardsPath(frameId) }));
      if (args.includeRedeemed !== true) return open.map((r) => presentReward(r, tz));
      const redeemed = mapRewards(await ctx.client.request({ method: "GET", path: rewardsPath(frameId), query: { redeemed_at_min: REDEEMED_FROM } }));
      const seen = new Set(open.map((r) => r.id));
      return [...open, ...redeemed.filter((r) => !seen.has(r.id))].map((r) => presentReward(r, tz));
    })
  );

  server.registerTool(
    "skylight_create_reward",
    {
      title: "Create a reward",
      description: "Create a reward that a profile can redeem with points. Skylight makes one reward per profile id, so several profileIds create several rewards; the result lists them all. respawnOnRedemption (default true) puts a fresh copy back in the list after each redemption. Profile ids come from skylight_list_profiles (people only; labels such as Birthdays are rejected). Not idempotent: repeating the call creates duplicates.",
      inputSchema: {
        title: z.string().describe(`Reward name, up to ${MAX_REWARD_TITLE_LENGTH} characters, e.g. "Movie night".`),
        cost: z.number().int().min(1).max(MAX_REWARD_COST).describe(`Points needed to redeem (1-${MAX_REWARD_COST}).`),
        profileIds: z.array(z.string()).min(1).max(20).describe("Profile ids from skylight_list_profiles; each gets its own copy of the reward."),
        emoji: z.string().optional().describe("Single emoji icon."),
        description: z.string().optional().describe("Longer details, up to 500 characters."),
        respawnOnRedemption: z.boolean().optional().describe("true (default) re-adds the reward after it is redeemed; false makes it one-time."),
      },
      annotations: ANNOTATIONS.create,
    },
    (args) => run(async () => {
      const body = buildRewardCreateBody(args);
      const frameId = await ctx.frames.resolve();
      await assertPersonProfiles(ctx, frameId, body.category_ids, "profileIds");
      const rewards = mapRewardResponse(await ctx.client.request<unknown>({ method: "POST", path: rewardsPath(frameId), body }));
      return { created: rewards.length, rewards: rewards.map((r) => presentReward(r, tz)), ...(rewards.length === 0 ? { warning: "Skylight returned no rewards; call skylight_list_rewards to confirm before retrying." } : {}) };
    })
  );

  server.registerTool(
    "skylight_update_reward",
    {
      title: "Update a reward",
      description: "Change a reward's title, cost, emoji, description, respawnOnRedemption or owning profile. Only the provided fields change. Reward ids come from skylight_list_rewards. profileId must be a person from skylight_list_profiles (labels are rejected).",
      inputSchema: {
        rewardId: z.string().describe("Reward id from skylight_list_rewards."),
        title: z.string().optional().describe(`New name, up to ${MAX_REWARD_TITLE_LENGTH} characters.`),
        cost: z.number().int().min(1).max(MAX_REWARD_COST).optional().describe(`New point cost (1-${MAX_REWARD_COST}).`),
        emoji: z.string().optional().describe("Single emoji icon."),
        description: z.string().optional().describe("Longer details, up to 500 characters."),
        respawnOnRedemption: z.boolean().optional().describe("Whether the reward comes back after redemption."),
        profileId: z.string().optional().describe("Move the reward to this profile."),
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const { rewardId, ...rest } = args;
      const id = assertId(rewardId, "rewardId");
      const body = buildRewardUpdateBody(rest);
      const frameId = await ctx.frames.resolve();
      if (body.category_id !== undefined) await assertPersonProfiles(ctx, frameId, [body.category_id], "profileId");
      const json = await ctx.client.request<unknown>({ method: "PATCH", path: `${rewardsPath(frameId)}/${id}`, body });
      const updated = mapRewardResponse(json)[0];
      return updated ? presentReward(updated, tz) : { id, updated: true };
    })
  );

  server.registerTool(
    "skylight_redeem_reward",
    {
      title: "Redeem a reward",
      description: "Spend a profile's points on a reward. Deducts the reward's cost from the profile's balance and marks the reward redeemed; if it respawns, a new unredeemed copy appears with a new id. Not idempotent: redeeming twice spends the points twice. Without confirm: true this makes NO change and returns the reward, its cost and the profile's current points. Show that to the user and only call again with confirm: true after they agree. Fails with a clear message when the balance is too low.",
      inputSchema: {
        rewardId: z.string().describe("Reward id from skylight_list_rewards."),
        confirm: z.boolean().optional().describe("Must be true to actually redeem. Ask the user first."),
      },
      annotations: ANNOTATIONS.mutate,
    },
    (args) => run(async () => {
      const id = assertId(args.rewardId, "rewardId");
      const frameId = await ctx.frames.resolve();
      const { reward, profileName, points } = await redeemContext(ctx, frameId, id);
      const cost = reward.cost;
      const short = points !== null && cost !== null && points < cost;
      if (args.confirm !== true) {
        const who = profileName ?? reward.profileId ?? "the profile";
        const spend = cost === null || points === null ? `Redeeming would spend ${cost ?? "?"} points from ${who}.`
          : short ? `Not enough points: ${points} available, ${cost} needed for ${who}.`
          : `Redeeming would spend ${cost} of ${who}'s ${points} points (${points - cost} left); the balance covers the cost.`;
        return {
          confirmed: false,
          wouldRedeem: { id: reward.id, title: reward.title, cost, profileId: reward.profileId, profileName, currentPoints: points },
          message: `Nothing was redeemed. ${spend}${reward.respawnOnRedemption === true ? " A new unredeemed copy will be added afterwards." : ""} Ask the user to confirm, then call again with confirm: true.`,
        };
      }
      if (short) throw new ValidationError("rewardId", `not enough points: ${points} available, ${cost} needed`);
      let json: unknown;
      try {
        json = await ctx.client.request<unknown>({ method: "POST", path: `${rewardsPath(frameId)}/${id}/redeem` });
      } catch (e) {
        if (e instanceof SkylightApiError && e.status === 400 && /not enough points/i.test(e.message)) {
          throw new ValidationError("rewardId", points !== null && cost !== null ? `not enough points: ${points} available, ${cost} needed` : `not enough points for a reward costing ${cost ?? "more than the balance"}`);
        }
        throw e;
      }
      const redeemed = presentReward(mapRewardResponse(json).find((r) => r.id === id) ?? reward, tz);
      try {
        const now = (await readBalances(ctx, frameId)).find((b) => b.profileId === reward.profileId) ?? null;
        return { redeemed: true, reward: redeemed, balance: now === null ? null : { profileId: now.profileId, name: now.name, points: now.points } };
      } catch {
        return { redeemed: true, reward: redeemed, balance: null, warning: "The reward was redeemed, but the balance could not be re-read. Call skylight_get_reward_points to confirm. Do not retry the redemption." };
      }
    })
  );

  server.registerTool(
    "skylight_unredeem_reward",
    {
      title: "Undo a redemption",
      description: "Undo a redemption: refunds the points to the profile and clears the reward's redeemed state. Use a redeemed reward id (skylight_list_rewards with includeRedeemed: true). If the reward respawned, the new unredeemed copy stays in the list.",
      inputSchema: { rewardId: z.string().describe("Id of a redeemed reward.") },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const id = assertId(args.rewardId, "rewardId");
      const frameId = await ctx.frames.resolve();
      const json = await ctx.client.request<unknown>({ method: "POST", path: `${rewardsPath(frameId)}/${id}/unredeem` });
      const reward = mapRewardResponse(json)[0];
      return reward ? presentReward(reward, tz) : { id, unredeemed: true };
    })
  );

  server.registerTool(
    "skylight_delete_reward",
    {
      title: "Delete a reward",
      description: "Delete a reward. Without confirm: true this makes NO change and returns what would be deleted. Show that to the user and only call again with confirm: true after they agree.",
      inputSchema: {
        rewardId: z.string().describe("Reward id from skylight_list_rewards."),
        confirm: z.boolean().optional().describe("Must be true to actually delete. Ask the user first."),
      },
      annotations: ANNOTATIONS.destroy,
    },
    (args) => run(async () => {
      const id = assertId(args.rewardId, "rewardId");
      const frameId = await ctx.frames.resolve();
      if (args.confirm !== true) {
        const reward = await getReward(ctx, frameId, id);
        return {
          confirmed: false,
          wouldDelete: { id: reward.id, title: reward.title, cost: reward.cost, profileId: reward.profileId, redeemed: reward.redeemed },
          message: "Nothing was deleted. This would delete the reward. Ask the user to confirm, then call again with confirm: true.",
        };
      }
      await ctx.client.request({ method: "DELETE", path: `${rewardsPath(frameId)}/${id}` });
      return { deleted: true, id };
    })
  );
}
