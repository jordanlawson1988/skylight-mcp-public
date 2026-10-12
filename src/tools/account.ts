import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SkylightApiError } from "../skylight/errors.js";
import { mapAccount, mapPlusSubscriptions } from "../skylight/types.js";
import type { ToolContext } from "./context.js";
import { ANNOTATIONS, run } from "./result.js";

export function registerAccountTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "skylight_get_account",
    {
      title: "Get the Skylight plan",
      description: "The account's plan and marketing-email setting as { plan, plusSubscriptions: [{ status, cadence, type }], marketingEmails }. No email address, phone number, birthday or name is returned.",
      inputSchema: {},
      annotations: ANNOTATIONS.read,
    },
    () => run(async () => {
      const account = mapAccount(await ctx.client.request({ method: "GET", path: "/api/user" }));
      try {
        return { plan: account.plan, plusSubscriptions: mapPlusSubscriptions(await ctx.client.request({ method: "GET", path: "/api/plus_access" })), marketingEmails: account.marketingEmails };
      } catch (e) {
        if (!(e instanceof SkylightApiError)) throw e;
        return { plan: account.plan, plusSubscriptions: null, marketingEmails: account.marketingEmails, warning: "The subscriptions could not be read right now; try again." };
      }
    })
  );

  server.registerTool(
    "skylight_set_marketing_emails",
    {
      title: "Turn Skylight marketing emails on or off",
      description: "Turn Skylight's marketing emails to this account on (enabled: true) or off (enabled: false).",
      inputSchema: { enabled: z.boolean().describe("true subscribes to marketing emails, false unsubscribes.") },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      await ctx.client.request({ method: "PATCH", path: "/api/user/klaviyo_toggler", body: { agreed_to_marketing: args.enabled } });
      return { marketingEmails: args.enabled };
    })
  );
}
