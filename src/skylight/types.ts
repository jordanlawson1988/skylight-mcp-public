import { ID_PATTERN, parseChoreId, type ChoreRef } from "./ids.js";

export interface Profile { id: string; name: string; color: string | null; isAdult: boolean | null }
export interface Chore {
  id: string; summary: string; start: string | null; startTime: string | null; status: string | null;
  routine: boolean; recurring: boolean; recurrenceRule: string | null; rewardPoints: number | null; emoji: string | null; profileIds: string[];
  /** Numeric series id (attributes.series, else the numeric prefix of a composite id). Use it in request paths. */
  seriesId: string;
  /** Occurrence date: the date in a composite id, else attributes.start, else null. */
  instanceDate: string | null;
}
export interface RewardPoints { profileId: string; points: number }
export interface Reward { id: string; title: string; cost: number | null; emoji: string | null; redeemedAt: string | null; profileIds: string[] }

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

export function mapProfiles(json: unknown): Profile[] {
  const out: Profile[] = [];
  for (const r of dataArray(json)) {
    const id = idOf(r.id);
    const a = rec(r.attributes);
    const name = str(a.label) ?? str(a.name);
    if (!id || !name) continue;
    const type = str(a.profile_type);
    const isAdult = bool(a.adult) ?? bool(a.is_adult) ?? (type ? type !== "child" : null);
    out.push({ id, name, color: str(a.color), isAdult });
  }
  return out;
}

export function mapChore(resource: unknown): Chore | null {
  const r = rec(resource);
  const id = idOf(r.id);
  const a = rec(r.attributes);
  const summary = str(a.summary);
  if (!id || summary === null) return null;
  const rs = a.recurrence_set;
  const rule = Array.isArray(rs) ? str(rs[0]) : str(rs);
  let ref: ChoreRef;
  try { ref = parseChoreId(id, "id"); } catch { ref = { seriesId: id, instanceDate: null }; }
  return {
    id, summary,
    start: str(a.start), startTime: str(a.start_time), status: str(a.status),
    routine: bool(a.routine) ?? false,
    recurring: bool(a.recurring) ?? rule !== null,
    recurrenceRule: rule,
    rewardPoints: num(a.reward_points), emoji: str(a.emoji_icon),
    profileIds: relationshipIds(r),
    seriesId: idOf(a.series) ?? ref.seriesId,
    instanceDate: ref.instanceDate ?? str(a.start),
  };
}

export function mapChores(json: unknown): Chore[] {
  return dataArray(json).map(mapChore).filter((c): c is Chore => c !== null);
}

export function mapRewardPoints(json: unknown): RewardPoints[] {
  const out: RewardPoints[] = [];
  for (const r of dataArray(json)) {
    const a = rec(r.attributes);
    const profileId = idOf(a.category_id) ?? relationshipIds(r)[0] ?? null;
    const points = num(a.points);
    if (profileId && points !== null) out.push({ profileId, points });
  }
  return out;
}

export function mapRewards(json: unknown): Reward[] {
  const out: Reward[] = [];
  for (const r of dataArray(json)) {
    const id = idOf(r.id);
    const a = rec(r.attributes);
    const title = str(a.title) ?? str(a.summary) ?? str(a.name);
    if (!id || !title) continue;
    out.push({ id, title, cost: num(a.reward_points) ?? num(a.points) ?? num(a.cost), emoji: str(a.emoji_icon), redeemedAt: str(a.redeemed_at), profileIds: relationshipIds(r) });
  }
  return out;
}
