import type { SkylightConfig } from "./config.js";
import { AuthError } from "./errors.js";
import type { FrameResolver } from "./frame.js";
import { DEFAULT_LOGIN_COMMAND, REMOTE_LOGIN_COMMAND } from "./oauth.js";
import { formatHuman, formatOffsetDateTime } from "./time.js";

/** What skylight_auth_status reports. Never contains a token. */
export interface AuthStatusReport {
  loggedIn: boolean;
  needsLogin: boolean;
  apiHost: string;
  /** Token expiry in UTC (ISO). */
  tokenExpiresAt: string | null;
  /** The same instant in the configured zone, with an explicit offset. */
  tokenExpiresAtLocal: string | null;
  /** The same instant in plain words, e.g. "Tue Oct 13, 2:05 PM EDT". */
  tokenExpiresWhen: string | null;
  timezone: string;
  frameId: string | null;
  frameError: string | null;
  credentialError: string | null;
  /** Who signs in again, and how, when needsLogin is true. */
  loginHint: string;
}

/** The sign-in instruction for each way the tools run. */
export const LOGIN_HINTS = {
  stdio: `run \`${DEFAULT_LOGIN_COMMAND}\` in a terminal on the Mac`,
  remote: `The server owner needs to run \`${REMOTE_LOGIN_COMMAND}\``,
} as const;

/** Frame errors that mean the credential itself is dead (so a new sign-in is the fix). */
const SESSION_DEAD = /expired or was revoked|Not logged in|rejected the credentials|sign-in for the shared server expired|not signed in to Skylight/;

/**
 * Builds the status report from whatever holds the credential: the Mac's encrypted file or the shared server's
 * Durable Object. `credential` is the stored expiry (null when signed out) or the reason it cannot be read.
 */
export async function buildAuthStatus(opts: {
  config: Pick<SkylightConfig, "apiBaseUrl" | "timezone">;
  frames: FrameResolver;
  credential: { expiresAt: number } | null | { error: string };
  loginHint: string;
  /** Already known to need a new sign-in (the shared server records a refused refresh). */
  needsLogin?: boolean;
}): Promise<AuthStatusReport> {
  const { config, loginHint } = opts;
  const apiHost = new URL(config.apiBaseUrl).host;
  const signedOut = (credentialError: string | null): AuthStatusReport => ({
    loggedIn: false, needsLogin: true, apiHost, tokenExpiresAt: null, tokenExpiresAtLocal: null, tokenExpiresWhen: null,
    timezone: config.timezone, frameId: null, frameError: null, credentialError, loginHint,
  });
  if (opts.credential === null) return signedOut(null);
  if ("error" in opts.credential) return signedOut(opts.credential.error);
  let frameId: string | null = null;
  let frameError: string | null = null;
  let needsLogin = opts.needsLogin === true;
  try {
    frameId = await opts.frames.resolve();
  } catch (e) {
    frameError = e instanceof Error ? e.message : String(e);
    if (e instanceof AuthError && SESSION_DEAD.test(e.message)) needsLogin = true;
  }
  const iso = new Date(opts.credential.expiresAt).toISOString();
  return {
    loggedIn: true, needsLogin, apiHost, tokenExpiresAt: iso, tokenExpiresAtLocal: formatOffsetDateTime(iso, config.timezone),
    tokenExpiresWhen: formatHuman(iso, config.timezone), timezone: config.timezone, frameId, frameError, credentialError: null, loginHint,
  };
}
