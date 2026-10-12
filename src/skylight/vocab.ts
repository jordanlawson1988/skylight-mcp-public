// Single source of truth for server-defined vocabularies.
// Verified 2026-10-12 against the Skylight web app bundle (see docs/api.md).
export const CHORE_STATUS = { done: "complete", notDone: "pending" } as const;
// apply_to for recurring chore update/delete: "one" = this instance, "future" = this and following, "all" = whole series.
export const APPLY_TO_VALUES: readonly string[] = ["one", "future", "all"];
