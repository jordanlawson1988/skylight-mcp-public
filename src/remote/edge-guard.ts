/**
 * Checks that run before the OAuth provider sees a request: https only (localhost excepted, for wrangler dev) and
 * per-IP limits on the unauthenticated OAuth endpoints, using the Workers Rate Limiting binding (counters live in
 * Cloudflare's memory, so no storage writes). /mcp has its per-person limit in the Durable Object; /admin its own.
 */

export const RATE_LIMIT_PERIOD_SECONDS = 60;

/** Path → the wrangler `ratelimits` binding that guards it and its limit per IP per minute. */
export const IP_RATE_LIMITS = {
  "/register": { binding: "RL_REGISTER", limit: 5 },
  "/authorize": { binding: "RL_AUTHORIZE", limit: 20 },
  "/callback": { binding: "RL_CALLBACK", limit: 20 },
  "/token": { binding: "RL_TOKEN", limit: 60 },
} as const;

export type RateLimitBinding = (typeof IP_RATE_LIMITS)[keyof typeof IP_RATE_LIMITS]["binding"];

/** The Workers Rate Limiting binding's shape (`env.RL_*.limit({ key })`). */
export interface RateLimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type EdgeEnv = Partial<Record<RateLimitBinding, RateLimiterLike>>;

const LOCAL_DEV_HOSTS: readonly string[] = ["localhost", "127.0.0.1"];

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

/** A response to send instead of handling the request, or null to carry on. */
export async function edgeGuard(request: Request, env: EdgeEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.protocol !== "https:" && !LOCAL_DEV_HOSTS.includes(url.hostname)) return text(400, "Use https.");

  const rule = (IP_RATE_LIMITS as Record<string, { binding: RateLimitBinding; limit: number } | undefined>)[url.pathname];
  if (rule === undefined) return null;
  const limiter = env[rule.binding];
  if (!limiter) return text(503, "This server is missing its rate limiter configuration.");
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
  let allowed: boolean;
  try {
    allowed = (await limiter.limit({ key: ip })).success;
  } catch (e) {
    // The limiter is a second line of defence behind OAuth; an outage of it should not take sign-in down.
    console.error(`[skylight-mcp] rate limiter unavailable for ${url.pathname}: ${e instanceof Error ? e.name : "error"}`);
    allowed = true;
  }
  return allowed ? null : text(429, "Too many requests. Try again in a minute.", { "Retry-After": String(RATE_LIMIT_PERIOD_SECONDS) });
}
