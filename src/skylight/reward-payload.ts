import { ValidationError } from "./errors.js";
import { assertProfileIds, MAX_DESCRIPTION_LENGTH } from "./chore-payload.js";
import { assertEmoji, assertId, cleanText } from "./ids.js";

export const MAX_REWARD_TITLE_LENGTH = 100;
export const MAX_REWARD_COST = 100_000;

export interface RewardInput {
  title: string;
  cost: number;
  profileIds: string[];
  emoji?: string | undefined;
  description?: string | undefined;
  respawnOnRedemption?: boolean | undefined;
}

export interface RewardCreateBody {
  name: string;
  point_value: number;
  emoji_icon: string | null;
  description: string | null;
  respawn_on_redemption: boolean;
  category_ids: string[];
}

export interface RewardUpdateBody {
  name?: string;
  point_value?: number;
  emoji_icon?: string;
  description?: string;
  respawn_on_redemption?: boolean;
  category_id?: string;
}

export function assertRewardCost(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_REWARD_COST) throw new ValidationError(field, `must be a whole number from 1 to ${MAX_REWARD_COST}`);
  return value;
}

/** Skylight rewards default to respawning after redemption (the web app default). */
export function buildRewardCreateBody(input: RewardInput): RewardCreateBody {
  return {
    name: cleanText(input.title, "title", MAX_REWARD_TITLE_LENGTH),
    point_value: assertRewardCost(input.cost, "cost"),
    emoji_icon: input.emoji === undefined ? null : assertEmoji(input.emoji, "emoji"),
    description: input.description === undefined ? null : cleanText(input.description, "description", MAX_DESCRIPTION_LENGTH),
    respawn_on_redemption: input.respawnOnRedemption ?? true,
    category_ids: assertProfileIds(input.profileIds),
  };
}

/** Only the provided fields; the profile is `category_id` (singular) on update. */
export function buildRewardUpdateBody(input: { title?: string | undefined; cost?: number | undefined; emoji?: string | undefined; description?: string | undefined; respawnOnRedemption?: boolean | undefined; profileId?: string | undefined }): RewardUpdateBody {
  const out: RewardUpdateBody = {};
  if (input.title !== undefined) out.name = cleanText(input.title, "title", MAX_REWARD_TITLE_LENGTH);
  if (input.cost !== undefined) out.point_value = assertRewardCost(input.cost, "cost");
  if (input.emoji !== undefined) out.emoji_icon = assertEmoji(input.emoji, "emoji");
  if (input.description !== undefined) out.description = cleanText(input.description, "description", MAX_DESCRIPTION_LENGTH);
  if (input.respawnOnRedemption !== undefined) out.respawn_on_redemption = input.respawnOnRedemption;
  if (input.profileId !== undefined) out.category_id = assertId(input.profileId, "profileId");
  if (Object.keys(out).length === 0) throw new ValidationError("update", "provide at least one field to change");
  return out;
}
