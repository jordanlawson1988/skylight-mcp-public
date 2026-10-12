// Pure time helpers. Skylight keeps UTC on the wire; everything a person reads or types goes through these in the configured zone.
import { ValidationError } from "./errors.js";

export const DEFAULT_TIMEZONE = "America/New_York";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;
const MINUTE_MS = 60_000;

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
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  const offset = offsetMinutesAt(ms, tz);
  return `${new Date(ms + offset * MINUTE_MS).toISOString().slice(0, 19)}${formatOffset(offset)}`;
}

/** e.g. `Mon Oct 12, 6:30 PM EDT`; an all-day `YYYY-MM-DD` gives `Mon Oct 12`. Invalid input is returned unchanged. */
export function formatHuman(iso: string, tz: string): string {
  const allDay = DATE_ONLY.test(iso);
  const ms = Date.parse(allDay ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(ms)) return iso;
  const parts = new Intl.DateTimeFormat("en-US", allDay
    ? { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }
    : { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).formatToParts(new Date(ms));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const date = `${get("weekday")} ${get("month")} ${get("day")}`;
  return allDay ? date : `${date}, ${get("hour")}:${get("minute")} ${get("dayPeriod")} ${get("timeZoneName")}`;
}

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
  // Wall clock in tz: try the offset at the naive instant, then re-check once at the instant that offset implies (settles DST switch days).
  const first = offsetMinutesAt(naive, tz);
  const second2 = offsetMinutesAt(naive - first * MINUTE_MS, tz);
  return `${clock}${formatOffset(second2)}`;
}
