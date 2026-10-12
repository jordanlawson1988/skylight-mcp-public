import type { Runtime } from "../runtime.js";
import { AuthError } from "../skylight/errors.js";
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

export function logout(rt: Runtime): Promise<boolean> {
  return rt.store.delete();
}

export interface StatusReport {
  loggedIn: boolean;
  apiHost: string;
  tokenExpiresAt: string | null;
  frameId: string | null;
  frameError: string | null;
}

export async function status(rt: Runtime): Promise<StatusReport> {
  const apiHost = new URL(rt.config.apiBaseUrl).host;
  const cred = await rt.store.read().catch(() => null);
  if (cred === null) return { loggedIn: false, apiHost, tokenExpiresAt: null, frameId: null, frameError: null };
  let frameId: string | null = null;
  let frameError: string | null = null;
  try { frameId = await rt.frames.resolve(); } catch (e) { frameError = e instanceof Error ? e.message : String(e); }
  return { loggedIn: true, apiHost, tokenExpiresAt: new Date(cred.expiresAt).toISOString(), frameId, frameError };
}
