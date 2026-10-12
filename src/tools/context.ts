import type { SkylightClient } from "../skylight/client.js";
import type { SkylightConfig } from "../skylight/config.js";
import type { FrameResolver } from "../skylight/frame.js";
import type { AuthStatusReport } from "../skylight/status.js";

export type { AuthStatusReport } from "../skylight/status.js";

/**
 * One call of a tool that can change something (annotations without readOnlyHint: true). Only ids, never argument
 * values or tokens. The shared server adds when and who (src/remote/account-core.ts).
 */
export interface AuditEntry {
  tool: string;
  /** Values of id arguments (keys ending in Id or Ids), at most 20. */
  targets: string[];
  ok: boolean;
  /** A dry run or a confirm-gated preview: nothing was changed. */
  preview?: boolean;
  /** Short, redacted error text when ok is false. */
  error?: string;
}

/**
 * What every tool may use. The Mac stdio server builds it in src/runtime.ts; the Worker builds it per request in
 * src/remote/mcp-handler.ts. Nothing here is Node-specific.
 */
export interface ToolContext {
  config: SkylightConfig;
  client: SkylightClient;
  frames: FrameResolver;
  /** The clock; tools take "today" from this in the configured zone. Injectable for tests. */
  now: () => Date;
  authStatus(): Promise<AuthStatusReport>;
  /** Records calls of tools that can change something (the shared server's activity log). */
  audit?: (entry: AuditEntry) => Promise<void>;
}
