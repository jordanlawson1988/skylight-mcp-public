import { homedir } from "node:os";
import path from "node:path";
import { ValidationError } from "./errors.js";
import { assertId } from "./ids.js";
import { DEFAULT_TIMEZONE, isValidTimezone } from "./time.js";

export interface SkylightConfig {
  apiBaseUrl: string;
  apiVersion: string;
  requestTimeoutMs: number;
  credentialsDir: string;
  frameId: string | null;
  /** IANA zone every timestamp is presented in and bare datetimes are read in. */
  timezone: string;
  /** True when SKYLIGHT_TIMEZONE was set (so doctor puts it in the Claude Desktop config). */
  timezoneExplicit: boolean;
}

export const DEFAULT_API_BASE = "https://app.ourskylight.com";
export const DEFAULT_API_VERSION = "2026-05-01";

function normalizeBase(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new ValidationError("SKYLIGHT_API_BASE", "must be an absolute URL"); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ValidationError("SKYLIGHT_API_BASE", "must use https (http only for loopback)");
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new ValidationError("SKYLIGHT_API_BASE", "must be an origin only");
  }
  return url.origin;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SkylightConfig {
  const apiBaseUrl = env.SKYLIGHT_API_BASE ? normalizeBase(env.SKYLIGHT_API_BASE) : DEFAULT_API_BASE;
  const timeoutRaw = env.SKYLIGHT_REQUEST_TIMEOUT_MS;
  let requestTimeoutMs = 30000;
  if (timeoutRaw !== undefined) {
    if (!/^\d{1,7}$/.test(timeoutRaw) || Number(timeoutRaw) === 0) throw new ValidationError("SKYLIGHT_REQUEST_TIMEOUT_MS", "must be a positive integer");
    requestTimeoutMs = Number(timeoutRaw);
  }
  const frameId = env.SKYLIGHT_FRAME_ID ? assertId(env.SKYLIGHT_FRAME_ID.trim(), "SKYLIGHT_FRAME_ID") : null;
  const credentialsDir = env.SKYLIGHT_CREDENTIALS_DIR?.trim()
    || path.join(homedir(), "Library", "Application Support", "skylight-mcp", "credentials");
  const tzRaw = env.SKYLIGHT_TIMEZONE?.trim();
  if (tzRaw && !isValidTimezone(tzRaw)) throw new ValidationError("SKYLIGHT_TIMEZONE", "must be an IANA timezone such as America/New_York");
  const timezone = tzRaw || DEFAULT_TIMEZONE;
  return { apiBaseUrl, apiVersion: DEFAULT_API_VERSION, requestTimeoutMs, credentialsDir, frameId, timezone, timezoneExplicit: Boolean(tzRaw) };
}
