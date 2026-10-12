import { base64ToBytes, bytesToBase64Url, randomBytes } from "../skylight/encoding.js";
import { pkceChallenge } from "../skylight/oauth.js";
import { MCP_SCOPE, type RemoteEnv } from "./env.js";

/**
 * Family sign-in: the MCP client (Claude, ChatGPT) sends the user to /authorize; they approve this app, sign in with
 * Google, and come back to /callback, where only verified, allowlisted Google accounts get an MCP grant.
 *
 * The consent handle and the Google `state` come from @cloudflare/workers-oauth-provider's consent and upstream helpers
 * (beginConsent/approveConsent/beginUpstream/finishUpstream): single-use, ten minutes, encrypted in OAUTH_KV and bound to
 * the browser by a __Host- cookie. This module only declares the structural subset of the library it uses, so it stays
 * testable under Node (the library itself imports cloudflare:workers).
 */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_ISSUERS: readonly string[] = ["https://accounts.google.com", "accounts.google.com"];
export const GOOGLE_SCOPES = "openid email profile";
export const FAMILY_LIST_MESSAGE = "This Google account is not on the family list.";
const GOOGLE_TIMEOUT_MS = 8000;

// ---- the library surface we use (structurally compatible with its OAuthHelpers) ----

export interface AuthRequest {
  responseType: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  resource?: string;
  issuer?: string;
}

export interface ClientInfo {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: string;
}

export interface GrantSummary { id: string; clientId: string; userId: string; scope: string[]; metadata: unknown; createdAt: number }

export interface OAuthApi {
  parseAuthRequest(request: Request): Promise<AuthRequest>;
  lookupClient(clientId: string): Promise<ClientInfo | null>;
  beginConsent(authRequest: AuthRequest): Promise<{ handle: string; headers: Headers }>;
  approveConsent(request: Request, handle: string, options?: { scope?: string[] }): Promise<{ request: AuthRequest; headers: Headers }>;
  denyConsent(request: Request, handle: string, options?: { description?: string }): Promise<{ request: AuthRequest; redirectTo: string; headers: Headers }>;
  beginUpstream(authRequest: AuthRequest, options?: { data?: unknown; headers?: Headers }): Promise<{ state: string; headers: Headers }>;
  finishUpstream<Data = unknown>(request: Request): Promise<{ request: AuthRequest; data: Data; headers: Headers }>;
  completeAuthorization(options: { request: AuthRequest; userId: string; metadata: unknown; scope: string[]; props: unknown }): Promise<{ redirectTo: string }>;
  listUserGrants(userId: string, options?: { limit?: number; cursor?: string }): Promise<{ items: GrantSummary[]; cursor?: string }>;
  revokeGrant(grantId: string, userId: string): Promise<void>;
}

/** What /callback stores in ctx.props for the MCP handler: the signed-in family member. */
export interface FamilyProps { email: string; name: string }

interface AuthorizationErrorLike { name: "AuthorizationError"; code: string; description: string; redirectUri?: string; state?: string; issuer?: string }

function isAuthorizationError(e: unknown): e is AuthorizationErrorLike {
  return e instanceof Error && e.name === "AuthorizationError" && typeof (e as unknown as { description?: unknown }).description === "string";
}

function isCimdFetchError(e: unknown): boolean {
  return e instanceof Error && e.name === "CimdFetchError";
}

// ---- pure helpers ----

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

/** ALLOWED_EMAILS: comma-separated, trimmed, lower-cased, de-duplicated. An empty or malformed list is a setup error. */
export function parseAllowlist(secret: string | undefined): string[] {
  const emails = [...new Set((secret ?? "").split(",").map((e) => e.trim().toLowerCase()).filter((e) => e !== ""))];
  if (emails.length === 0) throw new Error("ALLOWED_EMAILS must list at least one email.");
  const bad = emails.filter((e) => !EMAIL.test(e));
  if (bad.length > 0) throw new Error("ALLOWED_EMAILS must be a comma-separated list of email addresses.");
  return emails;
}

export function isAllowed(email: string, emailVerified: boolean, allowlist: readonly string[]): boolean {
  if (!emailVerified || typeof email !== "string" || email === "") return false;
  return allowlist.includes(email.trim().toLowerCase());
}

export function buildGoogleAuthUrl(o: { clientId: string; redirectUri: string; state: string; codeChallenge: string; nonce?: string }): string {
  const url = new URL(GOOGLE_AUTH_URL);
  const params: Record<string, string> = {
    client_id: o.clientId, redirect_uri: o.redirectUri, response_type: "code", scope: GOOGLE_SCOPES, state: o.state,
    code_challenge: o.codeChallenge, code_challenge_method: "S256", prompt: "select_account",
  };
  if (o.nonce) params.nonce = o.nonce;
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

/** The claims of a JWT, unverified. Only used on an ID token received directly from Google's token endpoint. */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some((p) => p === "")) throw new Error("ID token is not a JWT.");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(base64ToBytes(parts[1]!))); } catch { throw new Error("ID token payload is not JSON."); }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("ID token payload is not an object.");
  return value as Record<string, unknown>;
}

/**
 * Checks the ID token's claims (OpenID Connect Core 3.1.3.7). The signature is not checked: the token came straight
 * from Google's token endpoint over TLS, in exchange for this server's client secret and PKCE verifier, which OIDC
 * allows in place of signature validation. Returns the lower-cased email and a display name.
 */
export function verifyIdTokenClaims(claims: Record<string, unknown>, o: { clientId: string; now: number; nonce?: string }): FamilyProps {
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.includes(claims.iss)) throw new Error("ID token issuer is not Google.");
  const aud = claims.aud;
  const audOk = aud === o.clientId || (Array.isArray(aud) && aud.includes(o.clientId) && claims.azp === o.clientId);
  if (!audOk) throw new Error("ID token audience is not this server.");
  if (typeof claims.exp !== "number" || !(claims.exp * 1000 > o.now)) throw new Error("ID token expired.");
  if (o.nonce !== undefined && claims.nonce !== o.nonce) throw new Error("ID token nonce does not match.");
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new Error("Google email is not verified.");
  if (typeof claims.email !== "string" || !EMAIL.test(claims.email.trim())) throw new Error("ID token has no email.");
  const email = claims.email.trim().toLowerCase();
  const name = typeof claims.name === "string" && claims.name.trim() !== "" ? claims.name.trim().slice(0, 100) : email;
  return { email, name };
}

export async function exchangeGoogleCode(o: {
  fetch: typeof globalThis.fetch; clientId: string; clientSecret: string; code: string; codeVerifier: string; redirectUri: string;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
  try {
    const res = await o.fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: o.code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.redirectUri, code_verifier: o.codeVerifier }),
      redirect: "error",
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Google token exchange failed (${res.status}).`);
    let json: unknown;
    try { json = JSON.parse(text); } catch { throw new Error("Google token exchange returned invalid JSON."); }
    const idToken = (json as Record<string, unknown> | null)?.id_token;
    if (typeof idToken !== "string" || idToken === "") throw new Error("Google token exchange returned no ID token.");
    return idToken;
  } catch (e) {
    if (controller.signal.aborted) throw new Error("Google token exchange timed out.");
    throw e instanceof Error && e.message.startsWith("Google token exchange") ? e : new Error("Google token exchange failed.");
  } finally {
    clearTimeout(timer);
  }
}

// ---- pages ----

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = "body{font:16px/1.5 system-ui,-apple-system,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f;background:#fff}button{font:inherit;padding:.6rem 1.1rem;border-radius:.5rem;border:1px solid #888;background:#fff;cursor:pointer}button.primary{background:#1a73e8;border-color:#1a73e8;color:#fff}.muted{color:#555;font-size:.9rem}@media (prefers-color-scheme:dark){body{background:#111;color:#eee}.muted{color:#aaa}button{background:#222;color:#eee}}";

function shell(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body>${body}</body></html>`;
}

const PAGE_HEADERS = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer" };

/** A plain page with one message (errors, the family-list refusal). */
export function messagePage(status: number, title: string, message: string, extraHeaders?: Headers): Response {
  const headers = new Headers(extraHeaders);
  for (const [k, v] of Object.entries(PAGE_HEADERS)) headers.set(k, v);
  return new Response(shell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`), { status, headers });
}

export function consentPage(o: { clientName: string; clientId: string; redirectUri: string; handle: string }): string {
  const name = escapeHtml(o.clientName);
  let redirectHost = "";
  try { redirectHost = new URL(o.redirectUri).hostname; } catch { redirectHost = o.redirectUri; }
  const local = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/.test(redirectHost);
  let origin: string;
  if (o.clientId.startsWith("https://")) {
    let host = o.clientId;
    try { host = new URL(o.clientId).hostname; } catch { /* keep the raw id */ }
    origin = `Published by <strong>${escapeHtml(host)}</strong>.`;
  } else {
    origin = "This app registered itself; its name is not verified.";
  }
  return shell(`Allow ${o.clientName}?`, `
<h1>Allow ${name} to use the family Skylight?</h1>
<p>This connects to the Lawson family Skylight. ${name} will be able to read and change the family calendar, chores, lists, meals, photos and frame settings, as you.</p>
<p>${origin} Access will be sent to <strong>${escapeHtml(redirectHost)}</strong>.</p>
${local ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>" : ""}
<p class="muted">Next you will choose a Google account. Only accounts on the family list can connect.</p>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(o.handle)}">
<p><button class="primary" type="submit" name="decision" value="approve">Allow and continue with Google</button> <button type="submit" name="decision" value="deny">Cancel</button></p>
</form>`);
}

// ---- handlers ----

export interface GoogleDeps {
  oauth: OAuthApi;
  env: RemoteEnv;
  fetch: typeof globalThis.fetch;
  now: () => number;
}

const NOT_SET_UP = "This server has not finished setting up Google sign-in. Jordan needs to add its Google settings.";
const START_AGAIN = "This sign-in page expired or was already used. Start connecting again from the app.";

function googleSettings(env: RemoteEnv): { clientId: string; clientSecret: string; allowlist: string[] } | null {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return null;
  try { return { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, allowlist: parseAllowlist(env.ALLOWED_EMAILS) }; } catch { return null; }
}

function callbackUrl(request: Request): string {
  return `${new URL(request.url).origin}/callback`;
}

function redirect(location: string, headers?: Headers): Response {
  const h = new Headers(headers);
  h.set("Location", location);
  h.set("Cache-Control", "no-store");
  return new Response(null, { status: 302, headers: h });
}

/** Errors from parseAuthRequest: redirect only when the library has validated the client's redirect URI. */
function authorizeError(e: unknown): Response {
  if (isAuthorizationError(e)) {
    if (e.redirectUri) {
      const to = new URL(e.redirectUri);
      to.searchParams.set("error", e.code);
      to.searchParams.set("error_description", e.description);
      if (e.state) to.searchParams.set("state", e.state);
      if (e.issuer) to.searchParams.set("iss", e.issuer);
      return redirect(to.toString());
    }
    return messagePage(400, "Can't connect", e.description);
  }
  if (isCimdFetchError(e)) return messagePage(400, "Can't connect", "This app could not be verified.");
  throw e;
}

/** GET /authorize shows the consent page; POST /authorize (the page's form) approves or declines it. */
export async function handleAuthorize(request: Request, deps: GoogleDeps): Promise<Response> {
  const settings = googleSettings(deps.env);
  if (request.method === "GET") {
    let authRequest: AuthRequest;
    let client: ClientInfo | null;
    try {
      authRequest = await deps.oauth.parseAuthRequest(request);
      client = await deps.oauth.lookupClient(authRequest.clientId);
    } catch (e) {
      return authorizeError(e);
    }
    if (client === null) return messagePage(400, "Can't connect", "This app is not registered with the family Skylight server.");
    if (settings === null) return messagePage(503, "Not set up yet", NOT_SET_UP);
    const consent = await deps.oauth.beginConsent(authRequest);
    const headers = consent.headers;
    for (const [k, v] of Object.entries(PAGE_HEADERS)) headers.set(k, v);
    const html = consentPage({ clientName: client.clientName ?? client.clientId, clientId: client.clientId, redirectUri: authRequest.redirectUri, handle: consent.handle });
    return new Response(html, { status: 200, headers });
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });

  let form: FormData;
  try { form = await request.formData(); } catch { return messagePage(400, "Can't connect", START_AGAIN); }
  const handle = String(form.get("handle") ?? "");
  try {
    if (form.get("decision") !== "approve") {
      const denied = await deps.oauth.denyConsent(request, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    if (settings === null) return messagePage(503, "Not set up yet", NOT_SET_UP);
    const approved = await deps.oauth.approveConsent(request, handle, { scope: [MCP_SCOPE] });
    const verifier = bytesToBase64Url(randomBytes(32));
    const nonce = bytesToBase64Url(randomBytes(16));
    const { state, headers } = await deps.oauth.beginUpstream(approved.request, { data: { verifier, nonce }, headers: approved.headers });
    headers.set("Location", buildGoogleAuthUrl({ clientId: settings.clientId, redirectUri: callbackUrl(request), state, codeChallenge: await pkceChallenge(verifier, "S256"), nonce }));
    return new Response(null, { status: 302, headers });
  } catch (e) {
    if (isAuthorizationError(e)) return messagePage(400, "Can't connect", START_AGAIN);
    throw e;
  }
}

/** GET /callback: Google sends the user back here; only verified, allowlisted accounts finish the MCP authorization. */
export async function handleCallback(request: Request, deps: GoogleDeps): Promise<Response> {
  let resumed: { request: AuthRequest; data: { verifier?: unknown; nonce?: unknown }; headers: Headers };
  try {
    resumed = await deps.oauth.finishUpstream<{ verifier?: unknown; nonce?: unknown }>(request);
  } catch (e) {
    if (isAuthorizationError(e)) return messagePage(400, "Can't connect", START_AGAIN);
    throw e;
  }
  const url = new URL(request.url);
  const original = resumed.request;
  if (url.searchParams.has("error")) {
    const to = new URL(original.redirectUri);
    to.searchParams.set("error", "access_denied");
    if (original.state) to.searchParams.set("state", original.state);
    if (original.issuer) to.searchParams.set("iss", original.issuer);
    return redirect(to.toString(), resumed.headers);
  }
  const settings = googleSettings(deps.env);
  if (settings === null) return messagePage(503, "Not set up yet", NOT_SET_UP, resumed.headers);
  const code = url.searchParams.get("code");
  const verifier = resumed.data?.verifier;
  const nonce = resumed.data?.nonce;
  if (!code || typeof verifier !== "string" || typeof nonce !== "string") return messagePage(400, "Can't connect", START_AGAIN, resumed.headers);

  let idToken: string;
  try {
    idToken = await exchangeGoogleCode({ fetch: deps.fetch, clientId: settings.clientId, clientSecret: settings.clientSecret, code, codeVerifier: verifier, redirectUri: callbackUrl(request) });
  } catch {
    return messagePage(502, "Google sign-in did not finish", "Google sign-in did not complete. Start connecting again from the app.", resumed.headers);
  }
  let who: FamilyProps;
  try {
    who = verifyIdTokenClaims(decodeJwtPayload(idToken), { clientId: settings.clientId, now: deps.now(), nonce });
  } catch {
    return messagePage(403, "Not on the family list", FAMILY_LIST_MESSAGE, resumed.headers);
  }
  if (!isAllowed(who.email, true, settings.allowlist)) return messagePage(403, "Not on the family list", FAMILY_LIST_MESSAGE, resumed.headers);

  const props: FamilyProps = { email: who.email, name: who.name };
  const { redirectTo } = await deps.oauth.completeAuthorization({ request: original, userId: who.email, metadata: { label: who.name }, scope: [MCP_SCOPE], props });
  return redirect(redirectTo, resumed.headers);
}
