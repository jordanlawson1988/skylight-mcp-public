import type { AuthRequest, ClientInfo, OAuthApi } from "../../src/remote/google.js";

/** A stand-in for the library's env.OAUTH_PROVIDER helpers: single-use handles and states, recorded completions. */
export function createFakeOAuth(opts: { client?: Partial<ClientInfo> | null; parseError?: Error; request?: Partial<AuthRequest> } = {}) {
  const request: AuthRequest = {
    responseType: "code", clientId: "client-1", redirectUri: "https://claude.ai/api/mcp/auth_callback", scope: ["skylight"],
    state: "client-state", codeChallenge: "challenge", codeChallengeMethod: "S256", resource: "https://example.test/mcp", issuer: "https://example.test",
    ...(opts.request ?? {}),
  };
  const client: ClientInfo | null = opts.client === null ? null : { clientId: request.clientId, clientName: "Claude", redirectUris: [request.redirectUri], tokenEndpointAuthMethod: "none", ...(opts.client ?? {}) };
  const counts = { parse: 0, consent: 0 };
  const consents = new Set<string>();
  const upstreams = new Map<string, { request: AuthRequest; data: unknown }>();
  const completed: Array<{ userId: string; scope: string[]; props: unknown; metadata: unknown }> = [];
  const revoked: Array<{ grantId: string; userId: string }> = [];
  const grants = new Map<string, string[]>();
  let n = 0;
  const authError = (description: string) => Object.assign(new Error(description), { name: "AuthorizationError", code: "invalid_request", description });
  const oauth: OAuthApi = {
    async parseAuthRequest() { counts.parse += 1; if (opts.parseError) throw opts.parseError; return request; },
    async lookupClient(id) { return client && id === client.clientId ? client : null; },
    async beginConsent() { counts.consent += 1; const handle = `handle-${++n}`; consents.add(handle); return { handle, headers: new Headers({ "Set-Cookie": `__Host-oauth-consent=${handle}`, "X-Frame-Options": "DENY" }) }; },
    async approveConsent(_req, handle, o) {
      if (!consents.delete(handle)) throw authError("consent handle missing or used");
      return { request: { ...request, scope: o?.scope ?? request.scope }, headers: new Headers({ "Cache-Control": "no-store" }) };
    },
    async denyConsent(_req, handle) {
      if (!consents.delete(handle)) throw authError("consent handle missing or used");
      const to = `${request.redirectUri}?error=access_denied&state=${request.state}`;
      return { request, redirectTo: to, headers: new Headers({ Location: to }) };
    },
    async beginUpstream(req, o) {
      const state = `state-${++n}`;
      upstreams.set(state, { request: req, data: o?.data });
      const headers = o?.headers ?? new Headers();
      headers.append("Set-Cookie", `__Host-oauth-upstream=${state}`);
      return { state, headers };
    },
    async finishUpstream<Data>(req: Request) {
      const state = new URL(req.url).searchParams.get("state") ?? "";
      const found = upstreams.get(state);
      if (!found) throw authError("state missing, expired or used");
      upstreams.delete(state);
      return { request: found.request, data: found.data as Data, headers: new Headers({ "Cache-Control": "no-store" }) };
    },
    async completeAuthorization(o) {
      completed.push({ userId: o.userId, scope: o.scope, props: o.props, metadata: o.metadata });
      return { redirectTo: `${o.request.redirectUri}?code=MCP-CODE&state=${o.request.state}&iss=https%3A%2F%2Fexample.test` };
    },
    async listUserGrants(userId, o) {
      const ids = grants.get(userId) ?? [];
      const start = o?.cursor ? Number(o.cursor) : 0;
      const page = ids.slice(start, start + 2);
      const next = start + 2 < ids.length ? String(start + 2) : undefined;
      return { items: page.map((id) => ({ id, clientId: "client-1", userId, scope: ["skylight"], metadata: {}, createdAt: 0 })), ...(next ? { cursor: next } : {}) };
    },
    async revokeGrant(grantId, userId) { revoked.push({ grantId, userId }); },
  };
  return { oauth, request, consents, upstreams, completed, revoked, grants, counts };
}
