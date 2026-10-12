import { homedir } from "node:os";
import path from "node:path";
import { parseConfig, type SkylightConfig } from "../skylight/config.js";

/** The Mac's settings: the shared ones plus where the local credential file lives. */
export interface NodeConfig extends SkylightConfig {
  credentialsDir: string;
}

/** skylight-mcp's folder in Application Support (holds credentials/ and remote.json). */
export function appSupportDir(): string {
  return path.join(homedir(), "Library", "Application Support", "skylight-mcp");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NodeConfig {
  const config = parseConfig(env);
  const credentialsDir = env.SKYLIGHT_CREDENTIALS_DIR?.trim() || path.join(appSupportDir(), "credentials");
  return { ...config, credentialsDir };
}
