import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildChoreCreateBody, buildChoreUpdateBody, type ChoreCreateBody, type ChoreInput, type ChoreUpdateInput } from "../skylight/chore-payload.js";
import { AuthError, SkylightApiError, ValidationError } from "../skylight/errors.js";
import { assertDate, assertId, assertTime, localDateString, parseChoreId } from "../skylight/ids.js";
import { FREQUENCIES, WEEKDAYS } from "../skylight/rrule.js";
import { mapChore, mapChores, type Chore } from "../skylight/types.js";
import { CHORE_STATUS, EXPOSED_APPLY_TO_VALUES, EXPOSED_UPDATE_APPLY_TO_VALUES, ROUTINE_SLOT_NAMES } from "../skylight/vocab.js";
import type { ToolContext } from "./context.js";
import { personProfileProblems, assertPersonProfiles } from "./profiles.js";
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
  profileIds: z.array(z.string()).min(1).max(20).optional().describe("Profile ids from skylight_list_profiles (people only; labels such as Birthdays are rejected). One chore is created per profile. Required unless upForGrabs is true (then omit it for an unassigned chore anyone can claim)."),
  startTime: z.string().optional().describe("HH:mm 24-hour. Not allowed on routine steps."),
  recurrence: recurrenceShape.optional().describe("Omit for a one-off chore."),
  routine: z.boolean().optional().describe("true makes this a routine step instead of a chore (needs timeOfDay, no startTime; recurrence defaults to daily). Default false."),
  timeOfDay: z.enum(ROUTINE_SLOT_NAMES).optional().describe("Routine steps only: which routine the step belongs to. Required when routine is true."),
  upForGrabs: z.boolean().optional().describe("true lets any profile claim it; start and profileIds then become optional. Default false."),
  rewardPoints: z.number().int().min(-10000).max(10000).optional().describe("Points earned on completion (-10000 to 10000)."),
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

async function createOne(ctx: ToolContext, frameId: string, body: ChoreCreateBody): Promise<Chore[]> {
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

async function findChore(ctx: ToolContext, frameId: string, choreId: string, seriesId: string, date: string | null): Promise<{ summary: string; routine: boolean } | null> {
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
    return hit ? { summary: hit.summary, routine: hit.routine } : null;
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

/** Request pieces for completing (or reverting) a chore occurrence from a listed id. Shared by the tool and the live smoke. */
export function planCompletion(args: { choreId: string; instanceDate?: string | undefined; instanceTime?: string | undefined; profileId?: string | undefined; done?: boolean | undefined }): { seriesId: string; instanceDate: string | null; status: string; body: Record<string, unknown> } {
  const ref = parseChoreId(args.choreId, "choreId");
  const instanceDate = resolveInstanceDate(ref.instanceDate, args.instanceDate);
  const profileId = args.profileId === undefined ? null : assertId(args.profileId, "profileId");
  const instanceTime = resolveInstanceTime(ref.instanceTime, args.instanceTime);
  const status = args.done === false ? CHORE_STATUS.notDone : CHORE_STATUS.done;
  const body: Record<string, unknown> = {
    status,
    ...(instanceDate !== null ? { instance_date: instanceDate } : {}),
    ...(instanceTime !== null ? { instance_time: instanceTime } : {}),
    ...(profileId !== null ? { category_id: profileId } : {}),
  };
  return { seriesId: ref.seriesId, instanceDate, status, body };
}

const ROUTINE_DELETE_MESSAGE = "Skylight does not allow deleting a single occurrence of a routine step; use applyTo: \"all\" to delete the whole step";
const SERVER_ROUTINE_DELETE_MESSAGE = "you may not edit a single instance of a routine";

/** Routine steps are all-or-nothing on the server; map its 400 to the same guidance the tool gives up front. */
function mapDeleteError(e: unknown): unknown {
  if (e instanceof SkylightApiError && e.status === 400 && e.message.includes(SERVER_ROUTINE_DELETE_MESSAGE)) return new ValidationError("applyTo", ROUTINE_DELETE_MESSAGE);
  return e;
}

/** The id segment for DELETE: the numeric series id, or `<series>-<date>` when applyTo is "one" or "future". Routine occurrences (time-suffixed ids) cannot be deleted singly: throws ValidationError. */
export function deletePathId(choreId: string, applyTo: string | undefined, instanceDate?: string | undefined): { pathId: string; seriesId: string; instanceDate: string | null; anchored: boolean } {
  const ref = parseChoreId(choreId, "choreId");
  const date = resolveInstanceDate(ref.instanceDate, instanceDate);
  const anchored = applyTo === "one" || applyTo === "future";
  if (anchored && date === null) {
    throw new ValidationError("instanceDate", `applyTo "${applyTo}" needs the occurrence date: pass a composite choreId (seriesId-YYYY-MM-DD) or instanceDate`);
  }
  if (anchored && ref.instanceTime !== null) throw new ValidationError("applyTo", ROUTINE_DELETE_MESSAGE);
  return { pathId: anchored ? `${ref.seriesId}-${date}` : ref.seriesId, seriesId: ref.seriesId, instanceDate: date, anchored };
}

/** An update that touches a routine's recurrence without timeOfDay loses the BYHOUR the server requires. */
function mapUpdateError(e: unknown): unknown {
  if (e instanceof SkylightApiError && e.status === 422 && (e.message.includes("cannot be empty for routines") || (e.message.includes("BYHOUR") && !e.message.includes("not allowed for non-routine")))) {
    return new ValidationError("timeOfDay", "updating a routine step's recurrence also needs timeOfDay: morning, afternoon or evening");
  }
  return e;
}

/** Series id of any chore id form; the move endpoint only takes numeric ids. */
function numericSeriesId(value: string, field: string): string {
  const { seriesId } = parseChoreId(value, field);
  if (!/^\d+$/.test(seriesId)) throw new ValidationError(field, "must be a numeric chore id as returned by skylight_list_chores");
  return seriesId;
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
        // Same day: routine slots in clock order, then Skylight's own step order, then title. Nulls sort last.
        const byNullsLast = <T extends string | number>(x: T | null, y: T | null): number => (x === y ? 0 : x === null ? 1 : y === null ? -1 : x < y ? -1 : 1);
        return byNullsLast(a.instanceTime, b.instanceTime) || byNullsLast(a.position, b.position) || byNullsLast(a.summary, b.summary);
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
      // Build (and so validate) first: invalid input must cost no request. The label guard then checks the validated ids.
      const body = buildChoreCreateBody(args as ChoreInput);
      const frameId = await ctx.frames.resolve();
      if (body.category_ids.length > 0) await assertPersonProfiles(ctx, frameId, body.category_ids, "profileIds");
      const created = await createOne(ctx, frameId, body);
      return { created, ids: created.map((c) => c.id), ...(created.length === 0 ? { warning: NO_IDS_WARNING } : {}) };
    })
  );

  server.registerTool(
    "skylight_bulk_create_chores",
    {
      title: "Bulk create chores and routines",
      description: `Create up to ${MAX_BULK} chores or routine steps in one call. Every item is validated before any request; invalid items are reported without stopping the rest. Use dryRun: true first to show the user exactly what will be created; it still needs a login (one profile lookup) and also reports labels such as Birthdays used as profile ids. If some items fail, fix and resend ONLY the failed items; resending the whole batch creates duplicates.`,
      inputSchema: {
        chores: z.array(z.object(choreInputShape)).min(1).max(MAX_BULK),
        dryRun: z.boolean().optional().describe("true validates and returns the payloads without creating anything."),
      },
      annotations: ANNOTATIONS.create,
    },
    (args) => run(async () => {
      const results: Array<{ index: number; summary: string; ok: boolean; ids?: string[]; warning?: string; error?: string; payload?: unknown }> = [];
      const frameId = await ctx.frames.resolve();
      const built = args.chores.map((c, index) => {
        try { return { index, payload: buildChoreCreateBody(c as ChoreInput) }; }
        catch (e) { return { index, error: e instanceof Error ? e.message : String(e) }; }
      });
      // One categories lookup for the whole batch, before any POST: labels and unknown ids fail their item only.
      const wanted = [...new Set(built.flatMap((p) => ("payload" in p ? p.payload.category_ids : [])))];
      const problems = wanted.length === 0 ? null : await personProfileProblems(ctx, frameId, wanted);
      const payloads = built.map((p) => {
        if (!("payload" in p) || problems === null) return p;
        const bad = p.payload.category_ids.map((id) => problems.get(id)).find((m) => m !== undefined);
        return bad === undefined ? p : { index: p.index, error: `profileIds: ${bad}` };
      });
      if (args.dryRun) {
        return { dryRun: true, valid: payloads.filter((p) => "payload" in p).length, invalid: payloads.filter((p) => "error" in p).length,
          results: payloads.map((p) => ({ index: p.index, summary: args.chores[p.index]!.summary, ok: !("error" in p), ...("payload" in p ? { payload: p.payload } : { error: p.error }) })) };
      }
      let stop: string | null = null;
      for (const p of payloads) {
        const summary = args.chores[p.index]!.summary;
        if ("error" in p) { results.push({ index: p.index, summary, ok: false, error: p.error }); continue; }
        if (stop !== null) { results.push({ index: p.index, summary, ok: false, error: `not attempted: ${stop}` }); continue; }
        try {
          const created = await createOne(ctx, frameId, p.payload);
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
      description: "Change fields on an existing chore or routine step. Only the provided fields change; pass null for startTime, emoji, rewardPoints, description, timerSeconds or recurrence to clear them. An update always changes the whole series: the date part of a composite choreId is ignored.",
      inputSchema: {
        choreId: z.string().describe("Chore id exactly as returned by skylight_list_chores: plain, series-date or series-date-HHMM."),
        summary: choreInputShape.summary.optional(),
        start: choreInputShape.start.optional(),
        profileIds: choreInputShape.profileIds.optional().describe("Replace the assigned profiles."),
        startTime: choreInputShape.startTime.nullable().describe("HH:mm 24-hour. Not allowed on routine steps. null clears the time."),
        recurrence: choreInputShape.recurrence.nullable().describe("New schedule for the whole series. null makes the chore one-off (clears the recurrence)."),
        routine: choreInputShape.routine,
        timeOfDay: choreInputShape.timeOfDay,
        upForGrabs: choreInputShape.upForGrabs,
        rewardPoints: choreInputShape.rewardPoints.nullable().describe("Points earned on completion (-10000 to 10000). null clears the points."),
        emoji: choreInputShape.emoji.nullable().describe("Single emoji icon. null clears it."),
        description: choreInputShape.description.nullable().describe("Longer details, up to 500 characters. null clears it."),
        timerSeconds: choreInputShape.timerSeconds.nullable().describe("Countdown timer length in seconds (0-86400). null clears it."),
        applyTo: updateApplyToSchema,
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const { choreId, applyTo, ...rest } = args as Record<string, unknown> & { choreId: string; applyTo?: string };
      const { seriesId: id } = parseChoreId(choreId, "choreId");
      const body: Record<string, unknown> = buildChoreUpdateBody(rest as ChoreUpdateInput);
      if (applyTo !== undefined) body.apply_to = applyTo;
      const frameId = await ctx.frames.resolve();
      const newIds = (body as { category_ids?: string[] }).category_ids;
      if (newIds !== undefined && newIds.length > 0) await assertPersonProfiles(ctx, frameId, newIds, "profileIds");
      let json: unknown;
      try {
        json = await ctx.client.request<unknown>({ method: "PUT", path: `${choresPath(frameId)}/${id}`, body });
      } catch (e) {
        throw mapUpdateError(e);
      }
      return mapChore((json as { data?: unknown })?.data) ?? { id, updated: true };
    })
  );

  server.registerTool(
    "skylight_delete_chore",
    {
      title: "Delete a chore",
      description: "Delete a chore or routine step. Routine steps can only be deleted as a whole series (applyTo \"all\"); \"one\" and \"future\" are for regular recurring chores only. One-time chore: omit applyTo. Recurring chore: applyTo \"all\" deletes every occurrence, \"future\" deletes the given occurrence and all later ones, \"one\" deletes only the given occurrence. \"one\" and \"future\" need the occurrence date: pass a composite choreId such as \"123-2026-10-13\" or the plain id plus instanceDate (both come from skylight_list_chores). Without confirm: true this makes NO change and returns what would be deleted. Show that to the user and only call again with confirm: true after they agree.",
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
      const { pathId: path, seriesId, instanceDate: date, anchored } = deletePathId(choreId, applyTo, instanceDate);
      const frameId = await ctx.frames.resolve();
      if (confirm !== true) {
        const scope = DELETE_SCOPE_TEXT[(applyTo as keyof typeof DELETE_SCOPE_TEXT | undefined) ?? "none"];
        const found = await findChore(ctx, frameId, choreId, seriesId, date);
        // A routine whose id arrived without a time suffix is still all-or-nothing; unknown (not found / lookup failed) proceeds as before.
        if (anchored && found?.routine === true) throw new ValidationError("applyTo", ROUTINE_DELETE_MESSAGE);
        return {
          confirmed: false,
          wouldDelete: { seriesId, instanceDate: anchored ? date : null, applyTo: applyTo ?? null, summary: found?.summary ?? null },
          message: `Nothing was deleted. This would delete ${scope}. Ask the user to confirm, then call again with confirm: true.`,
        };
      }
      try {
        await ctx.client.request({ method: "DELETE", path: `${choresPath(frameId)}/${path}`, query: applyTo === undefined ? {} : { apply_to: applyTo } });
      } catch (e) {
        throw mapDeleteError(e);
      }
      return { deleted: true, seriesId, instanceDate: anchored ? date : null, applyTo: applyTo ?? null };
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
      const { seriesId, instanceDate, status, body } = planCompletion(args);
      const frameId = await ctx.frames.resolve();
      let json: unknown;
      try {
        json = await ctx.client.request<unknown>({ method: "PUT", path: `${choresPath(frameId)}/${seriesId}/completions`, body });
      } catch (e) {
        throw mapCompletionError(e);
      }
      return { seriesId, instanceDate, status, chore: mapChore((json as { data?: unknown })?.data) };
    })
  );

  server.registerTool(
    "skylight_move_routine_step",
    {
      title: "Reorder a routine step",
      description: "Move a routine step before or after another step, which changes the `position` that skylight_list_chores reports and the order the steps show in the routine. Pass exactly one of beforeChoreId or afterChoreId. Ids may be passed exactly as returned by skylight_list_chores (the series id is used). Moving is idempotent: repeating it leaves the same order.",
      inputSchema: {
        choreId: z.string().describe("The step to move: chore id as returned by skylight_list_chores."),
        beforeChoreId: z.string().optional().describe("Place the step immediately before this step."),
        afterChoreId: z.string().optional().describe("Place the step immediately after this step."),
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      if ((args.beforeChoreId === undefined) === (args.afterChoreId === undefined)) throw new ValidationError("beforeChoreId", "pass exactly one of beforeChoreId or afterChoreId");
      const position = args.beforeChoreId !== undefined ? "before" : "after";
      const seriesId = numericSeriesId(args.choreId, "choreId");
      const relativeTo = numericSeriesId((args.beforeChoreId ?? args.afterChoreId)!, position === "before" ? "beforeChoreId" : "afterChoreId");
      if (relativeTo === seriesId) throw new ValidationError(position === "before" ? "beforeChoreId" : "afterChoreId", "must be a different step than choreId");
      const frameId = await ctx.frames.resolve();
      await ctx.client.request({ method: "POST", path: `${choresPath(frameId)}/${seriesId}/move`, body: { position: { [position]: Number(relativeTo) } } });
      return { moved: true, seriesId, position, relativeTo };
    })
  );
}
