export interface MockRoute {
  method: string;
  path: string | RegExp;
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  handler?: (req: { url: URL; init: RequestInit; body: unknown }) => { status?: number; json?: unknown; text?: string };
}

export interface RecordedCall { method: string; url: URL; headers: Headers; body: unknown }

export function createMockFetch(routes: MockRoute[]) {
  const calls: RecordedCall[] = [];
  const fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    let body: unknown = null;
    if (typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    } else if (init.body instanceof URLSearchParams) {
      body = Object.fromEntries(init.body.entries());
    }
    calls.push({ method, url, headers, body });
    const route = routes.find(
      (r) => r.method.toUpperCase() === method &&
        (typeof r.path === "string" ? r.path === url.pathname : r.path.test(url.pathname))
    );
    if (!route) return new Response(`no mock for ${method} ${url.pathname}`, { status: 599 });
    const out = route.handler ? route.handler({ url, init, body }) : route;
    const status = out.status ?? route.status ?? 200;
    const text = out.json !== undefined ? JSON.stringify(out.json) : (out.text ?? "");
    return new Response(text, { status, headers: { "content-type": "application/json", ...(route.headers ?? {}) } });
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}
