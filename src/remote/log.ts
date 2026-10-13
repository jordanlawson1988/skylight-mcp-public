import { excerpt } from "../skylight/redact.js";

/** One line for the Worker's logs: name and message only (no stack), secrets masked, at most 300 characters. */
export function describeError(e: unknown, secrets: readonly string[]): string {
  return excerpt(e instanceof Error ? `${e.name}: ${e.message}` : String(e), secrets, 300);
}

/** ctx.logError for the Worker: unexpected tool errors are logged through describeError. */
export function workerErrorLogger(secrets: readonly string[]): (e: unknown) => void {
  return (e) => { console.error(`[skylight-mcp] unexpected error: ${describeError(e, secrets)}`); };
}
