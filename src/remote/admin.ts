import { z } from "zod";
import { timingSafeEqualText } from "../skylight/encoding.js";
import type { AccountRpc } from "./account-core.js";
import type { RemoteEnv } from "./env.js";
import type { OAuthApi } from "./google.js";

/**
 * /admin/* for the Mac CLI (`skylight-mcp remote login|status|logout|revoke`). Every route needs
 * `Authorization: Bearer <ADMIN_TOKEN>`, compared in constant time; failures get a bare 401. Authenticated calls are
 * rate-limited (10 per 10 minutes). Nothing a caller sends is ever echoed back.
 */

export const ADMIN_CREDENTIAL_PATH = "/admin/skylight-credential";
export const ADMIN_GRANTS_PATH = "/admin/grants";
const MAX_BODY_BYTES = 16 * 1024;
const MIN_ADMIN_TOKEN_LENGTH = 32;

export const CredentialBody = z.object({
  accessToken: z.string().min(1).max(8192),
  refreshToken: z.string().min(1).max(8192),
  /** Milliseconds since the epoch, as the Mac's credential stores it. */
  expiresAt: z.number().int().positive(),
  /** The device fingerprint the grant was issued to (refreshes must send the same one). */
  fingerprint: z.string().min(1).max(200).optional(),
  tokenType: z.string().max(50).optional(),
  scope: z.string().max(500).optional(),
}).strict();
export type CredentialBody = z.infer<typeof CredentialBody>;

export interface AdminDeps {
  account(env: RemoteEnv): AccountRpc;
  oauth(env: RemoteEnv): Pick<OAuthApi, "listUserGrants" | "revokeGrant">;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}

/** True when the request carries exactly `Bearer <expected>`; the comparison hashes both sides first. */
export async function isAdminRequest(request: Request, expected: string): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer[ \t]+(\S+)$/i.exec(header);
  const presented = match?.[1] ?? "";
  // Always compare (even an empty token) so a missing header costs the same as a wrong one.
  const same = await timingSafeEqualText(presented, expected);
  return match !== null && same;
}

const EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/;

async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return { ok: false, response: json(413, { error: "body_too_large" }) };
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return { ok: false, response: json(413, { error: "body_too_large" }) };
  try { return { ok: true, value: JSON.parse(text) as unknown }; } catch { return { ok: false, response: json(400, { error: "invalid_json" }) }; }
}

export async function handleAdmin(request: Request, env: RemoteEnv, deps: AdminDeps): Promise<Response> {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < MIN_ADMIN_TOKEN_LENGTH) return json(503, { error: "admin_not_configured" });
  if (!(await isAdminRequest(request, env.ADMIN_TOKEN))) {
    return new Response(null, { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="skylight-mcp-admin"', "Cache-Control": "no-store" } });
  }
  const account = deps.account(env);
  if (!(await account.allow("admin", "admin"))) return json(429, { error: "rate_limited" }, { "Retry-After": "600" });

  const url = new URL(request.url);
  if (url.pathname === ADMIN_CREDENTIAL_PATH) {
    if (request.method === "GET") return json(200, await account.status());
    if (request.method === "DELETE") return json(200, { removed: await account.clearCredential() });
    if (request.method === "PUT") {
      const body = await readJsonBody(request);
      if (!body.ok) return body.response;
      const parsed = CredentialBody.safeParse(body.value);
      if (!parsed.success) {
        // Field names only: never the values, which are tokens.
        const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))];
        return json(400, { error: "invalid_credential", fields });
      }
      const c = parsed.data;
      await account.setCredential({ version: 1, accessToken: c.accessToken, refreshToken: c.refreshToken, fingerprint: c.fingerprint ?? crypto.randomUUID(), expiresAt: c.expiresAt });
      return json(200, { ok: true, tokenExpiresAt: new Date(c.expiresAt).toISOString() });
    }
    return json(405, { error: "method_not_allowed" }, { Allow: "GET, PUT, DELETE" });
  }
  if (url.pathname === ADMIN_GRANTS_PATH) {
    if (request.method !== "DELETE") return json(405, { error: "method_not_allowed" }, { Allow: "DELETE" });
    const email = (url.searchParams.get("email") ?? "").trim().toLowerCase();
    if (!EMAIL.test(email)) return json(400, { error: "email_required" });
    const oauth = deps.oauth(env);
    // List every page first, then revoke: deleting while paging could skip grants.
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const list = await oauth.listUserGrants(email, cursor ? { cursor, limit: 100 } : { limit: 100 });
      for (const grant of list.items) ids.push(grant.id);
      if (!list.cursor) break;
      cursor = list.cursor;
    }
    for (const id of ids) await oauth.revokeGrant(id, email);
    return json(200, { email, revoked: ids.length });
  }
  return json(404, { error: "not_found" });
}
