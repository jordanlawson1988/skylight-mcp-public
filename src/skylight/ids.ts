import { ValidationError } from "./errors.js";

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

export function assertId(value: string | number, field: string): string {
  const s = typeof value === "number" ? String(value) : value;
  if (typeof s !== "string" || !ID_PATTERN.test(s)) {
    throw new ValidationError(field, "must be 1-64 letters, digits, '_' or '-'");
  }
  return s;
}

/** A positive decimal id of at most 15 digits (list item ids), returned as a string; the API wants them as JSON numbers in bodies. */
export function assertNumericId(value: string | number, field: string): string {
  const s = typeof value === "number" ? String(value) : value;
  if (typeof s !== "string" || !/^[1-9]\d{0,14}$/.test(s)) throw new ValidationError(field, "must be a numeric id as returned by the list tools");
  return s;
}

/** `<series>-<YYYY-MM-DD>` with an optional `-HHMM` suffix (routine-step occurrences, e.g. `60913118-2026-10-12-0600`). */
export const COMPOSITE_CHORE_ID = /^(\d+)-(\d{4}-\d{2}-\d{2})(?:-(\d{2})(\d{2}))?$/;

export interface ChoreRef { seriesId: string; instanceDate: string | null; /** "HH:mm" from a time-suffixed id, else null. */ instanceTime: string | null }

/** Accepts "123", "123-2026-10-13" or "123-2026-10-13-0600". Throws ValidationError(field) otherwise. */
export function parseChoreId(value: unknown, field: string): ChoreRef {
  const id = assertId(value as string | number, field);
  const m = COMPOSITE_CHORE_ID.exec(id);
  if (!m) return { seriesId: id, instanceDate: null, instanceTime: null };
  return {
    seriesId: m[1]!,
    instanceDate: assertDate(m[2]!, field),
    instanceTime: m[3] === undefined ? null : assertTime(`${m[3]}:${m[4]}`, field),
  };
}

/** `<masterId>` or `<masterId>-<unixSeconds>` (an occurrence of a recurring calendar event, e.g. `11019627806-1791803100`). */
export const COMPOSITE_EVENT_ID = /^(\d+)(?:-(\d+))?$/;

export interface EventRef { masterId: string; /** Unix seconds of the occurrence, null for a plain (master or one-off) id. */ occurrence: number | null }

/** Accepts "123" or "123-1791803100". Throws ValidationError(field) otherwise. */
export function parseEventId(value: unknown, field: string): EventRef {
  const id = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  const m = id.length <= 64 ? COMPOSITE_EVENT_ID.exec(id) : null;
  if (!m) throw new ValidationError(field, "must be an event id as listed by skylight_list_events: digits, or digits-digits for one occurrence of a recurring event");
  const occurrence = m[2] === undefined ? null : Number(m[2]);
  if (occurrence !== null && !Number.isSafeInteger(occurrence)) throw new ValidationError(field, "has an occurrence timestamp that is too large");
  return { masterId: m[1]!, occurrence };
}

export function localDateString(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Calendar-day arithmetic on a YYYY-MM-DD string (UTC math, so DST never shifts the result). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function assertDate(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ValidationError(field, "must be YYYY-MM-DD");
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(field, "is not a real calendar date");
  }
  return value;
}

export function assertTime(value: string, field: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new ValidationError(field, "must be HH:mm (24h)");
  return value;
}

export function cleanText(value: string, field: string, max: number): string {
  if (typeof value !== "string") throw new ValidationError(field, "must be a string");
  if (!value.isWellFormed()) throw new ValidationError(field, "must be well-formed unicode");
  if (CONTROL.test(value)) throw new ValidationError(field, "must not contain control characters");
  const out = value.normalize("NFC").trim();
  if (out.length === 0) throw new ValidationError(field, "must not be blank");
  if (out.length > max) throw new ValidationError(field, `must be at most ${max} characters`);
  return out;
}

export function assertEmoji(value: string, field: string): string {
  const out = cleanText(value, field, 64);
  if (/\s/.test(out)) throw new ValidationError(field, "must not contain whitespace");
  const points = [...out].length;
  if (points < 1 || points > 8) throw new ValidationError(field, "must be 1-8 code points");
  return out;
}

export function assertPoints(value: number, field: string): number {
  if (!Number.isInteger(value) || value < -10000 || value > 10000) {
    throw new ValidationError(field, "must be an integer from -10000 to 10000");
  }
  return value;
}

/** "#RRGGBB" hex color, normalised to upper case. */
export function assertHexColor(value: string, field: string): string {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/.test(value)) throw new ValidationError(field, "must be a hex color like #CB434C");
  return value.toUpperCase();
}

const OFFSET_DATETIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

/** `YYYY-MM-DDTHH:mm(:ss(.SSS)?)?` followed by `Z` or `+HH:mm`/`-HH:mm`. Skylight reads a bare datetime as UTC, so the offset is mandatory. */
export function assertDateTimeWithOffset(value: string, field: string): string {
  const m = typeof value === "string" ? OFFSET_DATETIME.exec(value) : null;
  if (!m) throw new ValidationError(field, "must be a datetime like 2026-10-12T18:30:00-04:00 (date, time and UTC offset)");
  if (m[5] === undefined) throw new ValidationError(field, "include a UTC offset, e.g. 2026-10-12T18:30:00-04:00, because Skylight reads bare times as UTC");
  assertDate(m[1]!, field);
  if (Number(m[2]) > 23 || Number(m[3]) > 59 || (m[4] !== undefined && Number(m[4]) > 59)) throw new ValidationError(field, "is not a real time of day");
  if (m[5] !== "Z" && (Number(m[5].slice(1, 3)) > 23 || Number(m[5].slice(4, 6)) > 59)) throw new ValidationError(field, "has an invalid UTC offset");
  return value;
}
