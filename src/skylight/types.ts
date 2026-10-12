import { ID_PATTERN, parseChoreId, parseEventId, type ChoreRef } from "./ids.js";
import { hourFromRrule } from "./rrule.js";
import { LIST_ITEM_STATUS, LIST_KINDS, kindFromLinked, slotFromHour, slotFromStartTime, type ListKind, type ProfileKind, type RoutineSlot } from "./vocab.js";

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
  respawnOnRedemption: boolean | null; redeemedAt: string | null;
  /** The profile (category) the reward belongs to; null if the response had none. */
  profileId: string | null;
  /** True when redeemedAt is set. */
  redeemed: boolean;
}
export interface SkylightList { id: string; title: string; kind: ListKind | null; color: string | null; hiddenOnDevice: boolean;
  /** Null when the response carried no list_items relationship (unknown, not zero). */
  itemCount: number | null }
export interface ListItem { id: string; title: string; done: boolean; section: string | null; position: number | null }
export interface CalendarEvent {
  /** As listed: a master/one-off id, or `<masterId>-<unixSeconds>` for one occurrence of a recurring event. */
  id: string; masterId: string; title: string; startsAt: string | null; endsAt: string | null; allDay: boolean; timezone: string | null;
  recurring: boolean; recurrenceRule: string | null; location: string | null; description: string | null; emoji: string | null;
  profileIds: string[];
  /** OWN_EVENT_SOURCE for our own events; anything else (a synced calendar such as Google) is read-only here. */
  source: string | null; editable: boolean;
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

export function mapReward(resource: unknown): Reward | null {
  const r = rec(resource);
  const id = idOf(r.id);
  const a = rec(r.attributes);
  const title = str(a.name);
  if (!id || !title) return null;
  const redeemedAt = str(a.redeemed_at);
  return {
    id, title, cost: num(a.point_value), emoji: str(a.emoji_icon), description: str(a.description),
    respawnOnRedemption: bool(a.respawn_on_redemption), redeemedAt, profileId: relationshipIds(r)[0] ?? null, redeemed: redeemedAt !== null,
  };
}

export function mapRewards(json: unknown): Reward[] {
  return dataArray(json).map(mapReward).filter((r): r is Reward => r !== null);
}

/** Create answers with `{ data: [reward...] }`; get, update, redeem and unredeem may answer with a single `{ data: reward }`. */
export function mapRewardResponse(json: unknown): Reward[] {
  const data = rec(json).data;
  if (Array.isArray(data)) return mapRewards(json);
  const one = mapReward(data);
  return one ? [one] : [];
}

export function mapList(resource: unknown): SkylightList | null {
  const r = rec(resource);
  const id = idOf(r.id);
  const a = rec(r.attributes);
  const title = str(a.label);
  if (!id || title === null) return null;
  const kind = str(a.kind);
  const items = rec(rec(r.relationships).list_items).data;
  return {
    id, title, kind: LIST_KINDS.find((k) => k === kind) ?? null, color: str(a.color), hiddenOnDevice: bool(a.hide_on_device) ?? false,
    itemCount: Array.isArray(items) ? items.length : null,
  };
}

export function mapLists(json: unknown): SkylightList[] {
  return dataArray(json).map(mapList).filter((l): l is SkylightList => l !== null);
}

export function mapListItem(resource: unknown): ListItem | null {
  const r = rec(resource);
  const id = idOf(r.id);
  const a = rec(r.attributes);
  const title = str(a.label);
  if (!id || title === null) return null;
  return { id, title, done: str(a.status) === LIST_ITEM_STATUS.done, section: str(a.section), position: num(a.position) };
}

export function mapListItems(json: unknown): ListItem[] {
  return dataArray(json).map(mapListItem).filter((i): i is ListItem => i !== null);
}

export function mapEvent(resource: unknown): CalendarEvent | null {
  const r = rec(resource);
  const id = idOf(r.id);
  const a = rec(r.attributes);
  const title = str(a.summary);
  if (!id || title === null) return null;
  let masterId = id;
  try { masterId = parseEventId(id, "id").masterId; } catch { /* keep the raw id */ }
  const rrule = Array.isArray(a.rrule) ? str(a.rrule[0]) : str(a.rrule);
  return {
    id, masterId, title, startsAt: str(a.starts_at), endsAt: str(a.ends_at), allDay: bool(a.all_day) ?? false, timezone: str(a.timezone),
    recurring: bool(a.recurring) ?? rrule !== null, recurrenceRule: rrule, location: str(a.location), description: str(a.description), emoji: str(a.emoji_icon),
    profileIds: relationshipIds(r), source: str(a.source), editable: bool(a.editable) ?? false,
  };
}

export function mapEvents(json: unknown): CalendarEvent[] {
  return dataArray(json).map(mapEvent).filter((e): e is CalendarEvent => e !== null);
}
