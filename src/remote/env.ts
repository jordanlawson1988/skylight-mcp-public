import { CONFIG_ENV_KEYS, parseConfig, type SkylightConfig } from "../skylight/config.js";

/**
 * The Worker's string settings. Secrets arrive through `wrangler secret put` (never wrangler.jsonc); the SKYLIGHT_*
 * settings are plain vars. Bindings (KV, the Durable Object, OAUTH_PROVIDER) are added in worker.ts.
 */
export interface RemoteEnv {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Comma-separated Google account emails allowed to sign in. */
  ALLOWED_EMAILS?: string;
  /** 32 random bytes, base64: encrypts the stored Skylight credential. */
  SKYLIGHT_TOKEN_KEY?: string;
  /** Bearer token for /admin/* (the Mac CLI keeps it in the Keychain). */
  ADMIN_TOKEN?: string;
  SKYLIGHT_API_BASE?: string;
  SKYLIGHT_REQUEST_TIMEOUT_MS?: string;
  SKYLIGHT_FRAME_ID?: string;
  SKYLIGHT_TIMEZONE?: string;
  SKYLIGHT_TOOLSETS?: string;
}

/** The one OAuth scope the server grants (advertised, approved on the consent page, required by nothing finer). */
export const MCP_SCOPE = "skylight";

/** Every secret the Worker needs, in the order `skylight-mcp remote setup` explains them. */
export const REMOTE_SECRETS = ["SKYLIGHT_TOKEN_KEY", "ADMIN_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "ALLOWED_EMAILS"] as const;
export type RemoteSecret = (typeof REMOTE_SECRETS)[number];
/** The two the setup command generates and stores itself; Jordan supplies the Google ones and the allowlist. */
export const GENERATED_SECRETS = ["SKYLIGHT_TOKEN_KEY", "ADMIN_TOKEN"] as const satisfies readonly RemoteSecret[];

/** The tool settings (SKYLIGHT_* vars) as a SkylightConfig; bindings and secrets are ignored. */
export function configFromEnv(env: RemoteEnv): SkylightConfig {
  const vars: Record<string, string | undefined> = {};
  for (const key of CONFIG_ENV_KEYS) {
    const value = (env as Record<string, unknown>)[key];
    if (typeof value === "string") vars[key] = value;
  }
  return parseConfig(vars);
}

/** Secret values to mask in any error text the Worker produces (redaction list for excerpt()). */
export function secretValues(env: RemoteEnv): string[] {
  return [env.ADMIN_TOKEN, env.GOOGLE_CLIENT_SECRET, env.SKYLIGHT_TOKEN_KEY].filter((v): v is string => typeof v === "string" && v.length >= 8);
}
