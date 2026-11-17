import { status } from "./cli/commands.js";
import { loadConfig, type NodeConfig } from "./node/config.js";
import { createTokenProvider, type TokenProvider } from "./skylight/auth.js";
import { createClient, type Sleep } from "./skylight/client.js";
import { createCredentialStore, createKeychainRunner, type CredentialStore, type KeychainRunner } from "./skylight/credentials.js";
import { createFrameResolver } from "./skylight/frame.js";
import { REFRESH_TIMEOUT_MS } from "./skylight/oauth.js";
import type { ToolContext } from "./tools/context.js";

/** The Mac stdio runtime: the shared ToolContext plus the local credential store it is built on. */
export interface Runtime extends ToolContext {
  config: NodeConfig;
  store: CredentialStore;
  tokens: TokenProvider;
  fetch: typeof globalThis.fetch;
}

export function assertMacOS(platform: string = process.platform): void {
  if (platform !== "darwin") throw new Error("skylight-mcp v1 supports macOS only (needs the Keychain).");
}

export function createRuntime(opts: { env?: NodeJS.ProcessEnv; fetch?: typeof globalThis.fetch; runner?: KeychainRunner; sleep?: Sleep; now?: () => Date } = {}): Runtime {
  const config = loadConfig(opts.env ?? process.env);
  const fetch = opts.fetch ?? globalThis.fetch;
  const store = createCredentialStore({ dir: config.credentialsDir, apiBaseUrl: config.apiBaseUrl, runner: opts.runner ?? createKeychainRunner() });
  const tokens = createTokenProvider({ store, fetch, apiBaseUrl: config.apiBaseUrl, timeoutMs: REFRESH_TIMEOUT_MS });
  const client = createClient({ fetch, config, tokens, ...(opts.sleep ? { sleep: opts.sleep } : {}) });
  const frames = createFrameResolver({ client, configuredFrameId: config.frameId });
  const rt: Runtime = {
    config, store, tokens, client, frames, fetch,
    now: opts.now ?? (() => new Date()),
    authStatus: () => status(rt),
  };
  return rt;
}
