import { ValidationError } from "./errors.js";
import { assertHexColor, cleanText } from "./ids.js";
import { PROFILE_KINDS, linkedFromKind, type ProfileKind } from "./vocab.js";

export interface ProfileInput { name: string; color: string; kind: ProfileKind }

export interface ProfileCreateBody {
  label: string;
  color: string;
  linked_to_profile: boolean;
  selected_for_chore_chart: boolean;
}

function assertKind(value: unknown, field: string): ProfileKind {
  if (!PROFILE_KINDS.includes(value as ProfileKind)) throw new ValidationError(field, `must be one of ${PROFILE_KINDS.join(", ")}`);
  return value as ProfileKind;
}

// The web app always sends selected_for_chore_chart equal to linked_to_profile.
export function buildProfileCreateBody(input: ProfileInput): ProfileCreateBody {
  const linked = linkedFromKind(assertKind(input.kind, "kind"));
  return {
    label: cleanText(input.name, "name", 100),
    color: assertHexColor(input.color, "color"),
    linked_to_profile: linked,
    selected_for_chore_chart: linked,
  };
}

export function buildProfileUpdateBody(input: Partial<ProfileInput>): Partial<ProfileCreateBody> {
  const out: Partial<ProfileCreateBody> = {};
  if (input.name !== undefined) out.label = cleanText(input.name, "name", 100);
  if (input.color !== undefined) out.color = assertHexColor(input.color, "color");
  if (input.kind !== undefined) {
    const linked = linkedFromKind(assertKind(input.kind, "kind"));
    out.linked_to_profile = linked;
    out.selected_for_chore_chart = linked;
  }
  if (Object.keys(out).length === 0) throw new ValidationError("update", "provide at least one field to change");
  return out;
}
