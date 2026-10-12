// Single source of truth for server-defined vocabularies.
// Verified 2026-10-12 against the Skylight web app bundle (see docs/api.md).
export const CHORE_STATUS = { done: "complete", notDone: "pending" } as const;
// apply_to for recurring chore update/delete: "one" = this instance, "future" = this and following, "all" = whole series.
export const APPLY_TO_VALUES: readonly string[] = ["one", "future", "all"];
// Delete exposes all three scopes (verified live 2026-10-12: "one"/"future" anchor on a composite `<seriesId>-<date>` path id).
export const EXPOSED_APPLY_TO_VALUES: readonly string[] = ["one", "future", "all"];
// Update only exposes "all" (or omitted): anchor semantics for "one"/"future" on PUT are unverified.
export const EXPOSED_UPDATE_APPLY_TO_VALUES: readonly string[] = ["all"];
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
