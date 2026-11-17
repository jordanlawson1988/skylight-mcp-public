/**
 * Who a family member is. An email is only accepted in plain printable ASCII (no look-alike characters), and the first
 * successful Google sign-in for an allowlisted email binds it to that Google account's stable id (`sub`), kept in
 * OAUTH_KV. A later sign-in claiming the same email from a different Google account is refused. `skylight-mcp remote
 * revoke <email>` (DELETE /admin/identity) clears the binding so the next sign-in binds again.
 */

/** The KV operations used (the Workers KV namespace and the tests' in-memory store both fit). */
export interface IdentityKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

const MAX_EMAIL_LENGTH = 254;
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/;

export function isPlainEmail(value: string): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_EMAIL_LENGTH) return false;
  if (!PRINTABLE_ASCII.test(value) || value.includes(",")) return false;
  const parts = value.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts as [string, string];
  return local.length > 0 && /^[^.]+(\.[^.]+)+$/.test(domain);
}

export function identityKey(email: string): string {
  return `identity:${email}`;
}

/** True when `sub` is (now) the Google account bound to `email`; false when a different account already holds it. */
export async function bindIdentity(kv: IdentityKv, email: string, sub: string): Promise<boolean> {
  const key = identityKey(email);
  const bound = await kv.get(key);
  if (bound === null) {
    await kv.put(key, sub);
    return true;
  }
  return bound === sub;
}

export async function clearIdentity(kv: IdentityKv, email: string): Promise<boolean> {
  const key = identityKey(email);
  const existed = (await kv.get(key)) !== null;
  await kv.delete(key);
  return existed;
}
