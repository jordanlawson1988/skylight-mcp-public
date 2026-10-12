import { ID_PATTERN, parseChoreId, parseEventId, type ChoreRef } from "./ids.js";
import { hourFromRrule } from "./rrule.js";
import { ALL_PHOTOS, ALL_PHOTOS_ALBUM_ID, LIST_ITEM_STATUS, OWN_PHOTO_SENDER, LIST_KINDS, RECIPE_HEADINGS, featureName, kindFromLinked, slotFromHour, slotFromStartTime, type ListKind, type ProfileKind, type RoutineSlot } from "./vocab.js";

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

// ---- Phase 3: meals, recipes, photos, albums, devices, frame, sharing, account. These mappers deliberately drop every secret and URL.

export interface MealCategory { id: string; name: string; color: string | null; enabled: boolean; position: number | null }
export interface Recipe {
  id: string; title: string; categoryId: string | null; categoryName: string | null; description: string | null; source: string | null;
  /** Lines under "Ingredients:" (null when the description has no such section). */
  ingredients: string[] | null;
  /** Lines under "Instructions:" with their numbering removed (null when there is no such section). */
  instructions: string[] | null;
}
export interface MealSitting {
  id: string; title: string | null; description: string | null; note: string | null; recurring: boolean; recurrenceRule: string | null;
  /** Every date this row covers (YYYY-MM-DD). */
  instances: string[]; categoryId: string | null; recipeId: string | null;
}
/** One planned meal on one date. */
export interface MealRow {
  mealId: string; date: string; category: { id: string; name: string | null } | null; title: string | null; recipeId: string | null;
  note: string | null; recurring: boolean; recurrenceRule: string | null;
}
export interface Album { id: string; title: string; photoCount: number | null; videoCount: number | null; editable: boolean | null }
export interface Photo { id: string; type: string | null; createdAt: string | null; caption: string | null; from: string | null; commentsCount: number | null }
export interface PhotoPage { page: number; pages: number; photos: Photo[] }
export interface Device {
  id: string; name: string; timezone: string | null; brightness: number | null; sleepsAt: string | null; wakesAt: string | null;
  sleeping: boolean | null; sleepModeOn: boolean | null; showCaption: boolean | null; showHeart: boolean | null; blurEffect: boolean | null;
  slideshowSpeed: number | null; slideshowStyle: number | null; startSound: boolean | null;
  /** "all" when the slideshow plays every photo, else the album id. */
  currentAlbumId: string | null;
}
export interface Frame {
  id: string; name: string | null; timezone: string | null; householdName: string | null; locale: string | null;
  photosOpenToPublic: boolean | null; photoViewability: string | null; features: Record<string, boolean>; plus: boolean | null;
}
export interface FrameUser { userId: string; email: string | null; status: string | null; owner: boolean }
export interface PlusSubscription { status: string | null; cadence: string | null; type: string | null }

export function mapMealCategory(resource: unknown): MealCategory | null {
  const r = rec(resource);
  const id = idOf(r.id);
  const a = rec(r.attributes);
  const name = str(a.label);
  if (!id || !name) return null;
  return { id, name, color: str(a.color), enabled: bool(a.enabled) ?? true, position: num(a.position) };
}

export function mapMealCategories(json: unknown): MealCategory[] {
  return dataArray(json).map(mapMealCategory).filter((c): c is MealCategory => c !== null);
}

const RECIPE_HEADING = /^[A-Za-z][A-Za-z ]*:$/;
const NUMBERING = /^\d+[.)]\s*/;

/** Split a recipe description written in the app's convention ("Ingredients:\n- a\n\nInstructions:\n1. x\n") into its two lists. */
export function parseRecipeDescription(description: string | null): { ingredients: string[] | null; instructions: string[] | null } {
  let ingredients: string[] | null = null;
  let instructions: string[] | null = null;
  let section: "ingredients" | "instructions" | "other" | null = null;
  for (const raw of (description ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    if (RECIPE_HEADING.test(line)) {
      const heading = line.toLowerCase();
      if (heading === RECIPE_HEADINGS.ingredients.toLowerCase()) { section = "ingredients"; ingredients ??= []; }
      else if (heading === RECIPE_HEADINGS.instructions.toLowerCase()) { section = "instructions"; instructions ??= []; }
      else section = "other";
      continue;
    }
    if (section === "ingredients" && ingredients !== null) {
      if (line.startsWith("- ")) { const item = line.slice(2).trim(); if (item !== "") ingredients.push(item); }
    } else if (section === "instructions" && instructions !== null) {
      const step = line.replace(NUMBERING, "").trim();
      if (step !== "") instructions.push(step);
    }
  }
  return { ingredients, instructions };
}

function includedNames(json: unknown, type: string): Map<string, string> {
  const included = rec(json).included;
  const out = new Map<string, string>();
  if (Array.isArray(included)) for (const item of included) {
    const r = rec(item);
    const id = idOf(r.id);
    const label = str(rec(r.attributes).label);
    if (id && label && r.type === type) out.set(id, label);
  }
  return out;
}

export function mapRecipe(resource: unknown, names: ReadonlyMap<string, string> = new Map()): Recipe | null {
  const r = rec(resource);
  const id = idOf(r.id);
  const a = rec(r.attributes);
  const title = str(a.summary);
  if (!id || title === null) return null;
  const categoryId = idOf(rec(rec(rec(r.relationships).meal_category).data).id);
  const description = str(a.description);
  return { id, title, categoryId, categoryName: categoryId === null ? null : names.get(categoryId) ?? null, description, source: str(a.source), ...parseRecipeDescription(description) };
}

export function mapRecipes(json: unknown): Recipe[] {
  const names = includedNames(json, "meal_category");
  return dataArray(json).map((r) => mapRecipe(r, names)).filter((r): r is Recipe => r !== null);
}

/** `{ data: recipe }` (get, create, update). */
export function mapRecipeResponse(json: unknown): Recipe | null {
  return mapRecipe(rec(json).data, includedNames(json, "meal_category"));
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function mapSitting(resource: unknown): MealSitting | null {
  const r = rec(resource);
  const id = idOf(r.id);
  const a = rec(r.attributes);
  if (!id) return null;
  const rule = str(a.rrule);
  const rels = rec(r.relationships);
  return {
    id, title: str(a.summary), description: str(a.description), note: str(a.note),
    recurring: bool(a.recurring) ?? rule !== null, recurrenceRule: rule,
    instances: Array.isArray(a.instances) ? a.instances.filter((d): d is string => typeof d === "string" && DATE.test(d)) : [],
    categoryId: idOf(rec(rec(rels.meal_category).data).id), recipeId: idOf(rec(rec(rels.meal_recipe).data).id),
  };
}

export function mapSittings(json: unknown): MealSitting[] {
  return dataArray(json).map(mapSitting).filter((s): s is MealSitting => s !== null);
}

/** One row per date, sorted by date, then the category's position (unknown categories last), then title and id. `window` drops dates outside it. */
export function explodeSittings(sittings: readonly MealSitting[], categories: readonly MealCategory[], window: { after?: string; before?: string } = {}): MealRow[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const rows: Array<MealRow & { position: number }> = [];
  for (const s of sittings) {
    const category = s.categoryId === null ? null : byId.get(s.categoryId) ?? null;
    for (const date of s.instances) {
      if ((window.after !== undefined && date < window.after) || (window.before !== undefined && date > window.before)) continue;
      rows.push({
        mealId: s.id, date, category: s.categoryId === null ? null : { id: s.categoryId, name: category?.name ?? null }, title: s.title, recipeId: s.recipeId,
        note: s.note, recurring: s.recurring, recurrenceRule: s.recurrenceRule, position: category?.position ?? Infinity,
      });
    }
  }
  const text = (x: string | null): string => x ?? "";
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || (a.position === b.position ? 0 : a.position < b.position ? -1 : 1)
    || (text(a.title) < text(b.title) ? -1 : text(a.title) > text(b.title) ? 1 : 0) || (a.mealId < b.mealId ? -1 : a.mealId > b.mealId ? 1 : 0));
  return rows.map(({ position: _position, ...row }) => row);
}

export function mapAlbum(resource: unknown): Album | null {
  const r = rec(resource);
  const id = idOf(r.id);
  const a = rec(r.attributes);
  const title = str(a.title);
  if (!id || title === null) return null;
  return { id, title, photoCount: num(a.photos_count), videoCount: num(a.videos_count), editable: bool(a.editable) };
}

export function mapAlbums(json: unknown): Album[] {
  return dataArray(json).map(mapAlbum).filter((a): a is Album => a !== null);
}

/**
 * A photo or video ("message"). The asset and thumbnail URLs and storage keys are never read, and the frame owner's email is never returned: `from` is
 * OWN_PHOTO_SENDER when `sender_id` is the frame owner's user id (the message's own `frame_owner_id`, else `fallbackOwnerId`), the sender's email for
 * anyone else, and null when the owner or the sender cannot be identified (so an unrecognised owner's email can not leak).
 */
export function mapPhoto(resource: unknown, fallbackOwnerId: string | null = null): Photo | null {
  const r = rec(resource);
  const id = idOf(r.id);
  const a = rec(r.attributes);
  if (!id) return null;
  const owner = idOf(a.frame_owner_id) ?? fallbackOwnerId;
  const sender = idOf(a.sender_id);
  const email = str(a.from_email);
  const from = owner === null || sender === null ? null : sender === owner ? OWN_PHOTO_SENDER : email;
  return { id, type: str(a.asset_type), createdAt: str(a.created_at), caption: str(a.caption), from, commentsCount: num(a.comments_count) };
}

/** True when every message in the response names the frame owner (`frame_owner_id`), so no other lookup is needed to tell the owner's own photos. */
export function photosCarryOwner(json: unknown): boolean {
  return dataArray(json).every((m) => idOf(rec(m.attributes).frame_owner_id) !== null);
}

export function mapPhotoPage(json: unknown, requestedPage: number, fallbackOwnerId: string | null = null): PhotoPage {
  const meta = rec(rec(json).meta);
  return { page: num(meta.current_page) ?? requestedPage, pages: num(meta.num_pages) ?? 1, photos: dataArray(json).map((m) => mapPhoto(m, fallbackOwnerId)).filter((p): p is Photo => p !== null) };
}

export function mapDevice(resource: unknown): Device | null {
  const r = rec(resource);
  const id = idOf(r.id);
  const a = rec(r.attributes);
  const name = str(a.name);
  if (!id || name === null) return null;
  const album = num(a.current_album_id);
  return {
    id, name, timezone: str(a.timezone), brightness: num(a.brightness), sleepsAt: str(a.sleeps_at), wakesAt: str(a.wakes_at),
    sleeping: bool(a.currently_sleeping), sleepModeOn: bool(a.sleep_mode_on), showCaption: bool(a.show_caption), showHeart: bool(a.show_heart), blurEffect: bool(a.blur_effect),
    slideshowSpeed: num(a.slideshow_speed), slideshowStyle: num(a.slideshow_style), startSound: bool(a.start_sound),
    currentAlbumId: album === null ? null : album === ALL_PHOTOS_ALBUM_ID ? ALL_PHOTOS : String(album),
  };
}

export function mapDevices(json: unknown): Device[] {
  return dataArray(json).map(mapDevice).filter((d): d is Device => d !== null);
}

/** The frame without share_token, notification_email, owner_name/birthday, hardware model or gift fields. */
export function mapFrame(resource: unknown): Frame | null {
  const r = rec(resource);
  const id = idOf(r.id);
  const a = rec(r.attributes);
  if (!id) return null;
  const features: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(rec(a.feature_bundle))) {
    const enabled = bool(rec(value).enabled);
    if (enabled !== null) features[featureName(key)] = enabled;
  }
  return {
    id, name: str(a.name), timezone: str(a.timezone), householdName: str(a.household_name), locale: str(a.locale),
    photosOpenToPublic: bool(a.open_to_public), photoViewability: str(a.message_viewability), features, plus: bool(a.plus),
  };
}

/** Frame sharing rows: the `user` relationship id is the id the block and approve endpoints take. */
export function mapFrameUsers(json: unknown): FrameUser[] {
  const emails = new Map<string, string>();
  const included = rec(json).included;
  if (Array.isArray(included)) for (const item of included) {
    const u = rec(item);
    const id = idOf(u.id);
    const email = str(rec(u.attributes).email);
    if (id && email) emails.set(id, email);
  }
  const out: FrameUser[] = [];
  for (const row of dataArray(json)) {
    const userId = idOf(rec(rec(rec(row.relationships).user).data).id);
    if (!userId) continue;
    const a = rec(row.attributes);
    out.push({ userId, email: emails.get(userId) ?? null, status: str(a.status), owner: bool(a.is_owner) ?? false });
  }
  return out;
}

/** GET /api/user: only the plan and the marketing flag. Email, phone, birthday, name and the rest are never read. */
export function mapAccount(json: unknown): { plan: string | null; marketingEmails: boolean | null } {
  const a = rec(rec(rec(json).data).attributes);
  return { plan: str(a.subscription_status), marketingEmails: bool(a.agreed_to_marketing) };
}

/** GET /api/plus_access: `{ data: { subscriptions: [{ attributes: { plus_type, status, ... } }], shares } }`. Payment tokens and ids are not read. */
export function mapPlusSubscriptions(json: unknown): PlusSubscription[] {
  const subs = rec(rec(json).data).subscriptions;
  if (!Array.isArray(subs)) return [];
  return subs.map((s) => {
    const a = rec(rec(s).attributes);
    return { status: str(a.status), cadence: str(a.cadence), type: str(a.plus_type) };
  });
}

/** The family's default grocery list (lists[].attributes.default_grocery_list), where Skylight puts a recipe's ingredients. */
export function mapDefaultGroceryList(json: unknown): { id: string; title: string } | null {
  for (const l of dataArray(json)) {
    if (bool(rec(l.attributes).default_grocery_list) !== true) continue;
    const id = idOf(l.id);
    const title = str(rec(l.attributes).label);
    if (id && title !== null) return { id, title };
  }
  return null;
}
