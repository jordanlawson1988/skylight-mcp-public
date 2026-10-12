import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { AuthError } from "./errors.js";

export const CLIENT_ID = "skylight-mobile";
export const REDIRECT_URI = "https://ourskylight.com/welcome";
export const SCOPE = "everything";
export const PENDING_LOGIN_TTL_MS = 600_000;
const MAX_EXCERPT = 500;

export type PkceMethod = "S256" | "plain";

export interface PendingLogin {
  state: string;
  verifier: string;
  fingerprint: string;
  createdAt: number;
  method: PkceMethod;
}

export interface OAuthCredential {
  version: 1;
  accessToken: string;
  refreshToken: string;
  fingerprint: string;
  expiresAt: number;
}

function deviceValues(fingerprint: string): Record<string, string> {
  return {
    skylight_api_client_device_fingerprint: fingerprint,
    skylight_api_client_device_platform: "web",
    skylight_api_client_device_name: "unknown",
    skylight_api_client_device_os_version: "10.15.7",
    skylight_api_client_device_app_version: "unknown",
    skylight_api_client_device_hardware: "Macintosh",
    source: "js-mobile",
  };
}

export function createPendingLogin(now: number = Date.now(), method: PkceMethod = "S256"): PendingLogin {
  return {
    state: randomBytes(32).toString("base64url"),
    verifier: randomBytes(48).toString("base64url"),
    fingerprint: randomUUID(),
    createdAt: now,
    method,
  };
}

export function pkceChallenge(verifier: string, method: PkceMethod): string {
  return method === "plain" ? verifier : createHash("sha256").update(verifier).digest("base64url");
}

export function buildAuthorizeUrl(apiBaseUrl: string, pending: PendingLogin): string {
  const url = new URL("/oauth/authorize", apiBaseUrl);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state: pending.state,
    code_challenge: pkceChallenge(pending.verifier, pending.method),
    code_challenge_method: pending.method,
    skylight_api_client_device_fingerprint: pending.fingerprint,
  }).toString();
  return url.toString();
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function parseCallbackUrl(callbackUrl: string, pending: PendingLogin, now: number = Date.now()): { code: string } {
  if (now - pending.createdAt > PENDING_LOGIN_TTL_MS) {
    throw new AuthError("The login attempt expired. Run `skylight-mcp login` again.");
  }
  let url: URL;
  try {
    url = new URL(callbackUrl.trim());
  } catch {
    throw new AuthError("Paste the complete https://ourskylight.com/welcome?code=... address.");
  }
  if (
    url.protocol !== "https:" || url.hostname !== "ourskylight.com" || url.pathname !== "/welcome" ||
    url.username !== "" || url.password !== "" || url.port !== ""
  ) {
    throw new AuthError("Callback URL must begin with https://ourskylight.com/welcome.");
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new AuthError("Callback URL is missing code or state.");
  if (!safeEqual(state, pending.state)) {
    throw new AuthError("Callback state does not match this login attempt. Run `skylight-mcp login` again.");
  }
  if (!/^[A-Za-z0-9._~-]{1,512}$/.test(code)) throw new AuthError("Callback code has an unexpected format.");
  return { code };
}

const TOKEN_VALUE = /("(?:access_token|refresh_token)"\s*:\s*)"(?:[^"\\]|\\.)*"/g;

function excerpt(text: string, secrets: readonly string[] = []): string {
  let out = text.replace(TOKEN_VALUE, '$1"[redacted]"');
  for (const secret of secrets) {
    if (!secret) continue;
    for (const variant of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
      out = out.split(variant).join("[redacted]");
    }
  }
  const clean = out.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim();
  return clean.length > MAX_EXCERPT ? `${clean.slice(0, MAX_EXCERPT - 1)}…` : clean;
}

function toCredential(json: unknown, fingerprint: string, fallbackRefreshToken?: string): OAuthCredential {
  const r = (json ?? {}) as Record<string, unknown>;
  if (typeof r.access_token !== "string" || r.access_token.length === 0) throw new AuthError("Skylight token response had no access token.");
  let refreshToken: string;
  if (typeof r.refresh_token === "string" && r.refresh_token.length > 0) refreshToken = r.refresh_token;
  else if (r.refresh_token === undefined && fallbackRefreshToken) refreshToken = fallbackRefreshToken;
  else throw new AuthError("Skylight token response had no refresh token.");
  if (typeof r.expires_in !== "number" || !Number.isFinite(r.expires_in) || !(r.expires_in > 0)) throw new AuthError("Skylight token response had no valid expiry.");
  return {
    version: 1,
    accessToken: r.access_token,
    refreshToken,
    fingerprint,
    expiresAt: Date.now() + Math.floor(r.expires_in * 1000),
  };
}

async function tokenRequest(opts: {
  fetch: typeof globalThis.fetch; apiBaseUrl: string; form: URLSearchParams; fingerprint: string; timeoutMs: number; what: string;
  secrets: readonly string[]; fallbackRefreshToken?: string;
}): Promise<OAuthCredential> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await opts.fetch(new URL("/oauth/token", opts.apiBaseUrl).toString(), {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: opts.form,
      redirect: "error",
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new AuthError(`Skylight ${opts.what} failed (${res.status}): ${excerpt(text, opts.secrets)}`);
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new AuthError(`Skylight ${opts.what} returned invalid JSON.`); }
    return toCredential(json, opts.fingerprint, opts.fallbackRefreshToken);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    if (controller.signal.aborted) throw new AuthError(`Skylight ${opts.what} timed out.`);
    throw new AuthError(`Skylight ${opts.what} failed: ${excerpt(e instanceof Error ? e.message : String(e), opts.secrets)}`);
  } finally {
    clearTimeout(timer);
  }
}

export function exchangeCode(opts: {
  fetch: typeof globalThis.fetch; apiBaseUrl: string; code: string; pending: PendingLogin; timeoutMs: number;
}): Promise<OAuthCredential> {
  return tokenRequest({
    fetch: opts.fetch, apiBaseUrl: opts.apiBaseUrl, timeoutMs: opts.timeoutMs, fingerprint: opts.pending.fingerprint, what: "login",
    secrets: [opts.code, opts.pending.verifier, opts.pending.state],
    form: new URLSearchParams({
      grant_type: "authorization_code",
      code: opts.code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPE,
      code_verifier: opts.pending.verifier,
      ...deviceValues(opts.pending.fingerprint),
    }),
  });
}

export function refreshCredential(opts: {
  fetch: typeof globalThis.fetch; apiBaseUrl: string; credential: OAuthCredential; timeoutMs: number;
}): Promise<OAuthCredential> {
  return tokenRequest({
    fetch: opts.fetch, apiBaseUrl: opts.apiBaseUrl, timeoutMs: opts.timeoutMs, fingerprint: opts.credential.fingerprint, what: "token refresh",
    secrets: [opts.credential.refreshToken, opts.credential.accessToken],
    fallbackRefreshToken: opts.credential.refreshToken,
    form: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: opts.credential.refreshToken,
      client_id: CLIENT_ID,
      ...deviceValues(opts.credential.fingerprint),
    }),
  });
}
