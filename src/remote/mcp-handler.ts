import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "../server-core.js";
import type { TokenProvider } from "../skylight/auth.js";
import { createClient } from "../skylight/client.js";
import type { SkylightConfig } from "../skylight/config.js";
import { createFrameResolver, type FrameResolver } from "../skylight/frame.js";
import { buildAuthStatus, LOGIN_HINTS, type AuthStatusReport } from "../skylight/status.js";
import type { ToolContext } from "../tools/context.js";
import { unwrapToken, type AccountRpc } from "./account-core.js";
import { registerActivityTool } from "./activity-tool.js";
import { configFromEnv, secretValues, type RemoteEnv } from "./env.js";
import { isAllowed, parseAllowlist, type FamilyProps } from "./google.js";
import { workerErrorLogger } from "./log.js";

/**
 * POST /mcp, after the OAuth provider has validated the bearer token (audience = this server's /mcp) and put the
 * grant's props in ctx.props. Stateless: every request builds the same tools as the Mac's stdio server around a
 * token provider backed by the SkylightAccount Durable Object, answers with JSON, and is gone.
 */

export interface McpHandlerDeps {
  account(env: RemoteEnv): AccountRpc;
  /** Skylight API fetch; the Worker's global fetch by default. */
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  /** Unexpected tool errors; the Worker's redacted, stack-free logger by default. */
  logError?: (error: unknown) => void;
}

/** A JSON-RPC batch may hold at most this many messages; each one counts toward the person's rate limit. */
export const MAX_BATCH_MESSAGES = 10;
/** The SDK transport's own default cap, applied here because the body is read before the transport sees it. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const REMOTE_RELOGIN = `${LOGIN_HINTS.remote.charAt(0).toUpperCase()}${LOGIN_HINTS.remote.slice(1)}.`;

function jsonRpcError(status: number, message: string, headers: Record<string, string> = {}, code = -32000): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function familyMember(props: unknown): FamilyProps | null {
  if (typeof props !== "object" || props === null) return null;
  const p = props as Record<string, unknown>;
  if (typeof p.email !== "string" || p.email === "") return null;
  return { email: p.email.toLowerCase(), name: typeof p.name === "string" ? p.name : p.email };
}

async function remoteAuthStatus(account: AccountRpc, config: SkylightConfig, frames: FrameResolver): Promise<AuthStatusReport> {
  const s = await account.status();
  const credential = s.credentialError !== null ? { error: s.credentialError }
    : s.loggedIn && s.tokenExpiresAt !== null ? { expiresAt: Date.parse(s.tokenExpiresAt) } : null;
  return buildAuthStatus({ config, frames, credential, loginHint: LOGIN_HINTS.remote, needsLogin: s.needsLogin });
}

export function createMcpHandler(deps: McpHandlerDeps) {
  return {
    async fetch(request: Request, env: RemoteEnv, ctx: { props?: unknown }): Promise<Response> {
      if (request.method !== "POST") {
        // Stateless JSON server: no SSE stream to GET, no session to DELETE.
        return new Response(null, { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
      }
      const who = familyMember(ctx.props);
      if (who === null) return jsonRpcError(403, "This sign-in has no family member attached. Reconnect the app.");
      let allowlist: string[];
      try { allowlist = parseAllowlist(env.ALLOWED_EMAILS); } catch { return jsonRpcError(503, "The family server is not fully set up (ALLOWED_EMAILS)."); }
      if (!isAllowed(who.email, true, allowlist)) return jsonRpcError(403, "This Google account is no longer on the family list.");

      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > MAX_BODY_BYTES) return jsonRpcError(413, "The request body is too large.");
      const text = await request.text();
      if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return jsonRpcError(413, "The request body is too large.");
      let body: unknown;
      try { body = JSON.parse(text); } catch { return jsonRpcError(400, "Parse error: the request body is not JSON.", {}, -32700); }
      const messages = Array.isArray(body) ? body.length : 1;
      if (messages > MAX_BATCH_MESSAGES) return jsonRpcError(400, `A batch may hold at most ${MAX_BATCH_MESSAGES} messages.`, {}, -32600);

      const account = deps.account(env);
      if (!(await account.allow(who.email, "mcp", Math.max(1, messages)))) {
        return jsonRpcError(429, "Too many requests: the family server allows 300 calls per person every 10 minutes. Try again shortly.", { "Retry-After": "600" });
      }
      let config: SkylightConfig;
      try { config = configFromEnv(env); } catch (e) { return jsonRpcError(500, `The family server's settings are invalid: ${e instanceof Error ? e.message : String(e)}`); }

      const tokens: TokenProvider = {
        getAccessToken: async () => unwrapToken(await account.getAccessToken()),
        refreshAfterRejection: async (rejected) => unwrapToken(await account.refreshAfterRejection(rejected)),
      };
      const fetchImpl = deps.fetch ?? ((...args: Parameters<typeof globalThis.fetch>) => fetch(...args));
      const client = createClient({ fetch: fetchImpl, config, tokens, reloginHint: REMOTE_RELOGIN });
      const frames = createFrameResolver({ client, configuredFrameId: config.frameId });
      const now = deps.now ?? (() => new Date());
      const toolCtx: ToolContext = {
        config, client, frames, now,
        authStatus: () => remoteAuthStatus(account, config, frames),
        audit: (entry) => account.appendAudit({ ...entry, at: now().toISOString(), who: who.email }),
        logError: deps.logError ?? workerErrorLogger(secretValues(env)),
      };
      const server = createServer(toolCtx);
      registerActivityTool(server, { account, config });
      // No sessionIdGenerator = stateless mode (the SDK's `sessionIdGenerator: undefined`, spelled for exactOptionalPropertyTypes).
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request, { parsedBody: body });
      } finally {
        await server.close();
      }
    },
  };
}
