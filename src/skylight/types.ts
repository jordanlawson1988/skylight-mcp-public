import { ID_PATTERN, parseChoreId, type ChoreRef } from "./ids.js";
import { hourFromRrule } from "./rrule.js";
import { kindFromLinked, slotFromHour, slotFromStartTime, type ProfileKind, type RoutineSlot } from "./vocab.js";

export interface Profile { id: string; name: string; color: string | null; kind: ProfileKind | null; onChoreChart: boolean | null }
export interface Chore {
  id: string; summary: string; start: string | null; startTime: string | null; status: string | null;
  routine: boolean; recurring: boolean; recurrenceRule: string | null; rewardPoints: number | null; emoji: string | null; profileIds: string[];
  /** Numeric series id (attributes.series, else the numeric prefix of a composite id). Use it in request paths. */
  seriesId: string;
  /** Occurrence date of a recurring chore: the date in a composite id, else attributes.start. Null for one-time chores. */
  instanceDate: string | null;
  /** "HH:mm" of a routine-step occurrence: the time in a time-suffixed id, else attributes.start_time for routine steps. Null otherwise. */
  instanceTime: string | null;
  /** Which routine a routine step belongs to (from its time or the rule's BYHOUR). Null for ordinary chores. */
  timeOfDay: RoutineSlot | null;
  /** True for chores anyone can claim; they have no assigned profile (profileIds is empty) and may have no start date. */
  upForGrabs: boolean;
  /** Profile that completed the chore (relationships.completed_category); set on claimed/finished up-for-grabs chores. */
  completedByProfileId: string | null;
  description: string | null;
  timerSeconds: number | null;
  position: number | null;
  completedAt: string | null;
}
export interface RewardPoints { profileId: string; points: number; lifetimePoints: number | null }
export interface Reward {
  id: string; title: string; cost: number | null; emoji: string | null; description: string | null;
  respawnOnRedemption: boolean | null; redeemedAt: string | null; profileIds: string[];
}

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : {});
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+$/.test(v) ? Number(v) : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const idOf = (v: unknown): string | null => {
  const s = typeof v === "number" ? String(v) : typeof v === "string" ? v : null;
  return s !== null && ID_PATTERN.test(s) ? s : null;
};
const dataArray = (json: unknown): Rec[] => {
  const d = rec(json).data;
  return Array.isArray(d) ? d.map(rec) : [];
};

function relationshipIds(resource: Rec): string[] {
  const rels = rec(resource.relationships);
  const out: string[] = [];
  for (const key of ["category", "categories"]) {
    const data = rec(rels[key]).data;
    const items = Array.isArray(data) ? data : data ? [data] : [];
    for (const item of items) { const id = idOf(rec(item).id); if (id) out.push(id); }
  }
  const attrIds = rec(resource.attributes).category_ids;
  if (Array.isArray(attrIds)) for (const v of attrIds) { const id = idOf(v); if (id && !out.includes(id)) out.push(id); }
  return out;
}

export function mapProfile(resource: unknown): Profile | null {
  const r = rec(resource);
  const id = idOf(r.id);
  const a = rec(r.attributes);
  const name = str(a.label) ?? str(a.name);
  if (!id || !name) return null;
  return { id, name, color: str(a.color), kind: kindFromLinked(bool(a.linked_to_profile)), onChoreChart: bool(a.selected_for_chore_chart) };
}

export function mapProfiles(json: unknown): Profile[] {
  return dataArray(json).map(mapProfile).filter((p): p is Profile => p !== null);
}

export function mapChore(resource: unknown): Chore | null {
  const r = rec(resource);
  const id = idOf(r.id);
  const a = rec(r.attributes);
  const summary = str(a.summary);
  if (!id || summary === null) return null;
  const rs = a.recurrence_set;
  const rule = Array.isArray(rs) ? str(rs[0]) : str(rs);
  const recurring = bool(a.recurring) ?? rule !== null;
  let ref: ChoreRef;
  try { ref = parseChoreId(id, "id"); } catch { ref = { seriesId: id, instanceDate: null, instanceTime: null }; }
  const routine = bool(a.routine) ?? false;
  const instanceTime = ref.instanceTime ?? (routine ? str(a.start_time) : null);
  return {
    id, summary,
    start: str(a.start), startTime: str(a.start_time), status: str(a.status),
    routine,
    recurring,
    recurrenceRule: rule,
    rewardPoints: num(a.reward_points), emoji: str(a.emoji_icon),
    profileIds: relationshipIds(r),
    seriesId: idOf(a.series) ?? ref.seriesId,
    instanceDate: ref.instanceDate ?? (recurring ? str(a.start) : null),
    instanceTime,
    upForGrabs: bool(a.up_for_grabs) ?? false,
    completedByProfileId: idOf(rec(rec(rec(r.relationships).completed_category).data).id),
    description: str(a.description), timerSeconds: num(a.timer_seconds), position: num(a.position), completedAt: str(a.completed_at),
    timeOfDay: routine ? slotFromStartTime(instanceTime) ?? slotFromHour(hourFromRrule(rule)) : null,
  };
}

export function mapChores(json: unknown): Chore[] {
  return dataArray(json).map(mapChore).filter((c): c is Chore => c !== null);
}

/** GET /reward_points returns a plain array (one row per category, labels included); a `{ data: [...] }` wrapper is tolerated. */
export function mapRewardPoints(json: unknown): RewardPoints[] {
  const top = rec(json);
  const rows = Array.isArray(json) ? json : Array.isArray(top.data) ? top.data : [];
  const out: RewardPoints[] = [];
  for (const row of rows) {
    const r = rec(row);
    const profileId = idOf(r.category_id);
    const points = num(r.current_point_balance);
    if (profileId && points !== null) out.push({ profileId, points, lifetimePoints: num(r.lifetime_points_earned) });
  }
  return out;
}

export function mapRewards(json: unknown): Reward[] {
  const out: Reward[] = [];
  for (const r of dataArray(json)) {
    const id = idOf(r.id);
    const a = rec(r.attributes);
    const title = str(a.name);
    if (!id || !title) continue;
    out.push({
      id, title, cost: num(a.point_value), emoji: str(a.emoji_icon), description: str(a.description),
      respawnOnRedemption: bool(a.respawn_on_redemption), redeemedAt: str(a.redeemed_at), profileIds: relationshipIds(r),
    });
  }
  return out;
}
