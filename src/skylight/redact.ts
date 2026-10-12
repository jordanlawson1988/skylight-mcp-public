const SECRET_KEYS = ["access_token", "refresh_token", "code", "code_verifier"];
const JSON_SECRET_VALUES = SECRET_KEYS.map((k) => new RegExp(`("${k}"\\s*:\\s*)"[^"]*"`, "g"));
const BEARER = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;

/**
 * Turns an upstream response body or error message into a short, single-line string that is safe to show.
 * Masks token-like JSON values, Bearer credentials and any known secrets (raw, URL-encoded or JSON-escaped).
 */
export function excerpt(text: string, secrets: readonly string[] = [], max = 500): string {
  let out = text;
  for (const re of JSON_SECRET_VALUES) out = out.replace(re, '$1"[redacted]"');
  out = out.replace(BEARER, "Bearer [redacted]");
  for (const secret of secrets) {
    if (!secret) continue;
    for (const variant of new Set([secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])) {
      if (variant) out = out.split(variant).join("[redacted]");
    }
  }
  const clean = out.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
}
