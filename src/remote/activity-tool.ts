import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SkylightConfig } from "../skylight/config.js";
import { formatHuman, formatOffsetDateTime } from "../skylight/time.js";
import { ANNOTATIONS, run } from "../tools/result.js";
import type { AccountRpc } from "./account-core.js";

/** Tools only the shared server registers (the README documents them in their own rows). */
export const REMOTE_ONLY_TOOLS = ["skylight_recent_activity"] as const;

export const ACTIVITY_DEFAULT_LIMIT = 20;
export const ACTIVITY_MAX_LIMIT = 50;

export function registerActivityTool(server: McpServer, deps: { account: Pick<AccountRpc, "recentAudit">; config: Pick<SkylightConfig, "timezone"> }): void {
  const tz = deps.config.timezone;
  server.registerTool(
    "skylight_recent_activity",
    {
      title: "Recent changes on the family Skylight",
      description: `List the most recent changes made through this shared server, newest first: when (in the configured time zone), which family member, which tool, the ids it touched, and whether it worked. preview: true means nothing was changed (a dry run or a confirm preview). Holds the last 90 days; read only. limit 1 to ${ACTIVITY_MAX_LIMIT}, default ${ACTIVITY_DEFAULT_LIMIT}.`,
      inputSchema: {
        limit: z.number().int().min(1).max(ACTIVITY_MAX_LIMIT).optional().describe(`How many entries, 1 to ${ACTIVITY_MAX_LIMIT}. Default ${ACTIVITY_DEFAULT_LIMIT}.`),
      },
      annotations: ANNOTATIONS.read,
    },
    (args) => run(async () => {
      const entries = await deps.account.recentAudit(args.limit ?? ACTIVITY_DEFAULT_LIMIT);
      return {
        timezone: tz,
        count: entries.length,
        entries: entries.map((e) => ({
          when: formatHuman(e.at, tz),
          atLocal: formatOffsetDateTime(e.at, tz),
          who: e.who,
          tool: e.tool,
          targets: e.targets,
          ok: e.ok,
          ...(e.preview ? { preview: true } : {}),
          ...(e.error ? { error: e.error } : {}),
        })),
      };
    })
  );
}
