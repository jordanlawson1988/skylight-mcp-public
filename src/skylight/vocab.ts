// Single source of truth for server-defined vocabularies.
// Verified 2026-10-12 against the Skylight web app bundle (see docs/api.md).
export const CHORE_STATUS = { done: "complete", notDone: "pending" } as const;
// apply_to for recurring chore update/delete: "one" = this instance, "future" = this and following, "all" = whole series.
export const APPLY_TO_VALUES: readonly string[] = ["one", "future", "all"];
// Delete exposes all three scopes (verified live 2026-10-12: "one"/"future" anchor on a composite `<seriesId>-<date>` path id).
export const EXPOSED_APPLY_TO_VALUES: readonly string[] = ["one", "future", "all"];
// The whole series. Update only exposes "all" (or omitted): anchor semantics for "one"/"future" on PUT are unverified.
export const APPLY_TO_ALL = "all";
export const EXPOSED_UPDATE_APPLY_TO_VALUES: readonly string[] = [APPLY_TO_ALL];
// Skylight "categories": a person with a chore-chart column ("profile", linked_to_profile: true) or a calendar category such as Birthdays ("label").
export const PROFILE_KINDS = ["profile", "label"] as const;
export type ProfileKind = (typeof PROFILE_KINDS)[number];
export const kindFromLinked = (linked: boolean | null): ProfileKind | null => linked === null ? null : linked ? "profile" : "label";
export const linkedFromKind = (kind: ProfileKind): boolean => kind === "profile";
export const DEFAULT_PROFILE_KIND: ProfileKind = "profile";
/** True for a person (profile with a chore-chart column), false for a calendar label or unknown. */
export const isPersonKind = (kind: ProfileKind | null): boolean => kind !== null && linkedFromKind(kind);

// Routine steps belong to one of three daily routines. Skylight keys them by BYHOUR in the recurrence rule (verified live 2026-10-12: only 6, 14 and 20 are accepted)
// and derives the occurrence start_time ("06:00", "14:00", "20:00") from it.
export const ROUTINE_SLOTS = { morning: 6, afternoon: 14, evening: 20 } as const;
export type RoutineSlot = keyof typeof ROUTINE_SLOTS;
export type RoutineHour = (typeof ROUTINE_SLOTS)[RoutineSlot];
export const ROUTINE_SLOT_NAMES = Object.keys(ROUTINE_SLOTS) as [RoutineSlot, ...RoutineSlot[]];
export const slotFromHour = (hour: number | null): RoutineSlot | null =>
  ROUTINE_SLOT_NAMES.find((slot) => ROUTINE_SLOTS[slot] === hour) ?? null;
/** "06:00" -> "morning"; anything that is not exactly a routine hour on the hour -> null. */
export const slotFromStartTime = (startTime: string | null): RoutineSlot | null => {
  const m = startTime === null ? null : /^(\d{2}):00$/.exec(startTime);
  return m ? slotFromHour(Number(m[1])) : null;
};
/** True for a calendar label such as Birthdays; false for a person or an unknown kind. */
export const isLabelKind = (kind: ProfileKind | null): boolean => kind !== null && !linkedFromKind(kind);

// Lists (verified live 2026-10-12): kind is one of three values; an item is "pending" or "completed".
export const LIST_KINDS = ["to_do", "shopping", "other"] as const;
export type ListKind = (typeof LIST_KINDS)[number];
export const DEFAULT_LIST_KIND: ListKind = "to_do";
export const LIST_ITEM_STATUS = { done: "completed", notDone: "pending" } as const;
export const DEFAULT_LIST_COLOR = "#42D792";

// Calendar events: `source` is "skylight" for events created here or in the app; anything else comes from a synced calendar (e.g. "google") and is read-only for us.
export const OWN_EVENT_SOURCE = "skylight";
export const EVENT_KIND = "standard";

// Toolsets: SKYLIGHT_TOOLSETS picks which tool groups the server registers (skylight_auth_status is always registered).
export const TOOLSETS = ["profiles", "chores", "rewards", "lists", "calendar", "meals", "photos", "devices", "frame", "account"] as const;
export type Toolset = (typeof TOOLSETS)[number];

// Meals (verified live 2026-10-12): a sitting that repeats takes apply_to one|future|all on update and delete; a one-time sitting takes none.
export const MEAL_SCOPE = { one: "one", future: "future", all: "all" } as const;
export type MealScope = keyof typeof MEAL_SCOPE;
export const EXPOSED_MEAL_APPLY_TO_VALUES: readonly string[] = Object.values(MEAL_SCOPE);
export const MEAL_SCOPE_TEXT = { one: "only this date", future: "this date and later", all: "every date of this meal", none: "this meal" } as const;
/** The app writes a recipe description as "Ingredients:\n- a\n\nInstructions:\n1. x\n"; these are the two section headings. */
export const RECIPE_HEADINGS = { ingredients: "Ingredients:", instructions: "Instructions:" } as const;
/** Skylight writes a sitting's repeat rule without the "RRULE:" prefix (and stores one sent with it stripped). */
export const RRULE_PREFIX = "RRULE:";

// Devices: current_album_id -1 means the slideshow plays every photo.
export const ALL_PHOTOS_ALBUM_ID = -1;
export const ALL_PHOTOS = "all";

// Photos: the sender shown for a photo the frame owner sent (their email is never returned); other senders are shown by email, as Skylight does.
export const OWN_PHOTO_SENDER = "you";

// Frame sharing (bundle + live 2026-10-12): blocking a user makes their status "rejected"; approving moves it back to "approved".
export const FRAME_USER_STATUS = { approved: "approved", blocked: "rejected", awaitingApproval: "awaiting_approval" } as const;

// feature_bundle keys shown under another name (the bundle calls meal planning "meal_planning").
const FEATURE_NAMES: Readonly<Record<string, string>> = { meal_planning: "meals" };
export const featureName = (key: string): string => FEATURE_NAMES[key] ?? key;
