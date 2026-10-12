import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { excerpt } from "../skylight/redact.js";
import type { AuditEntry } from "./context.js";

const ID_ARGUMENT = /(?:Id|Ids)$/;
const ID_VALUE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_AUDIT_TARGETS = 20;
export const MAX_AUDIT_ERROR_LENGTH = 200;

/** The id arguments of a call (keys ending in Id or Ids), id-shaped values only, at most MAX_AUDIT_TARGETS. */
export function auditTargets(args: unknown): string[] {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (!ID_ARGUMENT.test(key)) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      const text = typeof v === "string" ? v : typeof v === "number" && Number.isSafeInteger(v) ? String(v) : null;
      if (text !== null && ID_VALUE.test(text)) out.push(text);
      if (out.length >= MAX_AUDIT_TARGETS) return out;
    }
  }
  return out;
}

/** Short, single-line, token-free error text for the activity log. */
export function auditError(text: string): string {
  return excerpt(text, [], MAX_AUDIT_ERROR_LENGTH);
}

function resultText(result: CallToolResult): string {
  const first = result.content?.find((c) => c.type === "text");
  return first && first.type === "text" ? first.text : "";
}

/** Turns a finished call into its audit entry: previews (confirmed: false, dryRun: true) are marked, errors shortened. */
export function auditEntry(tool: string, args: unknown, result: CallToolResult): AuditEntry {
  const entry: AuditEntry = { tool, targets: auditTargets(args), ok: result.isError !== true };
  if (result.isError === true) {
    entry.error = auditError(resultText(result));
    return entry;
  }
  try {
    const data = JSON.parse(resultText(result)) as Record<string, unknown> | null;
    if (data && typeof data === "object" && (data.confirmed === false || data.dryRun === true)) entry.preview = true;
  } catch { /* not JSON: nothing to mark */ }
  return entry;
}
