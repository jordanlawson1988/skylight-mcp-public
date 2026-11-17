import { MCP_SCOPE, familyLabel } from "./env.js";
import { clientRegistrationCallback } from "./redirects.js";

/**
 * The OAuth policy given to @cloudflare/workers-oauth-provider for one origin (worker.ts adds the handlers). Kept free
 * of the library import so Node tests can check it.
 */
export function providerPolicy(origin: string, familyName?: string) {
  const label = familyLabel(familyName);
  return {
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: [MCP_SCOPE],
    accessTokenTTL: 3600,
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationCallback,
    resourceMetadata: {
      resource: `${origin}/mcp`,
      scopes_supported: [MCP_SCOPE],
      resource_name: label[0]!.toUpperCase() + label.slice(1),
    },
    onError: ({ status, code }: { status: number; code: string }) => { console.warn(JSON.stringify({ oauthError: code, status })); },
  };
}
