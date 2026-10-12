// Single source of truth for server-defined vocabularies. Task 9 (live spike) verifies these.
export const CHORE_STATUS = { done: "complete", notDone: "pending" } as const;
// Empty until verified against the web app. While empty, tools do not expose applyTo.
export const APPLY_TO_VALUES: readonly string[] = [];
