import { ValidationError } from "./errors.js";
import { assertDate } from "./ids.js";

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface Recurrence {
  frequency: Frequency;
  interval?: number;
  weekdays?: Weekday[];
  monthDay?: number;
  until?: string;
}

export function buildRrule(r: Recurrence): string {
  if (!FREQUENCIES.includes(r.frequency)) throw new ValidationError("recurrence.frequency", "must be daily, weekly or monthly");
  const parts = [`FREQ=${r.frequency.toUpperCase()}`];
  if (r.interval !== undefined) {
    if (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 52) throw new ValidationError("recurrence.interval", "must be an integer 1-52");
    if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  }
  if (r.weekdays !== undefined) {
    if (r.frequency !== "weekly") throw new ValidationError("recurrence.weekdays", "only allowed with weekly frequency");
    if (r.weekdays.length === 0) throw new ValidationError("recurrence.weekdays", "must list at least one weekday");
    if (new Set(r.weekdays).size !== r.weekdays.length) throw new ValidationError("recurrence.weekdays", "must not repeat");
    for (const d of r.weekdays) if (!WEEKDAYS.includes(d)) throw new ValidationError("recurrence.weekdays", `unknown weekday ${String(d)}`);
    parts.push(`BYDAY=${r.weekdays.join(",")}`);
  }
  if (r.monthDay !== undefined) {
    if (r.frequency !== "monthly") throw new ValidationError("recurrence.monthDay", "only allowed with monthly frequency");
    if (!Number.isInteger(r.monthDay) || r.monthDay < 1 || r.monthDay > 31) throw new ValidationError("recurrence.monthDay", "must be 1-31");
    parts.push(`BYMONTHDAY=${r.monthDay}`);
  }
  if (r.until !== undefined) {
    assertDate(r.until, "recurrence.until");
    parts.push(`UNTIL=${r.until.replaceAll("-", "")}`);
  }
  return `RRULE:${parts.join(";")}`;
}
