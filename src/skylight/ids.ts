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

export function localDateString(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
