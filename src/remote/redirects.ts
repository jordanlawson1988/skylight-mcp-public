/**
 * Which apps may connect: the only redirect URIs a client may register or use, and the only hosts a Client ID Metadata
 * Document client_id may live on. One list, used by dynamic client registration (worker.ts) and by /authorize
 * (google.ts), so a client registered before the list existed is still checked.
 */

/** Exact strings: Claude (both domains) and ChatGPT's platform redirect. */
export const ALLOWED_REDIRECT_URIS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
] as const;

/** ChatGPT's per-connector callback: exactly one path segment of [A-Za-z0-9_-]. */
const CHATGPT_CONNECTOR_REDIRECT = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/;
/** Claude Code's local callback: http, localhost or 127.0.0.1, any port, path /callback. */
const LOOPBACK_REDIRECT = /^http:\/\/(?:localhost|127\.0\.0\.1):([0-9]{1,5})\/callback$/;

/** Hosts whose Client ID Metadata Documents are trusted (exact hostnames, https, default port). */
export const CIMD_CLIENT_HOSTS = ["claude.ai", "claude.com", "chatgpt.com", "openai.com"] as const;

/** What the consent page calls each app: decided by where access is sent, never by the name the client gives itself. */
export const APP_NAMES = { claude: "Claude", chatgpt: "ChatGPT", claudeCode: "Claude Code on this computer" } as const;

export function appNameForRedirect(uri: string): string {
  if (!isAllowedRedirectUri(uri)) return "an unknown app";
  if (LOOPBACK_REDIRECT.test(uri)) return APP_NAMES.claudeCode;
  const host = new URL(uri).hostname;
  return host === "chatgpt.com" ? APP_NAMES.chatgpt : APP_NAMES.claude;
}

export function isAllowedRedirectUri(uri: unknown): boolean {
  if (typeof uri !== "string") return false;
  if ((ALLOWED_REDIRECT_URIS as readonly string[]).includes(uri)) return true;
  if (CHATGPT_CONNECTOR_REDIRECT.test(uri)) return true;
  const loopback = LOOPBACK_REDIRECT.exec(uri);
  if (loopback) {
    const port = Number(loopback[1]);
    return port >= 1 && port <= 65535;
  }
  return false;
}

/**
 * URL-shaped client ids: anything containing "://", in any case. The library treats an id whose scheme is https in
 * any case (HTTPS://, hTtPs://) as a Client ID Metadata Document URL, so this errs wide: every URL-shaped id has to
 * pass isAllowedCimdClientId, and only opaque ids (dynamic registration) skip it.
 */
export function isCimdClientId(clientId: string): boolean {
  return typeof clientId === "string" && clientId.includes("://");
}

/** An https URL (scheme in any case, written with "://") on one of CIMD_CLIENT_HOSTS, compared after URL parsing. */
export function isAllowedCimdClientId(clientId: string): boolean {
  if (typeof clientId !== "string" || !/^https:\/\//i.test(clientId)) return false;
  let url: URL;
  try { url = new URL(clientId); } catch { return false; }
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === ""
    && (CIMD_CLIENT_HOSTS as readonly string[]).includes(url.hostname.toLowerCase());
}

/**
 * The provider's clientRegistrationCallback (DCR, RFC 7591): refuse the registration unless every redirect_uri in the
 * raw metadata is on the allowlist. The refusal does not echo what was sent.
 */
export function clientRegistrationCallback(options: { clientMetadata: Record<string, unknown>; request: Request }): { code: string; description: string; status: number } | undefined {
  const uris = options.clientMetadata.redirect_uris;
  const ok = Array.isArray(uris) && uris.length > 0 && uris.every(isAllowedRedirectUri);
  return ok ? undefined : { code: "invalid_redirect_uri", description: "This server only accepts Claude and ChatGPT redirect URIs.", status: 400 };
}
