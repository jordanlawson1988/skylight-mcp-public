import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { AccountRpc } from "./account-core.js";
import { SkylightAccount } from "./account-do.js";
import { handleAdmin } from "./admin.js";
import { edgeGuard, type RateLimitBinding } from "./edge-guard.js";
import { ACCOUNT_OBJECT_NAME, secretValues, type RemoteEnv } from "./env.js";
import { handleAuthorize, handleCallback, type OAuthApi } from "./google.js";
import type { IdentityKv } from "./identity.js";
import { describeError } from "./log.js";
import { createMcpHandler } from "./mcp-handler.js";
import { providerPolicy } from "./provider-options.js";

export { SkylightAccount };

/**
 * The shared skylight-mcp server on Cloudflare Workers. @cloudflare/workers-oauth-provider is the OAuth 2.1
 * authorization server for Claude and ChatGPT (discovery, /token, /register, CIMD) and guards /mcp; everything else
 * (the Google sign-in pages, /admin, /health) is the defaultHandler below.
 */

interface Env extends RemoteEnv, Record<RateLimitBinding, RateLimit> {
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

/** Google sub bindings live in OAUTH_KV next to the provider's own records (prefix identity:). */
function identitiesFor(env: RemoteEnv): IdentityKv {
  const kv = (env as Env).OAUTH_KV;
  return { get: (key) => kv.get(key), put: (key, value) => kv.put(key, value), delete: (key) => kv.delete(key) };
}

const mcp = createMcpHandler({ account: accountFor });

const apiHandler: ExportedHandler<Env> & { fetch: NonNullable<ExportedHandler<Env>["fetch"]> } = {
  fetch: (request, env, ctx) => mcp.fetch(request, env, ctx as unknown as { props?: unknown }),
};

const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const deps = { oauth: oauthFor(env), env, fetch: (...args: Parameters<typeof fetch>) => fetch(...args), now: () => Date.now(), identities: identitiesFor(env) };
    if (url.pathname === "/authorize") return handleAuthorize(request, deps);
    if (url.pathname === "/callback" && request.method === "GET") return handleCallback(request, deps);
    if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return handleAdmin(request, env, { account: accountFor, oauth: oauthFor, identities: identitiesFor });
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
    provider = new OAuthProvider<Env>({ apiRoute: "/mcp", apiHandler, defaultHandler, ...providerPolicy(origin) });
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
      // https only, and per-IP limits on /register, /authorize, /callback and /token, before the provider runs.
      const refused = await edgeGuard(request, env);
      if (refused) {
        status = refused.status;
        return refused;
      }
      // A shallow copy per request: the provider attaches OAUTH_PROVIDER to the env it is given.
      const response = await providerFor(url.origin).fetch(request, { ...env } as Env, ctx);
      status = response.status;
      return response;
    } catch (e) {
      console.error(JSON.stringify({ method: request.method, path: url.pathname, error: describeError(e, secretValues(env)) }));
      return new Response("Internal error", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
    } finally {
      // Method, path (never the query), status, duration. No headers, no bodies.
      console.log(JSON.stringify({ method: request.method, path: url.pathname, status, ms: Date.now() - started }));
    }
  },
} satisfies ExportedHandler<Env>;
