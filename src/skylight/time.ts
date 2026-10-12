// Pure time helpers. Skylight keeps UTC on the wire; everything a person reads or types goes through these in the configured zone.
import { ValidationError } from "./errors.js";

export const DEFAULT_TIMEZONE = "America/New_York";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;
const MINUTE_MS = 60_000;
// Offsets are +/-HH:mm. Pre-1900 local-mean-time offsets with seconds (for example +00:53:28) are not supported.
const HAS_ZONE = /(?:Z|[+-]\d{2}:\d{2})$/;

const pad = (n: number): string => String(Math.abs(n)).padStart(2, "0");
const formatOffset = (minutes: number): string => `${minutes < 0 ? "-" : "+"}${pad(Math.trunc(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`;

/** True for a zone name Intl accepts. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz.trim() !== "";
  } catch {
    return false;
  }
}

/**
 * Epoch ms of an ISO datetime, never through the process time zone: a datetime with no `Z`/`±HH:mm` suffix is read as UTC
 * (JS would otherwise read it as local time). NaN when invalid.
 */
export function parseInstant(iso: string): number {
  return Date.parse(/T/.test(iso) && !HAS_ZONE.test(iso) ? `${iso}Z` : iso);
}

/** Today's calendar date (YYYY-MM-DD) in `tz`, whatever the process time zone is. */
export function todayIn(tz: string, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Calendar-day arithmetic on a YYYY-MM-DD string (UTC math, so DST never shifts the result). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** UTC offset in minutes (east positive) that `tz` has at the instant `utcMs`. */
export function offsetMinutesAt(utcMs: number, tz: string): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(new Date(utcMs)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = /^GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?$/.exec(name);
  if (!m || m[1] === undefined) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/** `YYYY-MM-DDTHH:mm:ss±HH:mm` for the instant `iso` as seen in `tz`. Invalid input (or a bare date) is returned unchanged. */
export function formatOffsetDateTime(iso: string, tz: string): string {
  if (DATE_ONLY.test(iso)) return iso;
  const ms = parseInstant(iso);
  if (Number.isNaN(ms)) return iso;
  const offset = offsetMinutesAt(ms, tz);
  return `${new Date(ms + offset * MINUTE_MS).toISOString().slice(0, 19)}${formatOffset(offset)}`;
}

/** e.g. `Mon Oct 12, 6:30 PM EDT`; an all-day `YYYY-MM-DD` gives `Mon Oct 12`. Invalid input is returned unchanged. */
export function formatHuman(iso: string, tz: string): string {
  const allDay = DATE_ONLY.test(iso);
  const ms = parseInstant(allDay ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(ms)) return iso;
  const parts = new Intl.DateTimeFormat("en-US", allDay
    ? { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }
    : { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${get("weekday")} ${get("month")} ${get("day")}`;
  return allDay ? date : `${date}, ${get("hour")}:${get("minute")} ${get("dayPeriod")} ${get("timeZoneName")}`;
}

/** The clock part of formatHuman, e.g. `6:30 PM EDT`. Invalid input is returned unchanged. */
export function formatHumanTime(iso: string, tz: string): string {
  const human = formatHuman(iso, tz);
  const at = human.indexOf(", ");
  return at === -1 || DATE_ONLY.test(iso) ? human : human.slice(at + 2);
}

/** Zone name as people say it: Eastern time for the default zone, else the IANA name. */
export const zoneLabel = (tz: string): string => (tz === DEFAULT_TIMEZONE ? `Eastern time (${tz})` : tz);

/**
 * Turn a person's datetime into one with an explicit offset. `YYYY-MM-DDTHH:mm(:ss)?` is wall-clock time in `tz`; with `Z` or `±HH:mm`
 * the offset is kept. Throws ValidationError(field) for anything else.
 */
export function toOffsetDateTime(value: string, tz: string, field: string): string {
  const guidance = `use YYYY-MM-DDTHH:mm, read as ${tz} time, or add an explicit offset`;
  const m = typeof value === "string" ? INPUT.exec(value) : null;
  if (!m) throw new ValidationError(field, guidance);
  const [year, month, day, hour, minute] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  const real = new Date(naive);
  if (real.getUTCFullYear() !== year || real.getUTCMonth() !== month - 1 || real.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) {
    throw new ValidationError(field, `is not a real date and time; ${guidance}`);
  }
  const clock = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${pad(second)}${m[7] ?? ""}`;
  const explicit = m[8];
  if (explicit !== undefined) {
    if (explicit !== "Z" && (Number(explicit.slice(1, 3)) > 23 || Number(explicit.slice(4, 6)) > 59)) throw new ValidationError(field, `has an invalid UTC offset; ${guidance}`);
    return `${clock}${explicit}`;
  }
  // Wall clock in tz. Candidate offsets are those in force around the date; an offset is valid when it still holds at the instant it implies.
  // Two valid offsets mean the hour repeats (clocks fall back): take the earlier instant, the first (daylight) occurrence. None means a gap.
  const candidates = new Set([-36, 0, 36].map((h) => offsetMinutesAt(naive + h * 60 * MINUTE_MS, tz)));
  const valid = [...candidates].filter((o) => offsetMinutesAt(naive - o * MINUTE_MS, tz) === o).sort((a, b) => b - a);
  if (valid.length === 0) throw new ValidationError(field, `${m[4]}:${m[5]} does not exist on that date in ${tz} (clocks skip forward); pick another time`);
  return `${clock}${formatOffset(valid[0]!)}`;
}
