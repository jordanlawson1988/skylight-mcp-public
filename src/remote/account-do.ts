import { DurableObject } from "cloudflare:workers";
import type { OAuthCredential } from "../skylight/oauth.js";
import {
  AccountCore, accountRpc, kvFromStorage, type AccountRpc, type AccountStatus, type AuditRecord, type RateBucket, type TokenResult,
} from "./account-core.js";
import { configFromEnv, type RemoteEnv } from "./env.js";

/** The one instance's name: the whole family shares a single Skylight account. */
export const ACCOUNT_OBJECT_NAME = "family";

/**
 * The family's Skylight account on the shared server: one Durable Object instance (idFromName("family")) with SQLite
 * storage. Its single-threaded execution plus AccountCore's shared in-flight refresh means two family members calling
 * tools at once never refresh the rotating Skylight token twice.
 */
export class SkylightAccount extends DurableObject<RemoteEnv> implements AccountRpc {
  private rpc: AccountRpc | null = null;

  private account(): AccountRpc {
    if (this.rpc === null) {
      const core = new AccountCore({
        storage: kvFromStorage(this.ctx.storage),
        keyB64: this.env.SKYLIGHT_TOKEN_KEY ?? "",
        fetch: (input, init) => fetch(input, init),
        config: configFromEnv(this.env),
        now: () => Date.now(),
      });
      this.rpc = accountRpc(core);
    }
    return this.rpc;
  }

  getAccessToken(): Promise<TokenResult> { return this.account().getAccessToken(); }
  refreshAfterRejection(rejected: string): Promise<TokenResult> { return this.account().refreshAfterRejection(rejected); }
  setCredential(credential: OAuthCredential): Promise<void> { return this.account().setCredential(credential); }
  clearCredential(): Promise<boolean> { return this.account().clearCredential(); }
  status(): Promise<AccountStatus> { return this.account().status(); }
  appendAudit(record: AuditRecord): Promise<void> { return this.account().appendAudit(record); }
  recentAudit(limit: number): Promise<AuditRecord[]> { return this.account().recentAudit(limit); }
  allow(who: string, bucket: RateBucket): Promise<boolean> { return this.account().allow(who, bucket); }
}
