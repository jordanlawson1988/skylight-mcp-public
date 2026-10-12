import type { Runtime } from "../runtime.js";
import { AuthError } from "../skylight/errors.js";
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
  "No Skylight sign-in found in Chrome's history since this login started. Sign in with the link above in Chrome, then run `skylight-mcp login` again and press Enter \u2014 or paste the callback address with `skylight-mcp login --complete <url>`.";

/** Finish a pending login using the callback URL recovered from Chrome's history (Enter at the prompt). */
export async function completeLoginFromChrome(
  rt: Runtime,
  find: (o: { since: number }) => Promise<string | null> = findCallbackInChromeHistory,
): Promise<{ expiresAt: number }> {
  const pending = await rt.store.readPendingLogin();
  if (pending === null) throw new AuthError("No login in progress. Run `skylight-mcp login` first.");
  const callback = await find({ since: pending.createdAt });
  if (callback === null) throw new AuthError(NO_CHROME_CALLBACK_MESSAGE);
  return completeLogin(rt, callback);
}

export function logout(rt: Runtime): Promise<boolean> {
  return rt.store.delete();
}

export interface StatusReport {
  loggedIn: boolean;
  needsLogin: boolean;
  apiHost: string;
  tokenExpiresAt: string | null;
  frameId: string | null;
  frameError: string | null;
  credentialError: string | null;
}

export async function status(rt: Runtime): Promise<StatusReport> {
  const apiHost = new URL(rt.config.apiBaseUrl).host;
  let cred;
  try {
    cred = await rt.store.read();
  } catch (e) {
    return { loggedIn: false, needsLogin: true, apiHost, tokenExpiresAt: null, frameId: null, frameError: null, credentialError: e instanceof Error ? e.message : String(e) };
  }
  if (cred === null) return { loggedIn: false, needsLogin: true, apiHost, tokenExpiresAt: null, frameId: null, frameError: null, credentialError: null };
  let frameId: string | null = null;
  let frameError: string | null = null;
  let needsLogin = false;
  try {
    frameId = await rt.frames.resolve();
  } catch (e) {
    frameError = e instanceof Error ? e.message : String(e);
    needsLogin = e instanceof AuthError && /expired or was revoked|Not logged in|rejected the credentials/.test(e.message);
  }
  return { loggedIn: true, needsLogin, apiHost, tokenExpiresAt: new Date(cred.expiresAt).toISOString(), frameId, frameError, credentialError: null };
}
