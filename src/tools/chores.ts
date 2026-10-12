import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildChoreCreateBody, buildChoreUpdateBody, type ChoreInput } from "../skylight/chore-payload.js";
import { ValidationError } from "../skylight/errors.js";
import { assertDate, assertId } from "../skylight/ids.js";
import { FREQUENCIES, WEEKDAYS } from "../skylight/rrule.js";
import { mapChore, mapChores, type Chore } from "../skylight/types.js";
import { APPLY_TO_VALUES, CHORE_STATUS } from "../skylight/vocab.js";
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
  start: z.string().describe("First date YYYY-MM-DD."),
  profileIds: z.array(z.string()).min(1).max(20).describe("Profile ids from skylight_list_profiles. One chore is created per profile."),
  startTime: z.string().optional().describe("HH:mm 24-hour. Routines use this for ordering."),
  recurrence: recurrenceShape.optional().describe("Omit for a one-off chore."),
  routine: z.boolean().optional().describe("true makes this a routine step instead of a chore. Default false."),
  upForGrabs: z.boolean().optional().describe("true lets any profile claim it. Default false."),
  rewardPoints: z.number().int().optional().describe("Points earned on completion."),
  emoji: z.string().optional().describe("Single emoji icon."),
};

const applyToSchema = APPLY_TO_VALUES.length > 0
  ? z.enum(APPLY_TO_VALUES as [string, ...string[]]).optional().describe("For recurring chores only. \"one\" = only this occurrence, \"future\" = this and following occurrences, \"all\" = the whole series. Omit for one-off chores.")
  : undefined;

function choresPath(frameId: string): string {
  return `/api/frames/${frameId}/chores`;
}

async function createOne(ctx: ToolContext, frameId: string, input: ChoreInput): Promise<Chore> {
  const body = buildChoreCreateBody(input);
  const json = await ctx.client.request<unknown>({ method: "POST", path: `${choresPath(frameId)}/create_multiple`, body });
  const created = mapChores(json)[0] ?? mapChore((json as { data?: unknown })?.data);
  return created ?? { id: "", summary: body.summary, start: body.start, startTime: body.start_time, status: null, routine: body.routine, recurring: body.recurrence_set !== null, recurrenceRule: body.recurrence_set?.[0] ?? null, rewardPoints: body.reward_points, emoji: body.emoji_icon, profileIds: body.category_ids };
}

async function findChoreSummary(ctx: ToolContext, frameId: string, choreId: string): Promise<string | null> {
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const after = new Date(today); after.setUTCDate(after.getUTCDate() - 365);
  const before = new Date(today); before.setUTCDate(before.getUTCDate() + 365);
  try {
    const chores = mapChores(await ctx.client.request({ method: "GET", path: choresPath(frameId), query: { after: iso(after), before: iso(before), include_late: true, include_up_for_grabs: true, filter: "linked_to_profile" } }));
    return chores.find((c) => c.id === choreId)?.summary ?? null;
  } catch {
    return null;
  }
}

export function registerChoreTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "skylight_list_chores",
    {
      title: "List chores",
      description: "List chores and routine steps in a date range (default: today through 14 days ahead). Returns ids needed for update, complete and delete.",
      inputSchema: {
        after: z.string().optional().describe("Start date YYYY-MM-DD (inclusive). Default today."),
        before: z.string().optional().describe("End date YYYY-MM-DD (inclusive). Default 14 days from today."),
        includeLate: z.boolean().optional().describe("Include overdue chores. Default true."),
        includeUpForGrabs: z.boolean().optional().describe("Include unassigned up-for-grabs chores. Default false."),
      },
      annotations: ANNOTATIONS.read,
    },
    (args) => run(async () => {
      const today = new Date().toISOString().slice(0, 10);
      const plus14 = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
      const after = assertDate(args.after ?? today, "after");
      const before = assertDate(args.before ?? plus14, "before");
      if (after > before) throw new ValidationError("after", "must not be later than before");
      const frameId = await ctx.frames.resolve();
      return mapChores(await ctx.client.request({
        method: "GET", path: choresPath(frameId),
        query: { after, before, include_late: args.includeLate ?? true, include_up_for_grabs: args.includeUpForGrabs ?? false, filter: "linked_to_profile" },
      }));
    })
  );

  server.registerTool(
    "skylight_create_chore",
    {
      title: "Create a chore or routine step",
      description: "Create one chore (or routine step with routine: true) assigned to one or more profiles. For many chores at once use skylight_bulk_create_chores.",
      inputSchema: choreInputShape,
      annotations: ANNOTATIONS.create,
    },
    (args) => run(async () => createOne(ctx, await ctx.frames.resolve(), args as ChoreInput))
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
      const results: Array<{ index: number; summary: string; ok: boolean; id?: string; error?: string; payload?: unknown }> = [];
      const payloads = args.chores.map((c, index) => {
        try { return { index, payload: buildChoreCreateBody(c as ChoreInput) }; }
        catch (e) { return { index, error: e instanceof Error ? e.message : String(e) }; }
      });
      if (args.dryRun) {
        return { dryRun: true, valid: payloads.filter((p) => "payload" in p).length, invalid: payloads.filter((p) => "error" in p).length,
          results: payloads.map((p) => ({ index: p.index, summary: args.chores[p.index]!.summary, ok: !("error" in p), ...("payload" in p ? { payload: p.payload } : { error: p.error }) })) };
      }
      const frameId = await ctx.frames.resolve();
      for (const p of payloads) {
        const summary = args.chores[p.index]!.summary;
        if ("error" in p) { results.push({ index: p.index, summary, ok: false, error: p.error }); continue; }
        try {
          const created = await createOne(ctx, frameId, args.chores[p.index] as ChoreInput);
          results.push({ index: p.index, summary, ok: true, id: created.id });
        } catch (e) {
          results.push({ index: p.index, summary, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      }
      return { dryRun: false, created: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
    })
  );

  server.registerTool(
    "skylight_update_chore",
    {
      title: "Update a chore",
      description: "Change fields on an existing chore or routine step. Only the provided fields change.",
      inputSchema: {
        choreId: z.string().describe("Chore id from skylight_list_chores."),
        summary: choreInputShape.summary.optional(),
        start: choreInputShape.start.optional(),
        profileIds: choreInputShape.profileIds.optional(),
        startTime: choreInputShape.startTime,
        recurrence: choreInputShape.recurrence,
        routine: choreInputShape.routine,
        upForGrabs: choreInputShape.upForGrabs,
        rewardPoints: choreInputShape.rewardPoints,
        emoji: choreInputShape.emoji,
        ...(applyToSchema ? { applyTo: applyToSchema } : {}),
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const { choreId, applyTo, ...rest } = args as Record<string, unknown> & { choreId: string; applyTo?: string };
      const id = assertId(choreId, "choreId");
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
      description: "Delete a chore or routine step. Without confirm: true this makes NO change and returns what would be deleted. Show that to the user and only call again with confirm: true after they agree.",
      inputSchema: {
        choreId: z.string().describe("Chore id from skylight_list_chores."),
        confirm: z.boolean().optional().describe("Must be true to actually delete. Ask the user first."),
        ...(applyToSchema ? { applyTo: applyToSchema } : {}),
      },
      annotations: ANNOTATIONS.destroy,
    },
    (args) => run(async () => {
      const { choreId, confirm, applyTo } = args as { choreId: string; confirm?: boolean; applyTo?: string };
      const id = assertId(choreId, "choreId");
      const frameId = await ctx.frames.resolve();
      if (confirm !== true) {
        return { confirmed: false, wouldDelete: { id, summary: await findChoreSummary(ctx, frameId, id) }, message: "Nothing was deleted. Ask the user to confirm, then call again with confirm: true." };
      }
      await ctx.client.request({ method: "DELETE", path: `${choresPath(frameId)}/${id}`, query: applyTo === undefined ? {} : { apply_to: applyTo } });
      return { deleted: true, id };
    })
  );

  server.registerTool(
    "skylight_complete_chore",
    {
      title: "Mark a chore done or not done",
      description: "Mark one instance of a chore complete (done: true, the default) or revert it (done: false) for a profile on a given date.",
      inputSchema: {
        choreId: z.string().describe("Chore (series) id."),
        instanceDate: z.string().describe("Instance date YYYY-MM-DD."),
        profileId: z.string().describe("Profile id the completion belongs to."),
        done: z.boolean().optional().describe("Default true."),
        instanceTime: z.string().optional().describe("HH:mm, only for timed instances."),
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const id = assertId(args.choreId, "choreId");
      const instanceDate = assertDate(args.instanceDate, "instanceDate");
      const profileId = assertId(args.profileId, "profileId");
      const status = args.done === false ? CHORE_STATUS.notDone : CHORE_STATUS.done;
      const frameId = await ctx.frames.resolve();
      const json = await ctx.client.request<unknown>({
        method: "PUT", path: `${choresPath(frameId)}/${id}/completions`,
        body: { status, instance_date: instanceDate, instance_time: args.instanceTime ?? null, category_id: profileId },
      });
      return { id, instanceDate, profileId, status, chore: mapChore((json as { data?: unknown })?.data) };
    })
  );
}
