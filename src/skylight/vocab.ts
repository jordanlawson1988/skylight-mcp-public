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
