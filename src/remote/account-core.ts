import { EXPIRY_SKEW_MS } from "../skylight/auth.js";
import type { SkylightConfig } from "../skylight/config.js";
import { base64ToBytes, bytesToBase64, randomBytes, utf8 } from "../skylight/encoding.js";
import { AuthError } from "../skylight/errors.js";
import { refreshCredential, type OAuthCredential } from "../skylight/oauth.js";
import { auditError, auditTargets } from "../tools/audit.js";
import type { AuditEntry } from "../tools/context.js";

/**
 * The shared server's Skylight account, independent of where it is stored: the Durable Object (account-do.ts) passes
 * its storage; tests pass a Map. One instance serves both family members, so refreshes are de-duplicated here and the
 * Durable Object's single-threaded execution serializes everything else.
 */

/** The subset of Durable Object storage AccountCore needs. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AccountCoreOpts {
  storage: KvLike;
  /** SKYLIGHT_TOKEN_KEY: 32 random bytes, base64. Encrypts the stored Skylight credential. */
  keyB64: string;
  fetch: typeof globalThis.fetch;
  config: SkylightConfig;
  now: () => number;
}

/** An audit entry as stored: when (UTC ISO) and who (the signed-in email) added by the Worker. */
export type AuditRecord = AuditEntry & { at: string; who: string };

export interface AccountStatus {
  loggedIn: boolean;
  needsLogin: boolean;
  /** UTC ISO expiry of the stored access token. */
  tokenExpiresAt: string | null;
  credentialError: string | null;
}

export type RateBucket = "mcp" | "admin";

export const RATE_LIMITS: Readonly<Record<RateBucket, { limit: number; windowMs: number }>> = {
  mcp: { limit: 300, windowMs: 600_000 },
  admin: { limit: 10, windowMs: 600_000 },
};

export const AUDIT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** A ceiling on top of the 90 days, so a runaway client cannot grow storage without bound. */
export const AUDIT_MAX_ENTRIES = 5000;
export const REMOTE_LOGIN_COMMAND = "skylight-mcp remote login";

export const ACCOUNT_MESSAGES = {
  notSignedIn: "The shared server is not signed in to Skylight. Jordan needs to run `skylight-mcp remote login`.",
  expired: "Skylight sign-in for the shared server expired; Jordan needs to run `skylight-mcp remote login`.",
  undecryptable: "The stored Skylight credential cannot be decrypted; run `skylight-mcp remote login`.",
  badKey: "SKYLIGHT_TOKEN_KEY must be 32 random bytes, base64-encoded.",
} as const;

const KEYS = {
  credential: "credential",
  needsLogin: "needs-login",
  auditHead: "audit:head",
  auditTail: "audit:tail",
  audit: (n: number) => `audit:${n}`,
  rate: (bucket: RateBucket, who: string) => `rate:${bucket}:${who}`,
} as const;

/** Binds the ciphertext to its purpose, so it cannot be replayed as some other encrypted value. */
const CREDENTIAL_AAD = utf8("skylight-mcp/credential/v1");

interface Sealed { v: 1; iv: string; ct: string }
type AesKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

function isCredential(v: unknown): v is OAuthCredential {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  const text = (x: unknown) => typeof x === "string" && x.length > 0 && x.length <= 8192;
  return c.version === 1 && text(c.accessToken) && text(c.refreshToken) && text(c.fingerprint)
    && typeof c.expiresAt === "number" && Number.isFinite(c.expiresAt) && c.expiresAt > 0;
}

export class AccountCore {
  private readonly storage: KvLike;
  private readonly opts: AccountCoreOpts;
  private key: Promise<AesKey> | null = null;
  private inflight: Promise<string> | null = null;
  /** Orders refreshes, new sign-ins and sign-outs, so a refresh of an old grant can never land after a new grant. */
  private credentialQueue: Promise<unknown> = Promise.resolve();
  /** Orders audit and rate-limit read-modify-write steps (separate, so a slow refresh never delays them). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(opts: AccountCoreOpts) {
    this.opts = opts;
    this.storage = opts.storage;
  }

  /**
   * Runs `fn` after everything already queued on that chain (the Durable Object interleaves calls while one awaits a
   * fetch; Node tests interleave freely). A failure does not block the next caller.
   */
  private serialized<T>(chain: "queue" | "credentialQueue", fn: () => Promise<T>): Promise<T> {
    const run = this[chain].then(fn, fn);
    this[chain] = run.then(() => undefined, () => undefined);
    return run;
  }

  // ---- Skylight credential ----

  async getAccessToken(): Promise<string> {
    const c = await this.usableCredential();
    const isExpired = (x: OAuthCredential) => x.expiresAt - EXPIRY_SKEW_MS <= this.opts.now();
    if (!isExpired(c)) return c.accessToken;
    return this.refreshIfStillCurrent(c, isExpired);
  }

  async refreshAfterRejection(rejected: string): Promise<string> {
    const c = await this.usableCredential();
    if (c.accessToken !== rejected) return c.accessToken;
    return this.refreshIfStillCurrent(c, (x) => x.accessToken === rejected);
  }

  async setCredential(credential: OAuthCredential): Promise<void> {
    if (!isCredential(credential)) throw new AuthError("Refusing to store a malformed Skylight credential.");
    const clean: OAuthCredential = { version: 1, accessToken: credential.accessToken, refreshToken: credential.refreshToken, fingerprint: credential.fingerprint, expiresAt: credential.expiresAt };
    await this.cryptoKey(); // a bad SKYLIGHT_TOKEN_KEY fails here, before waiting on anything
    return this.serialized("credentialQueue", async () => {
      await this.writeCredential(clean);
      await this.storage.delete(KEYS.needsLogin);
    });
  }

  clearCredential(): Promise<boolean> {
    return this.serialized("credentialQueue", async () => {
      const existed = (await this.storage.get(KEYS.credential)) !== null;
      await this.storage.delete(KEYS.credential);
      await this.storage.delete(KEYS.needsLogin);
      return existed;
    });
  }

  async status(): Promise<AccountStatus> {
    let c: OAuthCredential | null;
    try {
      c = await this.readCredential();
    } catch (e) {
      return { loggedIn: false, needsLogin: true, tokenExpiresAt: null, credentialError: e instanceof Error ? e.message : String(e) };
    }
    if (c === null) return { loggedIn: false, needsLogin: true, tokenExpiresAt: null, credentialError: null };
    const flagged = (await this.storage.get(KEYS.needsLogin)) !== null;
    return { loggedIn: true, needsLogin: flagged, tokenExpiresAt: new Date(c.expiresAt).toISOString(), credentialError: null };
  }

  /** The stored credential, unless there is none or Skylight already refused its refresh token. */
  private async usableCredential(): Promise<OAuthCredential> {
    const c = await this.readCredential();
    if (c === null) throw new AuthError(ACCOUNT_MESSAGES.notSignedIn);
    if ((await this.storage.get(KEYS.needsLogin)) !== null) throw new AuthError(ACCOUNT_MESSAGES.expired, "session_expired");
    return c;
  }

  /**
   * One refresh at a time; concurrent callers share it. It runs under the credential lock and re-reads the credential
   * there, so it skips the refresh when another caller (or a new sign-in) already replaced the token.
   */
  private refreshIfStillCurrent(seen: OAuthCredential, stillStale: (c: OAuthCredential) => boolean): Promise<string> {
    if (this.inflight) return this.inflight;
    const run = this.serialized("credentialQueue", async () => {
      const current = await this.usableCredential();
      if (current.refreshToken !== seen.refreshToken || !stillStale(current)) return current.accessToken;
      let fresh: OAuthCredential;
      try {
        fresh = await refreshCredential({
          fetch: this.opts.fetch, apiBaseUrl: this.opts.config.apiBaseUrl, credential: current,
          timeoutMs: this.opts.config.requestTimeoutMs, loginCommand: REMOTE_LOGIN_COMMAND,
        });
      } catch (e) {
        if (e instanceof AuthError && e.code === "session_expired") {
          await this.storage.put(KEYS.needsLogin, "1");
          throw new AuthError(ACCOUNT_MESSAGES.expired, "session_expired");
        }
        throw e;
      }
      await this.writeCredential(fresh);
      return fresh.accessToken;
    });
    this.inflight = run;
    const clear = () => { if (this.inflight === run) this.inflight = null; };
    run.then(clear, clear);
    return run;
  }

  private cryptoKey(): Promise<AesKey> {
    if (this.key === null) {
      this.key = (async () => {
        let raw: Uint8Array;
        try { raw = base64ToBytes(this.opts.keyB64); } catch { throw new Error(ACCOUNT_MESSAGES.badKey); }
        if (raw.length !== 32) throw new Error(ACCOUNT_MESSAGES.badKey);
        return crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
      })();
      this.key.catch(() => { this.key = null; });
    }
    return this.key;
  }

  private async writeCredential(c: OAuthCredential): Promise<void> {
    const key = await this.cryptoKey();
    const iv = randomBytes(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as Uint8Array<ArrayBuffer>, additionalData: CREDENTIAL_AAD as Uint8Array<ArrayBuffer> }, key, utf8(JSON.stringify(c)) as Uint8Array<ArrayBuffer>));
    const sealed: Sealed = { v: 1, iv: bytesToBase64(iv), ct: bytesToBase64(ct) };
    await this.storage.put(KEYS.credential, JSON.stringify(sealed));
  }

  private async readCredential(): Promise<OAuthCredential | null> {
    const raw = await this.storage.get(KEYS.credential);
    if (raw === null) return null;
    const key = await this.cryptoKey();
    try {
      const sealed = JSON.parse(raw) as Sealed;
      if (sealed.v !== 1) throw new Error("version");
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(sealed.iv) as Uint8Array<ArrayBuffer>, additionalData: CREDENTIAL_AAD as Uint8Array<ArrayBuffer> },
        key, base64ToBytes(sealed.ct) as Uint8Array<ArrayBuffer>,
      );
      const c = JSON.parse(new TextDecoder().decode(plain)) as unknown;
      if (!isCredential(c)) throw new Error("shape");
      return c;
    } catch {
      throw new AuthError(ACCOUNT_MESSAGES.undecryptable);
    }
  }

  // ---- audit log (a ring of numbered keys between tail and head) ----

  appendAudit(record: AuditRecord): Promise<void> {
    return this.serialized("queue", async () => {
      const clean = sanitizeAudit(record);
      let head = Number((await this.storage.get(KEYS.auditHead)) ?? "0");
      let tail = Number((await this.storage.get(KEYS.auditTail)) ?? "0");
      await this.storage.put(KEYS.audit(head), JSON.stringify(clean));
      head += 1;
      await this.storage.put(KEYS.auditHead, String(head));
      const cutoff = this.opts.now() - AUDIT_RETENTION_MS;
      while (tail < head) {
        const tooMany = head - tail > AUDIT_MAX_ENTRIES;
        const raw = tooMany ? null : await this.storage.get(KEYS.audit(tail));
        const at = raw === null ? Number.NaN : Date.parse((JSON.parse(raw) as AuditRecord).at);
        if (!tooMany && raw !== null && !(at < cutoff)) break;
        await this.storage.delete(KEYS.audit(tail));
        tail += 1;
      }
      await this.storage.put(KEYS.auditTail, String(tail));
    });
  }

  /** The newest entries first. */
  async recentAudit(limit: number): Promise<AuditRecord[]> {
    const n = Math.max(0, Math.min(Math.floor(limit), AUDIT_MAX_ENTRIES));
    const head = Number((await this.storage.get(KEYS.auditHead)) ?? "0");
    const tail = Number((await this.storage.get(KEYS.auditTail)) ?? "0");
    const out: AuditRecord[] = [];
    for (let i = head - 1; i >= tail && out.length < n; i--) {
      const raw = await this.storage.get(KEYS.audit(i));
      if (raw !== null) out.push(JSON.parse(raw) as AuditRecord);
    }
    return out;
  }

  // ---- rate limits (fixed windows) ----

  allow(who: string, bucket: RateBucket): Promise<boolean> {
    return this.serialized("queue", async () => {
      const { limit, windowMs } = RATE_LIMITS[bucket];
      const key = KEYS.rate(bucket, who.slice(0, 320));
      const window = Math.floor(this.opts.now() / windowMs);
      const raw = await this.storage.get(key);
      const stored = raw === null ? null : (JSON.parse(raw) as { w: number; n: number });
      const count = stored !== null && stored.w === window ? stored.n : 0;
      if (count >= limit) return false;
      await this.storage.put(key, JSON.stringify({ w: window, n: count + 1 }));
      return true;
    });
  }
}

/** Keeps only the documented fields; ids must look like ids; error text is redacted and short. */
function sanitizeAudit(r: AuditRecord): AuditRecord {
  const at = typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) ? new Date(r.at).toISOString() : new Date().toISOString();
  const out: AuditRecord = {
    at,
    who: String(r.who ?? "").slice(0, 320),
    tool: String(r.tool ?? "").slice(0, 100),
    targets: auditTargets({ targetIds: Array.isArray(r.targets) ? r.targets : [] }),
    ok: r.ok === true,
  };
  if (r.preview === true) out.preview = true;
  if (typeof r.error === "string" && r.error !== "") out.error = auditError(r.error);
  return out;
}

// ---- the Durable Object's RPC surface ----

/** Token answers cross the RPC boundary as values: an AuthError becomes { ok: false } with its message. */
export type TokenResult = { ok: true; token: string } | { ok: false; error: string };

/** What the Worker calls on the SkylightAccount Durable Object (account-do.ts implements it over AccountCore). */
export interface AccountRpc {
  getAccessToken(): Promise<TokenResult>;
  refreshAfterRejection(rejected: string): Promise<TokenResult>;
  setCredential(credential: OAuthCredential): Promise<void>;
  clearCredential(): Promise<boolean>;
  status(): Promise<AccountStatus>;
  appendAudit(record: AuditRecord): Promise<void>;
  recentAudit(limit: number): Promise<AuditRecord[]>;
  allow(who: string, bucket: RateBucket): Promise<boolean>;
}

export async function tokenResult(fn: () => Promise<string>): Promise<TokenResult> {
  try {
    return { ok: true, token: await fn() };
  } catch (e) {
    if (e instanceof AuthError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Turns a TokenResult back into a token or the AuthError it carried (the Worker side of the boundary). */
export function unwrapToken(result: TokenResult): string {
  if (result.ok) return result.token;
  throw new AuthError(result.error);
}

/** Adapts Durable Object storage (get returns undefined when absent) to KvLike. */
export function kvFromStorage(storage: {
  get(key: string): Promise<unknown>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
}): KvLike {
  return {
    async get(key) { const v = await storage.get(key); return typeof v === "string" ? v : null; },
    put: (key, value) => storage.put(key, value),
    async delete(key) { await storage.delete(key); },
  };
}

/** AccountRpc over one AccountCore: what the Durable Object exposes, and what tests use in its place. */
export function accountRpc(core: AccountCore): AccountRpc {
  return {
    getAccessToken: () => tokenResult(() => core.getAccessToken()),
    refreshAfterRejection: (rejected) => tokenResult(() => core.refreshAfterRejection(rejected)),
    setCredential: (c) => core.setCredential(c),
    clearCredential: () => core.clearCredential(),
    status: () => core.status(),
    appendAudit: (r) => core.appendAudit(r),
    recentAudit: (limit) => core.recentAudit(limit),
    allow: (who, bucket) => core.allow(who, bucket),
  };
}
