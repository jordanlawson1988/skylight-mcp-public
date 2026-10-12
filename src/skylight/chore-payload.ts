import { ValidationError } from "./errors.js";
import { assertDate, assertEmoji, assertId, assertPoints, assertTime, cleanText } from "./ids.js";
import { buildRrule, type Recurrence } from "./rrule.js";
import { ROUTINE_SLOTS, type RoutineSlot } from "./vocab.js";

export interface ChoreInput {
  summary: string;
  /** Required unless upForGrabs is true. */
  start?: string;
  /** Required unless upForGrabs is true. */
  profileIds?: string[];
  startTime?: string;
  recurrence?: Recurrence;
  routine?: boolean;
  /** Routine steps only: which routine (morning, afternoon, evening). Becomes BYHOUR in the recurrence rule. */
  timeOfDay?: RoutineSlot;
  upForGrabs?: boolean;
  rewardPoints?: number;
  emoji?: string;
  description?: string;
  timerSeconds?: number;
}

/** Fields an update may clear (null) as well as change. */
export type ChoreUpdateInput = Omit<Partial<ChoreInput>, "startTime" | "emoji" | "rewardPoints" | "description" | "timerSeconds" | "recurrence"> & {
  startTime?: string | null;
  emoji?: string | null;
  rewardPoints?: number | null;
  description?: string | null;
  timerSeconds?: number | null;
  recurrence?: Recurrence | null;
};

export interface ChoreCreateBody {
  summary: string;
  start: string | null;
  start_time: string | null;
  routine: boolean;
  up_for_grabs: boolean;
  recurrence_set: string[] | null;
  recurring_until: string | null;
  category_ids: string[];
  reward_points: number | null;
  emoji_icon: string | null;
  description: string | null;
  timer_seconds: number | null;
}

export const MAX_PROFILES_PER_CHORE = 20;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_TIMER_SECONDS = 86_400;

export function assertTimerSeconds(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0 || value > MAX_TIMER_SECONDS) throw new ValidationError(field, `must be an integer from 0 to ${MAX_TIMER_SECONDS}`);
  return value;
}

/** 1..20 distinct valid ids. Shared by the reward and event payload builders. */
export function assertProfileIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.length === 0) throw new ValidationError("profileIds", "must list at least one profile id");
  if (ids.length > MAX_PROFILES_PER_CHORE) throw new ValidationError("profileIds", `must list at most ${MAX_PROFILES_PER_CHORE} profiles`);
  const out = ids.map((id) => assertId(id, "profileIds"));
  if (new Set(out).size !== out.length) throw new ValidationError("profileIds", "must not repeat");
  return out;
}

function slotHour(slot: RoutineSlot | undefined): (typeof ROUTINE_SLOTS)[RoutineSlot] {
  const hour = slot === undefined ? undefined : ROUTINE_SLOTS[slot];
  if (hour === undefined) throw new ValidationError("timeOfDay", "must be morning, afternoon or evening");
  return hour;
}

/** Server rules (verified live): routines have a blank start_time and exactly one BYHOUR in their rule; other chores must not have BYHOUR. */
function routineRecurrence(input: Pick<ChoreUpdateInput, "timeOfDay" | "startTime" | "recurrence">): Recurrence {
  if (input.timeOfDay === undefined) throw new ValidationError("routine", "routine steps need timeOfDay: morning, afternoon or evening");
  if (input.startTime !== undefined && input.startTime !== null) throw new ValidationError("startTime", "routines use timeOfDay, not startTime");
  if (input.recurrence === null) throw new ValidationError("recurrence", "routine steps need a recurrence; omit it for daily");
  return { ...(input.recurrence ?? { frequency: "daily" }), hour: slotHour(input.timeOfDay) };
}

function plainRecurrence(recurrence: Recurrence): Recurrence {
  if (recurrence.hour !== undefined) throw new ValidationError("recurrence.hour", "is only for routine steps");
  return recurrence;
}

export function buildChoreCreateBody(input: ChoreInput): ChoreCreateBody {
  let recurrenceInput: Recurrence | undefined = input.recurrence;
  if (input.routine === true) recurrenceInput = routineRecurrence(input);
  else if (input.timeOfDay !== undefined) throw new ValidationError("routine", "timeOfDay is only for routine steps");
  else if (recurrenceInput !== undefined) recurrenceInput = plainRecurrence(recurrenceInput);
  const recurrence = recurrenceInput === undefined ? null : buildRrule(recurrenceInput);
  const grabs = input.upForGrabs === true;
  if (!grabs && input.start === undefined) throw new ValidationError("start", "is required unless upForGrabs is true");
  if (!grabs && input.profileIds === undefined) throw new ValidationError("profileIds", "is required unless upForGrabs is true");
  // Verified live: an up-for-grabs chore accepts category_ids: [] and start: null.
  const categoryIds = input.profileIds === undefined || (grabs && input.profileIds.length === 0) ? [] : assertProfileIds(input.profileIds);
  return {
    summary: cleanText(input.summary, "summary", 500),
    start: input.start === undefined ? null : assertDate(input.start, "start"),
    start_time: input.startTime === undefined ? null : assertTime(input.startTime, "startTime"),
    routine: input.routine ?? false,
    up_for_grabs: input.upForGrabs ?? false,
    recurrence_set: recurrence === null ? null : [recurrence],
    recurring_until: recurrenceInput?.until ?? null,
    category_ids: categoryIds,
    reward_points: input.rewardPoints === undefined ? null : assertPoints(input.rewardPoints, "rewardPoints"),
    emoji_icon: input.emoji === undefined ? null : assertEmoji(input.emoji, "emoji"),
    description: input.description === undefined ? null : cleanText(input.description, "description", MAX_DESCRIPTION_LENGTH),
    timer_seconds: input.timerSeconds === undefined ? null : assertTimerSeconds(input.timerSeconds, "timerSeconds"),
  };
}

export function buildChoreUpdateBody(input: ChoreUpdateInput): Partial<ChoreCreateBody> {
  const out: Partial<ChoreCreateBody> = {};
  if (input.summary !== undefined) out.summary = cleanText(input.summary, "summary", 500);
  if (input.start !== undefined) out.start = assertDate(input.start, "start");
  // An update cannot see the stored routine flag, so only what is passed is validated.
  let recurrence: Recurrence | null | undefined = input.recurrence;
  if (input.routine === true) recurrence = routineRecurrence(input);
  else if (input.timeOfDay !== undefined) {
    if (input.routine === false) throw new ValidationError("routine", "timeOfDay is only for routine steps");
    if (input.startTime !== undefined && input.startTime !== null) throw new ValidationError("startTime", "routines use timeOfDay, not startTime");
    if (recurrence === undefined || recurrence === null) throw new ValidationError("recurrence", "is required with timeOfDay on update, because the hour is part of the schedule; pass the full recurrence");
    recurrence = { ...recurrence, hour: slotHour(input.timeOfDay) };
  } else if (recurrence) recurrence = plainRecurrence(recurrence);
  if (input.startTime !== undefined) out.start_time = input.startTime === null ? null : assertTime(input.startTime, "startTime");
  if (input.routine !== undefined) out.routine = input.routine;
  if (input.upForGrabs !== undefined) out.up_for_grabs = input.upForGrabs;
  if (recurrence !== undefined) {
    out.recurrence_set = recurrence === null ? null : [buildRrule(recurrence)];
    out.recurring_until = recurrence?.until ?? null;
  }
  if (input.profileIds !== undefined) out.category_ids = assertProfileIds(input.profileIds);
  if (input.rewardPoints !== undefined) out.reward_points = input.rewardPoints === null ? null : assertPoints(input.rewardPoints, "rewardPoints");
  if (input.emoji !== undefined) out.emoji_icon = input.emoji === null ? null : assertEmoji(input.emoji, "emoji");
  if (input.description !== undefined) out.description = input.description === null ? null : cleanText(input.description, "description", MAX_DESCRIPTION_LENGTH);
  if (input.timerSeconds !== undefined) out.timer_seconds = input.timerSeconds === null ? null : assertTimerSeconds(input.timerSeconds, "timerSeconds");
  if (Object.keys(out).length === 0) throw new ValidationError("update", "provide at least one field to change");
  return out;
}
