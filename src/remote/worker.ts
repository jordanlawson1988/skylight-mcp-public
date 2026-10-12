import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { excerpt } from "../skylight/redact.js";
import type { AccountRpc } from "./account-core.js";
import { ACCOUNT_OBJECT_NAME, SkylightAccount } from "./account-do.js";
import { handleAdmin } from "./admin.js";
import { MCP_SCOPE, secretValues, type RemoteEnv } from "./env.js";
import { handleAuthorize, handleCallback, type OAuthApi } from "./google.js";
import { createMcpHandler } from "./mcp-handler.js";

export { SkylightAccount };

/**
 * The shared skylight-mcp server on Cloudflare Workers. @cloudflare/workers-oauth-provider is the OAuth 2.1
 * authorization server for Claude and ChatGPT (discovery, /token, /register, CIMD) and guards /mcp; everything else
 * (the Google sign-in pages, /admin, /health) is the defaultHandler below.
 */

interface Env extends RemoteEnv {
  OAUTH_KV: KVNamespace;
  SKYLIGHT_ACCOUNT: DurableObjectNamespace<SkylightAccount>;
  /** Set by the provider before it calls a handler. */
  OAUTH_PROVIDER: OAuthHelpers;
}

function accountFor(env: RemoteEnv): AccountRpc {
  const ns = (env as Env).SKYLIGHT_ACCOUNT;
  // The stub's RPC methods are SkylightAccount's, which implements AccountRpc; the cast only drops RPC wrapper types.
  return ns.get(ns.idFromName(ACCOUNT_OBJECT_NAME)) as unknown as AccountRpc;
}

/** The library's helpers, checked against the subset google.ts and admin.ts rely on. */
function oauthFor(env: RemoteEnv): OAuthApi {
  const helpers: OAuthApi = (env as Env).OAUTH_PROVIDER;
  return helpers;
}

const mcp = createMcpHandler({ account: accountFor });

const apiHandler: ExportedHandler<Env> & { fetch: NonNullable<ExportedHandler<Env>["fetch"]> } = {
  fetch: (request, env, ctx) => mcp.fetch(request, env, ctx as unknown as { props?: unknown }),
};

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const deps = { oauth: oauthFor(env), env, fetch: (...args: Parameters<typeof fetch>) => fetch(...args), now: () => Date.now() };
    if (url.pathname === "/authorize") return handleAuthorize(request, deps);
    if (url.pathname === "/callback" && request.method === "GET") return handleCallback(request, deps);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return handleAdmin(request, env, { account: accountFor, oauth: oauthFor });
    if (url.pathname === "/health" && request.method === "GET") return Response.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  },
};

/**
 * One provider per origin: its resource (the token audience) must be this server's own https://<host>/mcp, and the
 * workers.dev host is only known from the request. (The library derives the issuer from the request origin the same way.)
 */
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler,
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: [MCP_SCOPE],
      accessTokenTTL: 3600,
      clientIdMetadataDocumentEnabled: true,
      resourceMetadata: {
        resource: `${origin}/mcp`,
        scopes_supported: [MCP_SCOPE],
        resource_name: "Lawson family Skylight",
      },
      onError: ({ status, code }) => { console.warn(JSON.stringify({ oauthError: code, status })); },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    let status = 500;
    try {
      // A shallow copy per request: the provider attaches OAUTH_PROVIDER to the env it is given.
      const response = await providerFor(url.origin).fetch(request, { ...env } as Env, ctx);
      status = response.status;
      return response;
    } catch (e) {
      console.error(JSON.stringify({ method: request.method, path: url.pathname, error: excerpt(e instanceof Error ? `${e.name}: ${e.message}` : String(e), secretValues(env), 300) }));
      return new Response("Internal error", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    } finally {
      // Method, path (never the query), status, duration. No headers, no bodies.
      console.log(JSON.stringify({ method: request.method, path: url.pathname, status, ms: Date.now() - started }));
    }
  },
} satisfies ExportedHandler<Env>;
