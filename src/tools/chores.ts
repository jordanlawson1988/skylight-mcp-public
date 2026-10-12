import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildChoreCreateBody, buildChoreUpdateBody, type ChoreInput } from "../skylight/chore-payload.js";
import { AuthError, SkylightApiError, ValidationError } from "../skylight/errors.js";
import { assertDate, assertId, assertTime, localDateString, parseChoreId } from "../skylight/ids.js";
import { FREQUENCIES, WEEKDAYS } from "../skylight/rrule.js";
import { mapChore, mapChores, type Chore } from "../skylight/types.js";
import { CHORE_STATUS, EXPOSED_APPLY_TO_VALUES, EXPOSED_UPDATE_APPLY_TO_VALUES, ROUTINE_SLOT_NAMES } from "../skylight/vocab.js";
import type { ToolContext } from "./context.js";
import { ANNOTATIONS, run } from "./result.js";

export const MAX_BULK = 50;

export const recurrenceShape = z.object({
  frequency: z.enum(FREQUENCIES).describe("daily, weekly or monthly"),
  interval: z.number().int().min(1).max(52).optional().describe("Every N periods. Default 1."),
  weekdays: z.array(z.enum(WEEKDAYS)).optional().describe("Weekly only. Days of week, e.g. [\"MO\",\"WE\"]."),
  monthDay: z.number().int().min(1).max(31).optional().describe("Monthly only. Day of month."),
  until: z.string().optional().describe("Last date YYYY-MM-DD. Omit for no end."),
});

export const choreInputShape = {
  summary: z.string().describe("Chore title, e.g. \"Feed the dog\"."),
  start: z.string().optional().describe("First date YYYY-MM-DD. Required unless upForGrabs is true (up-for-grabs chores may have no date)."),
  profileIds: z.array(z.string()).min(1).max(20).optional().describe("Profile ids from skylight_list_profiles. One chore is created per profile. Required unless upForGrabs is true (then omit it for an unassigned chore anyone can claim)."),
  startTime: z.string().optional().describe("HH:mm 24-hour. Not allowed on routine steps."),
  recurrence: recurrenceShape.optional().describe("Omit for a one-off chore."),
  routine: z.boolean().optional().describe("true makes this a routine step instead of a chore (needs timeOfDay, no startTime; recurrence defaults to daily). Default false."),
  timeOfDay: z.enum(ROUTINE_SLOT_NAMES).optional().describe("Routine steps only: which routine the step belongs to. Required when routine is true."),
  upForGrabs: z.boolean().optional().describe("true lets any profile claim it; start and profileIds then become optional. Default false."),
  rewardPoints: z.number().int().optional().describe("Points earned on completion."),
  emoji: z.string().optional().describe("Single emoji icon."),
  description: z.string().optional().describe("Longer details shown on the chore, up to 500 characters."),
  timerSeconds: z.number().int().min(0).max(86400).optional().describe("Countdown timer length in seconds (0-86400)."),
};

const deleteApplyToSchema = z.enum(EXPOSED_APPLY_TO_VALUES as [string, ...string[]]).optional()
  .describe("Scope for a recurring chore. \"one\" = only that occurrence, \"future\" = that occurrence and all later ones (both need the occurrence date), \"all\" = the whole series. Omit for one-time chores.");
const updateApplyToSchema = z.enum(EXPOSED_UPDATE_APPLY_TO_VALUES as [string, ...string[]]).optional()
  .describe("\"all\" = apply to the whole recurring series. Omit for one-off chores. (Per-occurrence scopes are not available for update.)");

function choresPath(frameId: string): string {
  return `/api/frames/${frameId}/chores`;
}

async function createOne(ctx: ToolContext, frameId: string, input: ChoreInput): Promise<Chore[]> {
  const body = buildChoreCreateBody(input);
  const json = await ctx.client.request<unknown>({ method: "POST", path: `${choresPath(frameId)}/create_multiple`, body });
  const created = mapChores(json);
  if (created.length > 0) return created;
  const single = mapChore((json as { data?: unknown } | null)?.data);
  return single ? [single] : [];
}

const NO_IDS_WARNING = "Skylight returned no chore ids; list chores to confirm.";

function stopReason(e: unknown): string | null {
  if (e instanceof AuthError) return "authentication failed";
  if (e instanceof SkylightApiError && e.status === 429) return "rate limited by Skylight";
  return null;
}

async function findChoreSummary(ctx: ToolContext, frameId: string, choreId: string, seriesId: string, date: string | null): Promise<string | null> {
  let after: string;
  let before: string;
  if (date !== null) {
    after = date; before = date;
  } else {
    const now = new Date();
    const lo = new Date(now); lo.setDate(lo.getDate() - 30);
    const hi = new Date(now); hi.setDate(hi.getDate() + 60);
    after = localDateString(lo); before = localDateString(hi);
  }
  try {
    const chores = mapChores(await ctx.client.request({ method: "GET", path: choresPath(frameId), query: { after, before, include_late: false, include_up_for_grabs: true, filter: "linked_to_profile" } }));
    const hit = chores.find((c) => c.id === choreId) ?? chores.find((c) => c.id === seriesId || c.seriesId === seriesId);
    return hit?.summary ?? null;
  } catch {
    return null;
  }
}

/** Resolve the occurrence date from a composite choreId and/or an explicit instanceDate. */
function resolveInstanceDate(refDate: string | null, instanceDate: string | undefined): string | null {
  const explicit = instanceDate === undefined ? null : assertDate(instanceDate, "instanceDate");
  if (refDate !== null && explicit !== null && refDate !== explicit) {
    throw new ValidationError("instanceDate", "does not match the date in choreId");
  }
  return refDate ?? explicit;
}

/** Resolve the occurrence time from a time-suffixed choreId and/or an explicit instanceTime. */
function resolveInstanceTime(refTime: string | null, instanceTime: string | undefined): string | null {
  const explicit = instanceTime === undefined ? null : assertTime(instanceTime, "instanceTime");
  if (refTime !== null && explicit !== null && refTime !== explicit) {
    throw new ValidationError("instanceTime", "does not match the time in choreId");
  }
  return refTime ?? explicit;
}

/** Turn Skylight's two instance_date 422s into actionable validation errors; anything else passes through. */
function mapCompletionError(e: unknown): unknown {
  if (e instanceof SkylightApiError && e.status === 422 && e.message.includes("instance_date")) {
    if (e.message.includes("can't be blank")) return new ValidationError("instanceDate", "this chore is recurring; pass the occurrence date");
    if (e.message.includes("must be blank")) return new ValidationError("instanceDate", "this is a one-time chore; omit instanceDate");
  }
  return e;
}

const DELETE_SCOPE_TEXT = {
  all: "every occurrence of this recurring chore",
  future: "this occurrence and all later ones",
  one: "only this occurrence",
  none: "this chore",
} as const;

export function registerChoreTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "skylight_list_chores",
    {
      title: "List chores",
      description: "List chores and routine steps in a date range (default: today through 14 days ahead). Returns ids needed for update, complete and delete. Recurring occurrences carry a seriesId, an instanceDate (set only for recurring occurrences, null for one-time chores) and, for routine steps, an instanceTime. Ids may be a plain series id, `series-date` or `series-date-HHMM` (routine steps, e.g. 60913118-2026-10-12-0600): passing the id exactly as returned by this list is enough for complete, update and delete.",
      inputSchema: {
        after: z.string().optional().describe("Start date YYYY-MM-DD (inclusive). Default today."),
        before: z.string().optional().describe("End date YYYY-MM-DD (inclusive). Default 14 days from today."),
        includeLate: z.boolean().optional().describe("Also return overdue (late) occurrences from before the window. Default false; can be large."),
        includeUpForGrabs: z.boolean().optional().describe("Include unassigned up-for-grabs chores (upForGrabs: true, no profileIds; completedByProfileId once claimed). Default true."),
      },
      annotations: ANNOTATIONS.read,
    },
    (args) => run(async () => {
      const today = localDateString();
      const after = assertDate(args.after ?? today, "after");
      const before = assertDate(args.before ?? new Date(Date.parse(`${after}T00:00:00Z`) + 14 * 86_400_000).toISOString().slice(0, 10), "before");
      if (after > before) throw new ValidationError("after", "must not be later than before");
      const frameId = await ctx.frames.resolve();
      const chores = mapChores(await ctx.client.request({
        method: "GET", path: choresPath(frameId),
        query: { after, before, include_late: args.includeLate ?? false, include_up_for_grabs: args.includeUpForGrabs ?? true, filter: "linked_to_profile" },
      }));
      // One-time chores have no instanceDate; fall back to their start date so they sort with the rest.
      const key = (c: Chore) => c.instanceDate ?? c.start;
      return chores.sort((a, b) => {
        const ka = key(a), kb = key(b);
        if (ka !== kb) {
          if (ka === null) return 1;
          if (kb === null) return -1;
          return ka < kb ? -1 : 1;
        }
        return a.summary < b.summary ? -1 : a.summary > b.summary ? 1 : 0;
      });
    })
  );

  server.registerTool(
    "skylight_create_chore",
    {
      title: "Create a chore or routine step",
      description: "Create one chore (or routine step with routine: true plus timeOfDay) assigned to one or more profiles. For a chore anyone can claim, set upForGrabs: true and omit profileIds (start is then optional too). For many chores at once use skylight_bulk_create_chores.",
      inputSchema: choreInputShape,
      annotations: ANNOTATIONS.create,
    },
    (args) => run(async () => {
      const created = await createOne(ctx, await ctx.frames.resolve(), args as ChoreInput);
      return { created, ids: created.map((c) => c.id), ...(created.length === 0 ? { warning: NO_IDS_WARNING } : {}) };
    })
  );

  server.registerTool(
    "skylight_bulk_create_chores",
    {
      title: "Bulk create chores and routines",
      description: `Create up to ${MAX_BULK} chores or routine steps in one call. Every item is validated before any request; invalid items are reported without stopping the rest. Use dryRun: true first to show the user exactly what will be created.`,
      inputSchema: {
        chores: z.array(z.object(choreInputShape)).min(1).max(MAX_BULK),
        dryRun: z.boolean().optional().describe("true validates and returns the payloads without creating anything."),
      },
      annotations: ANNOTATIONS.create,
    },
    (args) => run(async () => {
      const results: Array<{ index: number; summary: string; ok: boolean; ids?: string[]; warning?: string; error?: string; payload?: unknown }> = [];
      const payloads = args.chores.map((c, index) => {
        try { return { index, payload: buildChoreCreateBody(c as ChoreInput) }; }
        catch (e) { return { index, error: e instanceof Error ? e.message : String(e) }; }
      });
      if (args.dryRun) {
        return { dryRun: true, valid: payloads.filter((p) => "payload" in p).length, invalid: payloads.filter((p) => "error" in p).length,
          results: payloads.map((p) => ({ index: p.index, summary: args.chores[p.index]!.summary, ok: !("error" in p), ...("payload" in p ? { payload: p.payload } : { error: p.error }) })) };
      }
      const frameId = await ctx.frames.resolve();
      let stop: string | null = null;
      for (const p of payloads) {
        const summary = args.chores[p.index]!.summary;
        if ("error" in p) { results.push({ index: p.index, summary, ok: false, error: p.error }); continue; }
        if (stop !== null) { results.push({ index: p.index, summary, ok: false, error: `not attempted: ${stop}` }); continue; }
        try {
          const created = await createOne(ctx, frameId, args.chores[p.index] as ChoreInput);
          results.push({ index: p.index, summary, ok: true, ids: created.map((c) => c.id), ...(created.length === 0 ? { warning: NO_IDS_WARNING } : {}) });
        } catch (e) {
          results.push({ index: p.index, summary, ok: false, error: e instanceof Error ? e.message : String(e) });
          stop = stopReason(e);
        }
      }
      return { dryRun: false, created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
    })
  );

  server.registerTool(
    "skylight_update_chore",
    {
      title: "Update a chore",
      description: "Change fields on an existing chore or routine step. Only the provided fields change. An update always changes the whole series: the date part of a composite choreId is ignored.",
      inputSchema: {
        choreId: z.string().describe("Chore id exactly as returned by skylight_list_chores: plain, series-date or series-date-HHMM."),
        summary: choreInputShape.summary.optional(),
        start: choreInputShape.start.optional(),
        profileIds: choreInputShape.profileIds.optional().describe("Replace the assigned profiles."),
        startTime: choreInputShape.startTime,
        recurrence: choreInputShape.recurrence,
        routine: choreInputShape.routine,
        timeOfDay: choreInputShape.timeOfDay,
        upForGrabs: choreInputShape.upForGrabs,
        rewardPoints: choreInputShape.rewardPoints,
        emoji: choreInputShape.emoji,
        description: choreInputShape.description,
        timerSeconds: choreInputShape.timerSeconds,
        applyTo: updateApplyToSchema,
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const { choreId, applyTo, ...rest } = args as Record<string, unknown> & { choreId: string; applyTo?: string };
      const { seriesId: id } = parseChoreId(choreId, "choreId");
      const body: Record<string, unknown> = buildChoreUpdateBody(rest as Partial<ChoreInput>);
      if (applyTo !== undefined) body.apply_to = applyTo;
      const frameId = await ctx.frames.resolve();
      const json = await ctx.client.request<unknown>({ method: "PUT", path: `${choresPath(frameId)}/${id}`, body });
      return mapChore((json as { data?: unknown })?.data) ?? { id, updated: true };
    })
  );

  server.registerTool(
    "skylight_delete_chore",
    {
      title: "Delete a chore",
      description: "Delete a chore or routine step. One-time chore: omit applyTo. Recurring chore: applyTo \"all\" deletes every occurrence, \"future\" deletes the given occurrence and all later ones, \"one\" deletes only the given occurrence. \"one\" and \"future\" need the occurrence date: pass a composite choreId such as \"123-2026-10-13\" (or \"123-2026-10-13-0600\" for a routine step, exactly as listed) or the plain id plus instanceDate (both come from skylight_list_chores). Without confirm: true this makes NO change and returns what would be deleted. Show that to the user and only call again with confirm: true after they agree.",
      inputSchema: {
        choreId: z.string().describe("Chore id exactly as returned by skylight_list_chores: plain, series-date or series-date-HHMM."),
        instanceDate: z.string().optional().describe("YYYY-MM-DD occurrence to anchor applyTo \"one\" or \"future\" on, if choreId is the plain series id."),
        confirm: z.boolean().optional().describe("Must be true to actually delete. Ask the user first."),
        applyTo: deleteApplyToSchema,
      },
      annotations: ANNOTATIONS.destroy,
    },
    (args) => run(async () => {
      const { choreId, confirm, applyTo, instanceDate } = args as { choreId: string; confirm?: boolean; applyTo?: string; instanceDate?: string };
      const ref = parseChoreId(choreId, "choreId");
      const date = resolveInstanceDate(ref.instanceDate, instanceDate);
      const anchored = applyTo === "one" || applyTo === "future";
      if (anchored && date === null) {
        throw new ValidationError("instanceDate", `applyTo "${applyTo}" needs the occurrence date: pass a composite choreId (seriesId-YYYY-MM-DD) or instanceDate`);
      }
      const path = anchored ? `${ref.seriesId}-${date}` : ref.seriesId;
      const frameId = await ctx.frames.resolve();
      if (confirm !== true) {
        const scope = DELETE_SCOPE_TEXT[(applyTo as keyof typeof DELETE_SCOPE_TEXT | undefined) ?? "none"];
        return {
          confirmed: false,
          wouldDelete: { seriesId: ref.seriesId, instanceDate: anchored ? date : null, applyTo: applyTo ?? null, summary: await findChoreSummary(ctx, frameId, choreId, ref.seriesId, date) },
          message: `Nothing was deleted. This would delete ${scope}. Ask the user to confirm, then call again with confirm: true.`,
        };
      }
      await ctx.client.request({ method: "DELETE", path: `${choresPath(frameId)}/${path}`, query: applyTo === undefined ? {} : { apply_to: applyTo } });
      return { deleted: true, seriesId: ref.seriesId, instanceDate: anchored ? date : null, applyTo: applyTo ?? null };
    })
  );

  server.registerTool(
    "skylight_complete_chore",
    {
      title: "Mark a chore done or not done",
      description: "Mark a chore complete (done: true, the default) or revert it (done: false). Recurring chores need the occurrence date (the chore's instanceDate from skylight_list_chores, or a composite choreId); one-time chores must omit it. Routine-step ids look like series-date-HHMM: pass the id as returned by the list and the time is sent for you.",
      inputSchema: {
        choreId: z.string().describe("Chore id exactly as returned by skylight_list_chores: plain, series-date or series-date-HHMM."),
        instanceDate: z.string().optional().describe("YYYY-MM-DD. Required for recurring chores (use the chore's instanceDate from skylight_list_chores). Omit for one-time chores."),
        profileId: z.string().optional().describe("Only for up-for-grabs chores: which profile completed it. Omit for chores assigned to a profile."),
        done: z.boolean().optional().describe("Default true."),
        instanceTime: z.string().optional().describe("HH:mm, only for timed instances (routine steps). Sent automatically when choreId ends in -HHMM; an explicit value must match."),
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const ref = parseChoreId(args.choreId, "choreId");
      const instanceDate = resolveInstanceDate(ref.instanceDate, args.instanceDate);
      const profileId = args.profileId === undefined ? null : assertId(args.profileId, "profileId");
      const instanceTime = resolveInstanceTime(ref.instanceTime, args.instanceTime);
      const status = args.done === false ? CHORE_STATUS.notDone : CHORE_STATUS.done;
      const frameId = await ctx.frames.resolve();
      const body: Record<string, unknown> = {
        status,
        ...(instanceDate !== null ? { instance_date: instanceDate } : {}),
        ...(instanceTime !== null ? { instance_time: instanceTime } : {}),
        ...(profileId !== null ? { category_id: profileId } : {}),
      };
      let json: unknown;
      try {
        json = await ctx.client.request<unknown>({ method: "PUT", path: `${choresPath(frameId)}/${ref.seriesId}/completions`, body });
      } catch (e) {
        throw mapCompletionError(e);
      }
      return { seriesId: ref.seriesId, instanceDate, status, chore: mapChore((json as { data?: unknown })?.data) };
    })
  );
}
