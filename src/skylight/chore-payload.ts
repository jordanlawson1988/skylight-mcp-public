import { ValidationError } from "./errors.js";
import { assertDate, assertEmoji, assertId, assertPoints, assertTime, cleanText } from "./ids.js";
import { buildRrule, type Recurrence } from "./rrule.js";

export interface ChoreInput {
  summary: string;
  start: string;
  profileIds: string[];
  startTime?: string;
  recurrence?: Recurrence;
  routine?: boolean;
  upForGrabs?: boolean;
  rewardPoints?: number;
  emoji?: string;
}

export interface ChoreCreateBody {
  summary: string;
  start: string;
  start_time: string | null;
  routine: boolean;
  up_for_grabs: boolean;
  recurrence_set: string[] | null;
  recurring_until: string | null;
  category_ids: string[];
  reward_points: number | null;
  emoji_icon: string | null;
}

export const MAX_PROFILES_PER_CHORE = 20;

function profileIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.length === 0) throw new ValidationError("profileIds", "must list at least one profile id");
  if (ids.length > MAX_PROFILES_PER_CHORE) throw new ValidationError("profileIds", `must list at most ${MAX_PROFILES_PER_CHORE} profiles`);
  const out = ids.map((id) => assertId(id, "profileIds"));
  if (new Set(out).size !== out.length) throw new ValidationError("profileIds", "must not repeat");
  return out;
}

export function buildChoreCreateBody(input: ChoreInput): ChoreCreateBody {
  const recurrence = input.recurrence === undefined ? null : buildRrule(input.recurrence);
  return {
    summary: cleanText(input.summary, "summary", 500),
    start: assertDate(input.start, "start"),
    start_time: input.startTime === undefined ? null : assertTime(input.startTime, "startTime"),
    routine: input.routine ?? false,
    up_for_grabs: input.upForGrabs ?? false,
    recurrence_set: recurrence === null ? null : [recurrence],
    recurring_until: input.recurrence?.until ?? null,
    category_ids: profileIds(input.profileIds),
    reward_points: input.rewardPoints === undefined ? null : assertPoints(input.rewardPoints, "rewardPoints"),
    emoji_icon: input.emoji === undefined ? null : assertEmoji(input.emoji, "emoji"),
  };
}

export function buildChoreUpdateBody(input: Partial<ChoreInput>): Partial<ChoreCreateBody> {
  const out: Partial<ChoreCreateBody> = {};
  if (input.summary !== undefined) out.summary = cleanText(input.summary, "summary", 500);
  if (input.start !== undefined) out.start = assertDate(input.start, "start");
  if (input.startTime !== undefined) out.start_time = assertTime(input.startTime, "startTime");
  if (input.routine !== undefined) out.routine = input.routine;
  if (input.upForGrabs !== undefined) out.up_for_grabs = input.upForGrabs;
  if (input.recurrence !== undefined) {
    out.recurrence_set = [buildRrule(input.recurrence)];
    out.recurring_until = input.recurrence.until ?? null;
  }
  if (input.profileIds !== undefined) out.category_ids = profileIds(input.profileIds);
  if (input.rewardPoints !== undefined) out.reward_points = assertPoints(input.rewardPoints, "rewardPoints");
  if (input.emoji !== undefined) out.emoji_icon = assertEmoji(input.emoji, "emoji");
  if (Object.keys(out).length === 0) throw new ValidationError("update", "provide at least one field to change");
  return out;
}
