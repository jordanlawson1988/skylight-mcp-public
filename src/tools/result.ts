import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AuthError, SkylightApiError, ValidationError } from "../skylight/errors.js";

export const ANNOTATIONS = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  create: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  update: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  mutate: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  destroy: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
} as const;

export function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof ValidationError) return fail(`Invalid input. ${e.message}`);
    if (e instanceof AuthError) return fail(e.message);
    if (e instanceof SkylightApiError) return fail(e.message);
    process.stderr.write(`[skylight-mcp] unexpected error: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    return fail("Unexpected error inside skylight-mcp. See the server log.");
  }
}

/** Why a bulk loop should stop trying further items (login rejected, rate limited), or null to keep going. */
export function stopReason(e: unknown): string | null {
  if (e instanceof AuthError) return "authentication failed";
  if (e instanceof SkylightApiError && e.status === 429) return "rate limited by Skylight";
  return null;
}
