import type { Runtime } from "../runtime.js";
import { AuthError } from "../skylight/errors.js";
import { formatHuman, formatOffsetDateTime } from "../skylight/time.js";
import { findCallbackInChromeHistory } from "./chrome-history.js";
import { buildAuthorizeUrl, createPendingLogin, exchangeCode, parseCallbackUrl, type PkceMethod } from "../skylight/oauth.js";

export async function startLogin(rt: Runtime, opts: { method?: PkceMethod } = {}): Promise<{ url: string }> {
  const pending = createPendingLogin(Date.now(), opts.method ?? "S256");
  await rt.store.writePendingLogin(pending);
  return { url: buildAuthorizeUrl(rt.config.apiBaseUrl, pending) };
}

export async function completeLogin(rt: Runtime, callbackUrl: string): Promise<{ expiresAt: number }> {
  const pending = await rt.store.readPendingLogin();
  if (pending === null) throw new AuthError("No login in progress. Run `skylight-mcp login` first.");
  const { code } = parseCallbackUrl(callbackUrl, pending);
  const credential = await exchangeCode({ fetch: rt.fetch, apiBaseUrl: rt.config.apiBaseUrl, code, pending, timeoutMs: rt.config.requestTimeoutMs });
  await rt.store.write(credential);
  await rt.store.deletePendingLogin();
  return { expiresAt: credential.expiresAt };
}

export const NO_CHROME_CALLBACK_MESSAGE =
  "No Skylight sign-in found in Chrome's history since this login started. Sign in with the link in Chrome, then press Enter here to check again, or paste the callback address.";

type FindCallback = (o: { since: number }) => Promise<string | null>;

/**
 * Finish a pending login using the callback URL recovered from Chrome's history.
 * Returns null when Chrome's history has no sign-in yet (the pending login is kept so the caller can retry).
 */
export async function tryCompleteLoginFromChrome(rt: Runtime, find: FindCallback = findCallbackInChromeHistory): Promise<{ expiresAt: number } | null> {
  const pending = await rt.store.readPendingLogin();
  if (pending === null) throw new AuthError("No login in progress. Run `skylight-mcp login` first.");
  const callback = await find({ since: pending.createdAt });
  if (callback === null) return null;
  return completeLogin(rt, callback);
}

/** Non-interactive variant: throws when Chrome's history has no sign-in. */
export async function completeLoginFromChrome(rt: Runtime, find: FindCallback = findCallbackInChromeHistory): Promise<{ expiresAt: number }> {
  const result = await tryCompleteLoginFromChrome(rt, find);
  if (result === null) throw new AuthError(NO_CHROME_CALLBACK_MESSAGE);
  return result;
}

export function logout(rt: Runtime): Promise<boolean> {
  return rt.store.delete();
}

export interface StatusReport {
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
}

const NO_EXPIRY = { tokenExpiresAtLocal: null, tokenExpiresWhen: null } as const;

export async function status(rt: Runtime): Promise<StatusReport> {
  const apiHost = new URL(rt.config.apiBaseUrl).host;
  let cred;
  try {
    cred = await rt.store.read();
  } catch (e) {
    return { loggedIn: false, needsLogin: true, apiHost, tokenExpiresAt: null, ...NO_EXPIRY, timezone: rt.config.timezone, frameId: null, frameError: null, credentialError: e instanceof Error ? e.message : String(e) };
  }
  if (cred === null) return { loggedIn: false, needsLogin: true, apiHost, tokenExpiresAt: null, ...NO_EXPIRY, timezone: rt.config.timezone, frameId: null, frameError: null, credentialError: null };
  let frameId: string | null = null;
  let frameError: string | null = null;
  let needsLogin = false;
  try {
    frameId = await rt.frames.resolve();
  } catch (e) {
    frameError = e instanceof Error ? e.message : String(e);
    needsLogin = e instanceof AuthError && /expired or was revoked|Not logged in|rejected the credentials/.test(e.message);
  }
  const iso = new Date(cred.expiresAt).toISOString();
  return { loggedIn: true, needsLogin, apiHost, tokenExpiresAt: iso, tokenExpiresAtLocal: formatOffsetDateTime(iso, rt.config.timezone), tokenExpiresWhen: formatHuman(iso, rt.config.timezone), timezone: rt.config.timezone, frameId, frameError, credentialError: null };
}
