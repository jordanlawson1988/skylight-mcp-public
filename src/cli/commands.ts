import type { Runtime } from "../runtime.js";
import { AuthError } from "../skylight/errors.js";
import { buildAuthStatus, LOGIN_HINTS, type AuthStatusReport } from "../skylight/status.js";
import { findCallbackInChromeHistory } from "./chrome-history.js";
import { buildAuthorizeUrl, createPendingLogin, exchangeCode, parseCallbackUrl, type OAuthCredential, type PkceMethod } from "../skylight/oauth.js";

export async function startLogin(rt: Runtime, opts: { method?: PkceMethod } = {}): Promise<{ url: string }> {
  const pending = createPendingLogin(Date.now(), opts.method ?? "S256");
  await rt.store.writePendingLogin(pending);
  return { url: await buildAuthorizeUrl(rt.config.apiBaseUrl, pending) };
}

/**
 * Exchanges the pending login's callback for a credential and clears the pending login, without storing the credential.
 * `skylight-mcp login` stores it on this Mac; `skylight-mcp remote login` sends it to the shared server instead.
 */
export async function exchangeLogin(rt: Runtime, callbackUrl: string): Promise<OAuthCredential> {
  const pending = await rt.store.readPendingLogin();
  if (pending === null) throw new AuthError("No login in progress. Run `skylight-mcp login` first.");
  const { code } = parseCallbackUrl(callbackUrl, pending);
  const credential = await exchangeCode({ fetch: rt.fetch, apiBaseUrl: rt.config.apiBaseUrl, code, pending, timeoutMs: rt.config.requestTimeoutMs });
  await rt.store.deletePendingLogin();
  return credential;
}

/** How a login finishes once its callback address is known. */
export type CompleteLogin = (rt: Runtime, callbackUrl: string) => Promise<{ expiresAt: number }>;

/** Finishes a login on this Mac: the credential goes to the local encrypted store. */
export const completeLogin: CompleteLogin = async (rt, callbackUrl) => {
  const credential = await exchangeLogin(rt, callbackUrl);
  await rt.store.write(credential);
  return { expiresAt: credential.expiresAt };
};

export const NO_CHROME_CALLBACK_MESSAGE =
  "No Skylight sign-in found in Chrome's history since this login started. Sign in with the link in Chrome, then press Enter here to check again, or paste the callback address.";

type FindCallback = (o: { since: number }) => Promise<string | null>;

/**
 * Finish a pending login using the callback URL recovered from Chrome's history.
 * Returns null when Chrome's history has no sign-in yet (the pending login is kept so the caller can retry).
 */
export async function tryCompleteLoginFromChrome(rt: Runtime, find: FindCallback = findCallbackInChromeHistory, complete: CompleteLogin = completeLogin): Promise<{ expiresAt: number } | null> {
  const pending = await rt.store.readPendingLogin();
  if (pending === null) throw new AuthError("No login in progress. Run `skylight-mcp login` first.");
  const callback = await find({ since: pending.createdAt });
  if (callback === null) return null;
  return complete(rt, callback);
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

export type StatusReport = AuthStatusReport;

/** This Mac's login status: the local credential file, then the frame it resolves to. */
export async function status(rt: Runtime): Promise<StatusReport> {
  let credential: { expiresAt: number } | null | { error: string };
  try {
    const c = await rt.store.read();
    credential = c === null ? null : { expiresAt: c.expiresAt };
  } catch (e) {
    credential = { error: e instanceof Error ? e.message : String(e) };
  }
  return buildAuthStatus({ config: rt.config, frames: rt.frames, credential, loginHint: LOGIN_HINTS.stdio });
}
