import { isAllowedCimdClientId, isCimdClientId } from "./redirects.js";

/**
 * Checks that run before the OAuth provider sees a request: https only (localhost excepted, for wrangler dev);
 * per-client limits on the unauthenticated OAuth endpoints, plus one global budget for /register, using the Workers
 * Rate Limiting binding (counters live in Cloudflare's memory, so no storage writes); and a /token pre-filter that
 * refuses foreign CIMD client ids before the library would fetch their metadata. /mcp has its per-person limit in the
 * Durable Object; /admin its own.
 */

export const RATE_LIMIT_PERIOD_SECONDS = 60;

/** Path → the wrangler `ratelimits` binding that guards it and its limit per client address per minute. */
export const IP_RATE_LIMITS = {
  "/register": { binding: "RL_REGISTER", limit: 5 },
  "/authorize": { binding: "RL_AUTHORIZE", limit: 20 },
  "/callback": { binding: "RL_CALLBACK", limit: 20 },
  "/token": { binding: "RL_TOKEN", limit: 60 },
} as const;

/** Path → a binding with one constant key: a budget shared by every client address. */
export const GLOBAL_RATE_LIMITS = {
  "/register": { binding: "RL_REGISTER_GLOBAL", limit: 20 },
} as const;

export type RateLimitBinding =
  | (typeof IP_RATE_LIMITS)[keyof typeof IP_RATE_LIMITS]["binding"]
  | (typeof GLOBAL_RATE_LIMITS)[keyof typeof GLOBAL_RATE_LIMITS]["binding"];

/** The Workers Rate Limiting binding's shape (`env.RL_*.limit({ key })`). */
export interface RateLimiterLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export type EdgeEnv = Partial<Record<RateLimitBinding, RateLimiterLike>>;

type Rule = { binding: RateLimitBinding; limit: number };

const LOCAL_DEV_HOSTS: readonly string[] = ["localhost", "127.0.0.1"];
const GLOBAL_KEY = "global";
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** Expands an IPv6 address to its eight 16-bit groups, or null when it is not one. */
function ipv6Groups(raw: string): number[] | null {
  let addr = raw.split("%")[0]!.toLowerCase();
  const lastColon = addr.lastIndexOf(":");
  const tail = addr.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!IPV4.test(tail)) return null;
    const [a, b, c, d] = tail.split(".").map(Number) as [number, number, number, number];
    addr = `${addr.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

/** The rate-limit key for a client address: an IPv4 address in full, an IPv6 address by its /64. */
export function rateLimitKey(ip: string | null): string {
  if (!ip) return "unknown";
  const trimmed = ip.trim();
  if (IPV4.test(trimmed)) return trimmed;
  const groups = ipv6Groups(trimmed);
  if (groups === null) return "unknown";
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 0xff}.${groups[7]! >> 8}.${groups[7]! & 0xff}`;
  }
  return `${groups.slice(0, 4).map((g) => g.toString(16)).join(":")}::/64`;
}

/** Every client id a token request names: the form body's client_id and the Basic auth user (RFC 6749 2.3.1). */
export async function tokenRequestClientIds(request: Request): Promise<string[]> {
  const ids: string[] = [];
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (type === "" || type.startsWith("application/x-www-form-urlencoded")) {
    try {
      const formId = new URLSearchParams(await request.clone().text()).get("client_id");
      if (formId) ids.push(formId);
    } catch { /* unreadable body: the library will answer */ }
  }
  const basic = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(request.headers.get("authorization") ?? "");
  if (basic) {
    try {
      const decoded = atob(basic[1]!);
      const user = decoded.slice(0, decoded.includes(":") ? decoded.indexOf(":") : decoded.length);
      if (user) ids.push(decodeURIComponent(user.replace(/\+/g, " ")));
    } catch { /* malformed: the library will answer */ }
  }
  return ids;
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers } });
}

async function allowed(limiter: RateLimiterLike, key: string, path: string): Promise<boolean> {
  try {
    return (await limiter.limit({ key })).success;
  } catch (e) {
    // The limiter is a second line of defence behind OAuth; an outage of it should not take sign-in down.
    console.error(`[skylight-mcp] rate limiter unavailable for ${path}: ${e instanceof Error ? e.name : "error"}`);
    return true;
  }
}

/** A response to send instead of handling the request, or null to carry on. */
export async function edgeGuard(request: Request, env: EdgeEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.protocol !== "https:" && !LOCAL_DEV_HOSTS.includes(url.hostname)) return text(400, "Use https.");

  const perClient = (IP_RATE_LIMITS as Record<string, Rule | undefined>)[url.pathname];
  const global = (GLOBAL_RATE_LIMITS as Record<string, Rule | undefined>)[url.pathname];
  const checks: Array<[Rule, string]> = [];
  if (perClient) checks.push([perClient, rateLimitKey(request.headers.get("CF-Connecting-IP"))]);
  if (global) checks.push([global, GLOBAL_KEY]);
  for (const [rule, key] of checks) {
    const limiter = env[rule.binding];
    if (!limiter) return text(503, "This server is missing its rate limiter configuration.");
    if (!(await allowed(limiter, key, url.pathname))) {
      return text(429, "Too many requests. Try again in a minute.", { "Retry-After": String(RATE_LIMIT_PERIOD_SECONDS) });
    }
  }

  if (url.pathname === "/token" && request.method === "POST") {
    const foreign = (await tokenRequestClientIds(request)).some((id) => isCimdClientId(id) && !isAllowedCimdClientId(id));
    if (foreign) {
      return new Response(JSON.stringify({ error: "invalid_client" }), { status: 401, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
  }
  return null;
}
