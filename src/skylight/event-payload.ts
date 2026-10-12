import { ValidationError } from "./errors.js";
import { assertProfileIds, MAX_DESCRIPTION_LENGTH } from "./chore-payload.js";
import { assertDate, assertDateTimeWithOffset, assertEmoji, cleanText } from "./ids.js";
import { buildRrule, type Recurrence } from "./rrule.js";
import { EVENT_KIND } from "./vocab.js";

export const MAX_EVENT_TITLE_LENGTH = 200;
export const MAX_LOCATION_LENGTH = 200;
const HOUR_MS = 3_600_000;

export interface EventFields {
  title?: string | undefined;
  profileIds?: string[] | undefined;
  allDay?: boolean | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  startsAt?: string | undefined;
  endsAt?: string | undefined;
  timezone?: string | undefined;
  recurrence?: Recurrence | undefined;
  location?: string | undefined;
  description?: string | undefined;
  emoji?: string | undefined;
  countdown?: boolean | undefined;
}

export interface EventCreateBody {
  summary: string;
  kind: string;
  category_ids: string[];
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  rrule: string[] | null;
  invited_emails: string[];
  location: string | null;
  lat: null;
  lng: null;
  description: string | null;
  emoji_icon: string | null;
  calendar_account_id: null;
  calendar_id: null;
  timezone: string;
  countdown_enabled: boolean;
}

export type EventUpdateBody = Partial<Pick<EventCreateBody, "summary" | "category_ids" | "starts_at" | "ends_at" | "all_day" | "rrule" | "location" | "description" | "emoji_icon" | "timezone" | "countdown_enabled">>;

export const localTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** IANA zone name such as "America/New_York" (anything Intl accepts). */
export function assertTimezone(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(field, "must be an IANA timezone such as America/New_York");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new ValidationError(field, "must be an IANA timezone such as America/New_York");
  }
  return value;
}

const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

/** Add whole hours to a datetime that carries an offset, keeping that offset (2026-10-12T18:30:00-04:00 + 1h = 2026-10-12T19:30:00-04:00). */
export function addHoursKeepingOffset(value: string, hours: number): string {
  const offset = OFFSET.exec(value)![1]!;
  const sign = offset === "Z" ? 0 : offset[0] === "-" ? -1 : 1;
  const offsetMinutes = offset === "Z" ? 0 : sign * (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const utc = Date.parse(value) + hours * HOUR_MS;
  return `${new Date(utc + offsetMinutes * 60_000).toISOString().slice(0, 19)}${offset}`;
}

function assertNotBefore(start: string, end: string, field: string): void {
  if (Date.parse(end) < Date.parse(start)) throw new ValidationError(field, "must not be before the start");
}

function eventText(input: EventFields, out: { summary?: string; location?: string | null; description?: string | null; emoji_icon?: string | null }, nullable: boolean): void {
  if (input.title !== undefined) out.summary = cleanText(input.title, "title", MAX_EVENT_TITLE_LENGTH);
  if (input.location !== undefined) out.location = cleanText(input.location, "location", MAX_LOCATION_LENGTH);
  else if (nullable) out.location = null;
  if (input.description !== undefined) out.description = cleanText(input.description, "description", MAX_DESCRIPTION_LENGTH);
  else if (nullable) out.description = null;
  if (input.emoji !== undefined) out.emoji_icon = assertEmoji(input.emoji, "emoji");
  else if (nullable) out.emoji_icon = null;
}

function rruleOf(recurrence: Recurrence): string[] {
  if (recurrence.hour !== undefined) throw new ValidationError("recurrence.hour", "is only for routine steps");
  return [buildRrule(recurrence)];
}

/** All-day: startDate (+ endDate, default the start). Timed: startsAt with a UTC offset (+ endsAt, default start + 1h). */
export function buildEventCreateBody(input: EventFields): EventCreateBody {
  if (input.title === undefined) throw new ValidationError("title", "is required");
  if (input.profileIds === undefined) throw new ValidationError("profileIds", "must list at least one profile id");
  const allDay = input.allDay === true;
  let startsAt: string;
  let endsAt: string;
  if (allDay) {
    if (input.startsAt !== undefined || input.endsAt !== undefined) throw new ValidationError("startsAt", "is for timed events; an all-day event uses startDate and endDate");
    if (input.startDate === undefined) throw new ValidationError("startDate", "is required for an all-day event");
    startsAt = assertDate(input.startDate, "startDate");
    endsAt = input.endDate === undefined ? startsAt : assertDate(input.endDate, "endDate");
    if (endsAt < startsAt) throw new ValidationError("endDate", "must not be before startDate");
  } else {
    if (input.startDate !== undefined || input.endDate !== undefined) throw new ValidationError("startDate", "is for all-day events; set allDay: true, or use startsAt and endsAt");
    if (input.startsAt === undefined) throw new ValidationError("startsAt", "is required for a timed event (or set allDay: true with startDate)");
    startsAt = assertDateTimeWithOffset(input.startsAt, "startsAt");
    endsAt = input.endsAt === undefined ? addHoursKeepingOffset(startsAt, 1) : assertDateTimeWithOffset(input.endsAt, "endsAt");
    assertNotBefore(startsAt, endsAt, "endsAt");
  }
  const text: { summary?: string; location?: string | null; description?: string | null; emoji_icon?: string | null } = {};
  eventText(input, text, true);
  return {
    summary: text.summary!,
    kind: EVENT_KIND,
    category_ids: assertProfileIds(input.profileIds),
    starts_at: startsAt,
    ends_at: endsAt,
    all_day: allDay,
    rrule: input.recurrence === undefined ? null : rruleOf(input.recurrence),
    invited_emails: [],
    location: text.location ?? null,
    lat: null,
    lng: null,
    description: text.description ?? null,
    emoji_icon: text.emoji_icon ?? null,
    calendar_account_id: null,
    calendar_id: null,
    timezone: input.timezone === undefined ? localTimezone() : assertTimezone(input.timezone, "timezone"),
    countdown_enabled: input.countdown ?? false,
  };
}

/** Only the provided fields. Dates imply all_day: true, datetimes imply all_day: false. */
export function buildEventUpdateBody(input: EventFields): EventUpdateBody {
  const out: EventUpdateBody = {};
  const hasDates = input.startDate !== undefined || input.endDate !== undefined;
  const hasTimes = input.startsAt !== undefined || input.endsAt !== undefined;
  if (hasDates && hasTimes) throw new ValidationError("startDate", "cannot be combined with startsAt/endsAt; an event is either all-day or timed");
  if (input.allDay === true && hasTimes) throw new ValidationError("allDay", "is true, so use startDate and endDate instead of startsAt and endsAt");
  if (input.allDay === false && hasDates) throw new ValidationError("allDay", "is false, so use startsAt and endsAt instead of startDate and endDate");
  if (hasDates) {
    if (input.startDate !== undefined) out.starts_at = assertDate(input.startDate, "startDate");
    if (input.endDate !== undefined) out.ends_at = assertDate(input.endDate, "endDate");
    if (out.starts_at !== undefined && out.ends_at !== undefined && out.ends_at < out.starts_at) throw new ValidationError("endDate", "must not be before startDate");
    out.all_day = true;
  } else if (hasTimes) {
    if (input.startsAt !== undefined) out.starts_at = assertDateTimeWithOffset(input.startsAt, "startsAt");
    if (input.endsAt !== undefined) out.ends_at = assertDateTimeWithOffset(input.endsAt, "endsAt");
    if (out.starts_at !== undefined && out.ends_at !== undefined) assertNotBefore(out.starts_at, out.ends_at, "endsAt");
    out.all_day = false;
  } else if (input.allDay !== undefined) {
    out.all_day = input.allDay;
  }
  const text: { summary?: string; location?: string | null; description?: string | null; emoji_icon?: string | null } = {};
  eventText(input, text, false);
  Object.assign(out, text);
  if (input.profileIds !== undefined) out.category_ids = assertProfileIds(input.profileIds);
  if (input.recurrence !== undefined) out.rrule = rruleOf(input.recurrence);
  if (input.timezone !== undefined) out.timezone = assertTimezone(input.timezone, "timezone");
  if (input.countdown !== undefined) out.countdown_enabled = input.countdown;
  if (Object.keys(out).length === 0) throw new ValidationError("update", "provide at least one field to change");
  return out;
}
