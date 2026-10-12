import { AuthError } from "./errors.js";
import { refreshCredential, type OAuthCredential } from "./oauth.js";

export const EXPIRY_SKEW_MS = 60_000;

export interface TokenProvider {
  getAccessToken(): Promise<string>;
  refreshAfterRejection(rejectedToken: string): Promise<string>;
}

/** The part of the Mac credential store (src/skylight/credentials.ts) the token provider uses. */
export interface RefreshableCredentialStore {
  read(): Promise<OAuthCredential | null>;
  write(credential: OAuthCredential): Promise<void>;
  withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
}

const NOT_LOGGED_IN = "Not logged in to Skylight. Run `skylight-mcp login` in a terminal.";

export function createTokenProvider(opts: {
  store: RefreshableCredentialStore; fetch: typeof globalThis.fetch; apiBaseUrl: string; timeoutMs: number; now?: () => number;
}): TokenProvider {
  const now = opts.now ?? Date.now;

  async function readOrThrow(): Promise<OAuthCredential> {
    const c = await opts.store.read();
    if (c === null) throw new AuthError(NOT_LOGGED_IN);
    return c;
  }

  // Refresh unless the stored credential has changed since `seen` (another process already rotated it).
  async function refreshIfStillCurrent(seen: OAuthCredential, stillStale: (c: OAuthCredential) => boolean): Promise<string> {
    return opts.store.withRefreshLock(async () => {
      const current = await readOrThrow();
      if (current.refreshToken !== seen.refreshToken || !stillStale(current)) return current.accessToken;
      const fresh = await refreshCredential({ fetch: opts.fetch, apiBaseUrl: opts.apiBaseUrl, credential: current, timeoutMs: opts.timeoutMs });
      await opts.store.write(fresh);
      return fresh.accessToken;
    });
  }

  return {
    async getAccessToken() {
      const c = await readOrThrow();
      const isExpired = (x: OAuthCredential) => x.expiresAt - EXPIRY_SKEW_MS <= now();
      if (!isExpired(c)) return c.accessToken;
      return refreshIfStillCurrent(c, isExpired);
    },
    async refreshAfterRejection(rejectedToken) {
      const c = await readOrThrow();
      if (c.accessToken !== rejectedToken) return c.accessToken;
      return refreshIfStillCurrent(c, (x) => x.accessToken === rejectedToken);
    },
  };
}
