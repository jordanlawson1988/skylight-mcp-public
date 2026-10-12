import type { TokenProvider } from "./auth.js";
import type { SkylightConfig } from "./config.js";
import { AuthError, SkylightApiError, ValidationError } from "./errors.js";
import { excerpt } from "./redact.js";

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RequestOptions {
  method: Method;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface SkylightClient {
  request<T = unknown>(opts: RequestOptions): Promise<T>;
}

export type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Reads wait before the single retry: Retry-After seconds capped at 2s, else 500ms. */
const RETRY_DEFAULT_MS = 500;
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const RETRY_CAP_SECONDS = 2;
function retryDelayMs(res: Response): number {
  const raw = res.headers.get("retry-after")?.trim();
  return raw !== undefined && /^\d+(\.\d+)?$/.test(raw) ? Math.min(Number(raw), RETRY_CAP_SECONDS) * 1000 : RETRY_DEFAULT_MS;
}

/** What to tell the user when Skylight keeps rejecting the credential; the shared server names its own login command. */
export const DEFAULT_RELOGIN_HINT = "Run `skylight-mcp login` again.";

export function createClient(opts: { fetch: typeof globalThis.fetch; config: SkylightConfig; tokens: TokenProvider; sleep?: Sleep; reloginHint?: string }): SkylightClient {
  const { config } = opts;
  const reloginHint = opts.reloginHint ?? DEFAULT_RELOGIN_HINT;
  const sleep = opts.sleep ?? defaultSleep;

  async function send(url: string, init: RequestInit, token: string): Promise<{ res: Response; text: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const res = await opts.fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` }, signal: controller.signal });
      return { res, text: await res.text() };
    } catch (e) {
      if (controller.signal.aborted) throw new SkylightApiError(0, init.method ?? "GET", new URL(url).pathname, `Request timed out after ${config.requestTimeoutMs}ms.`);
      throw new SkylightApiError(0, init.method ?? "GET", new URL(url).pathname, `Network error: ${excerpt(e instanceof Error ? e.message : String(e), [token])}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async request<T>(o: RequestOptions): Promise<T> {
      if (!/^\/(api|oauth)\//.test(o.path)) throw new ValidationError("path", "must begin with /api/ or /oauth/");
      const url = new URL(o.path, config.apiBaseUrl);
      for (const [k, v] of Object.entries(o.query ?? {})) {
        if (v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
      const headers: Record<string, string> = { accept: "application/json", "Skylight-Api-Version": config.apiVersion };
      const init: RequestInit = { method: o.method, headers };
      if (o.body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(o.body);
      }

      let token = await opts.tokens.getAccessToken();
      const secrets = [token];
      let { res, text } = await send(url.toString(), init, token);
      if (res.status === 401) {
        token = await opts.tokens.refreshAfterRejection(token);
        secrets.push(token);
        ({ res, text } = await send(url.toString(), init, token));
        if (res.status === 401) throw new AuthError(`Skylight rejected the credentials after a refresh. ${reloginHint}`);
      }
      // Reads are safe to repeat: retry once on 429, 500, 502, 503 or 504. Writes are never retried (they could duplicate).
      if (o.method === "GET" && RETRYABLE_STATUSES.has(res.status)) {
        await sleep(retryDelayMs(res));
        ({ res, text } = await send(url.toString(), init, token));
      }
      if (!res.ok) {
        const retryAfter = res.headers.get("retry-after");
        const hint = res.status === 429 && retryAfter ? ` Retry after ${excerpt(retryAfter, secrets)} seconds.` : "";
        const body = excerpt(text, secrets);
        throw new SkylightApiError(res.status, o.method, o.path, `Skylight returned ${res.status} for ${o.method} ${o.path}${body ? `: ${body}` : ""}.${hint}`);
      }
      if (text.trim().length === 0) return null as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new SkylightApiError(res.status, o.method, o.path, `Skylight returned non-JSON for ${o.method} ${o.path}.`);
      }
    },
  };
}
