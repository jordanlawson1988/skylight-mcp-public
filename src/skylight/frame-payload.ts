import { ValidationError } from "./errors.js";
import { assertTimezone } from "./event-payload.js";
import { cleanText } from "./ids.js";

export const MAX_HOUSEHOLD_NAME_LENGTH = 60;
const LOCALE = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/;

export interface FrameUpdateInput {
  /** null clears the household name. */
  householdName?: string | null | undefined;
  timezone?: string | undefined;
  locale?: string | undefined;
}

export interface FrameUpdateBody { household_name?: string | null; timezone?: string; locale?: string }

/**
 * Only household name, timezone and locale. open_to_public and message_viewability are deliberately absent: their vocabulary is unverified
 * and a wrong value could publish the family's photos.
 */
export function buildFrameUpdateBody(input: FrameUpdateInput): FrameUpdateBody {
  const out: FrameUpdateBody = {};
  if (input.householdName !== undefined) out.household_name = input.householdName === null ? null : cleanText(input.householdName, "householdName", MAX_HOUSEHOLD_NAME_LENGTH);
  if (input.timezone !== undefined) out.timezone = assertTimezone(input.timezone, "timezone");
  if (input.locale !== undefined) {
    if (typeof input.locale !== "string" || !LOCALE.test(input.locale)) throw new ValidationError("locale", "must be a language code such as en or en-US");
    out.locale = input.locale;
  }
  if (Object.keys(out).length === 0) throw new ValidationError("update", "provide at least one of householdName, timezone or locale");
  return out;
}
