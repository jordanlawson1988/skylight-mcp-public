import { bytesEqual, bytesToBase64Url, randomBytes, sha256, utf8 } from "./encoding.js";
import { AuthError } from "./errors.js";
import { excerpt } from "./redact.js";

export const CLIENT_ID = "skylight-mobile";
export const REDIRECT_URI = "https://ourskylight.com/welcome";
export const SCOPE = "everything";
export const PENDING_LOGIN_TTL_MS = 600_000;
/** The command that signs this machine in again; the shared server passes `skylight-mcp remote login`. */
export const DEFAULT_LOGIN_COMMAND = "skylight-mcp login";
/**
 * How long a token refresh may take, separate from SKYLIGHT_REQUEST_TIMEOUT_MS: Skylight rotates the refresh token, so
 * abandoning a refresh it already answered would lose the new token and with it the sign-in. Generous on purpose.
 */
export const REFRESH_TIMEOUT_MS = 30_000;

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
    state: bytesToBase64Url(randomBytes(32)),
    verifier: bytesToBase64Url(randomBytes(48)),
    fingerprint: crypto.randomUUID(),
    createdAt: now,
    method,
  };
}

export async function pkceChallenge(verifier: string, method: PkceMethod): Promise<string> {
  return method === "plain" ? verifier : bytesToBase64Url(await sha256(verifier));
}

export async function buildAuthorizeUrl(apiBaseUrl: string, pending: PendingLogin): Promise<string> {
  const url = new URL("/oauth/authorize", apiBaseUrl);
  url.search = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    state: pending.state,
    code_challenge: await pkceChallenge(pending.verifier, pending.method),
    code_challenge_method: pending.method,
    skylight_api_client_device_fingerprint: pending.fingerprint,
  }).toString();
  return url.toString();
}

function safeEqual(a: string, b: string): boolean {
  return bytesEqual(utf8(a), utf8(b));
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
  secrets: readonly string[]; fallbackRefreshToken?: string; loginCommand?: string;
}): Promise<OAuthCredential> {
  const login = opts.loginCommand ?? DEFAULT_LOGIN_COMMAND;
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
    if (!res.ok) {
      if (opts.what === "token refresh") {
        if (res.status === 400 || res.status === 401) throw new AuthError(`Your Skylight session expired or was revoked. Run \`${login}\` again.`, "session_expired");
        const body = excerpt(text, opts.secrets).replace(/\.+$/, "");
        throw new AuthError(`Skylight ${opts.what} failed (${res.status})${body ? `: ${body}` : ""}. Run \`${login}\` if this persists.`);
      }
      throw new AuthError(`Skylight ${opts.what} failed (${res.status}): ${excerpt(text, opts.secrets)}`);
    }
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
  /** Named in the error text when the refresh fails; defaults to `skylight-mcp login`. */
  loginCommand?: string;
}): Promise<OAuthCredential> {
  return tokenRequest({
    fetch: opts.fetch, apiBaseUrl: opts.apiBaseUrl, timeoutMs: opts.timeoutMs, fingerprint: opts.credential.fingerprint, what: "token refresh",
    secrets: [opts.credential.refreshToken, opts.credential.accessToken],
    fallbackRefreshToken: opts.credential.refreshToken,
    ...(opts.loginCommand ? { loginCommand: opts.loginCommand } : {}),
    form: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: opts.credential.refreshToken,
      client_id: CLIENT_ID,
      ...deviceValues(opts.credential.fingerprint),
    }),
  });
}
