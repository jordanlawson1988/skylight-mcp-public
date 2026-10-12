import { createTokenProvider, type TokenProvider } from "./skylight/auth.js";
import { createClient, type Sleep, type SkylightClient } from "./skylight/client.js";
import { loadConfig, type SkylightConfig } from "./skylight/config.js";
import { createCredentialStore, createKeychainRunner, type CredentialStore, type KeychainRunner } from "./skylight/credentials.js";
import { createFrameResolver, type FrameResolver } from "./skylight/frame.js";

export interface Runtime {
  config: SkylightConfig;
  store: CredentialStore;
  tokens: TokenProvider;
  client: SkylightClient;
  frames: FrameResolver;
  fetch: typeof globalThis.fetch;
}

export function assertMacOS(platform: string = process.platform): void {
  if (platform !== "darwin") throw new Error("skylight-mcp v1 supports macOS only (needs the Keychain).");
}

export function createRuntime(opts: { env?: NodeJS.ProcessEnv; fetch?: typeof globalThis.fetch; runner?: KeychainRunner; sleep?: Sleep } = {}): Runtime {
  const config = loadConfig(opts.env ?? process.env);
  const fetch = opts.fetch ?? globalThis.fetch;
  const store = createCredentialStore({ dir: config.credentialsDir, apiBaseUrl: config.apiBaseUrl, runner: opts.runner ?? createKeychainRunner() });
  const tokens = createTokenProvider({ store, fetch, apiBaseUrl: config.apiBaseUrl, timeoutMs: config.requestTimeoutMs });
  const client = createClient({ fetch, config, tokens, ...(opts.sleep ? { sleep: opts.sleep } : {}) });
  const frames = createFrameResolver({ client, configuredFrameId: config.frameId });
  return { config, store, tokens, client, frames, fetch };
}
