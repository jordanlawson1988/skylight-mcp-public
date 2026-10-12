import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildEventCreateBody, buildEventUpdateBody, MAX_EVENT_TITLE_LENGTH, MAX_LOCATION_LENGTH, type EventFields } from "../skylight/event-payload.js";
import { SkylightApiError, ValidationError } from "../skylight/errors.js";
import { addDays, assertDate, assertId, localDateString, parseEventId, type EventRef } from "../skylight/ids.js";
import { mapEvent, mapEvents, type CalendarEvent } from "../skylight/types.js";
import { formatHuman, formatHumanTime, formatOffsetDateTime, zoneLabel } from "../skylight/time.js";
import { EXPOSED_APPLY_TO_VALUES, EXPOSED_UPDATE_APPLY_TO_VALUES, OWN_EVENT_SOURCE } from "../skylight/vocab.js";
import type { ToolContext } from "./context.js";
import { recurrenceShape } from "./chores.js";
import { assertProfilesExist } from "./profiles.js";
import { ANNOTATIONS, run } from "./result.js";

/** Longest window skylight_list_events returns, in days between after and before. */
export const MAX_EVENT_SPAN_DAYS = 92;
const LOOKUP_DAYS = 365;

const eventsPath = (frameId: string) => `/api/frames/${frameId}/calendar_events`;
const dataOf = (json: unknown): unknown => (json as { data?: unknown } | null)?.data;

/** `{ data: [event...] }` or `{ data: event }`. */
function eventsFrom(json: unknown): CalendarEvent[] {
  const many = mapEvents(json);
  if (many.length > 0) return many;
  const one = mapEvent(dataOf(json));
  return one ? [one] : [];
}

/**
 * Find the event in a listing so we can see where it comes from. An occurrence id is looked up in a 3-day window around the
 * occurrence; a plain id in a window of a year either side of today. Fails OPEN when the event is simply not in the window (null: the server
 * decides, which is the residual risk for events more than a year away) but fails CLOSED when the lookup request itself fails.
 */
async function lookupEvent(ctx: ToolContext, frameId: string, ref: EventRef, id: string): Promise<CalendarEvent | null> {
  let after: string;
  let before: string;
  if (ref.occurrence !== null) {
    const day = new Date(ref.occurrence * 1000).toISOString().slice(0, 10);
    after = addDays(day, -1); before = addDays(day, 1);
  } else {
    const today = localDateString();
    after = addDays(today, -LOOKUP_DAYS); before = addDays(today, LOOKUP_DAYS);
  }
  try {
    const events = mapEvents(await ctx.client.request({ method: "GET", path: eventsPath(frameId), query: { date_min: after, date_max: before } }));
    return events.find((e) => e.id === id) ?? events.find((e) => e.masterId === ref.masterId) ?? null;
  } catch (e) {
    if (e instanceof SkylightApiError) throw new ValidationError("eventId", "could not verify whether this event comes from a synced calendar; try again");
    throw e;
  }
}

/** Events synced from another calendar (Google etc.) belong to that calendar; Skylight would only fight the sync. */
function assertOwnEvent(event: CalendarEvent | null): void {
  if (event !== null && event.source !== null && event.source !== OWN_EVENT_SOURCE) {
    throw new ValidationError("eventId", `this event comes from a synced ${event.source} calendar; change it there`);
  }
}

export type PresentedEvent = Omit<CalendarEvent, "startsAt" | "endsAt"> & { startsAt: string | null; endsAt: string | null; when: string | null };

/** The date part of an all-day value (Skylight stores all-day events as UTC midnight; converting would shift the day). */
const dayOf = (iso: string | null): string | null => (iso === null ? null : iso.slice(0, 10));

/** Event for display: times in the configured zone (all-day events keep their dates) plus a human `when`. */
export function presentEvent(e: CalendarEvent, tz: string): PresentedEvent {
  if (e.allDay) {
    const start = dayOf(e.startsAt);
    const end = dayOf(e.endsAt);
    const when = start === null ? null : end === null || end === start ? formatHuman(start, tz) : `${formatHuman(start, tz)} to ${formatHuman(end, tz)}`;
    return { ...e, startsAt: start, endsAt: end, when };
  }
  const start = e.startsAt === null ? null : formatOffsetDateTime(e.startsAt, tz);
  const end = e.endsAt === null ? null : formatOffsetDateTime(e.endsAt, tz);
  let when: string | null = null;
  if (start !== null) {
    when = formatHuman(start, tz);
    if (end !== null) when += start.slice(0, 10) === end.slice(0, 10) ? ` to ${formatHumanTime(end, tz)}` : ` to ${formatHuman(end, tz)}`;
  }
  return { ...e, startsAt: start, endsAt: end, when };
}

function byStart(a: CalendarEvent, b: CalendarEvent): number {
  const ta = a.startsAt === null ? Infinity : Date.parse(a.startsAt);
  const tb = b.startsAt === null ? Infinity : Date.parse(b.startsAt);
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
}

const eventIdSchema = z.string().describe("Event id exactly as returned by skylight_list_events: digits, or digits-digits for one occurrence of a recurring event.");

const eventFieldShape = (tz: string) => ({
  allDay: z.boolean().optional().describe("true for an all-day event (then use startDate/endDate). Default false (then use startsAt/endsAt)."),
  startDate: z.string().optional().describe("All-day events: first day YYYY-MM-DD."),
  endDate: z.string().optional().describe("All-day events: last day YYYY-MM-DD (inclusive; same as startDate for a single day). Default startDate."),
  startsAt: z.string().optional().describe(`Timed events: start as YYYY-MM-DDTHH:mm, read as ${zoneLabel(tz)} unless you add an explicit offset such as -04:00 or Z.`),
  endsAt: z.string().optional().describe("Timed events: end, same format as startsAt. Default one hour after startsAt."),
  timezone: z.string().optional().describe(`IANA timezone stored on the event. Default ${tz}.`),
  recurrence: recurrenceShape.optional().describe("Repeat schedule. Omit for a one-off event."),
  location: z.string().optional().describe(`Place name or address, up to ${MAX_LOCATION_LENGTH} characters.`),
  description: z.string().optional().describe("Notes, up to 500 characters."),
  emoji: z.string().optional().describe("Single emoji icon."),
  countdown: z.boolean().optional().describe("Show a countdown to the event on the Skylight display. Default false."),
});

const deleteScope = z.enum(EXPOSED_APPLY_TO_VALUES as [string, ...string[]]).optional()
  .describe("\"one\" = only this occurrence, \"future\" = this occurrence and all later ones (both need an occurrence id), \"all\" = the whole series (sent as a delete of the master id). Omit for a one-off event or to delete a whole series by its plain id.");
const updateScope = z.enum(EXPOSED_UPDATE_APPLY_TO_VALUES as [string, ...string[]]).optional()
  .describe("\"all\" = apply to the whole recurring series. Omit for one-off events. (Per-occurrence scopes are not available for update.)");

export function registerCalendarTools(server: McpServer, ctx: ToolContext): void {
  const tz = ctx.config.timezone;
  server.registerTool(
    "skylight_list_events",
    {
      title: "List calendar events",
      description: `List calendar events between two dates (default today through 7 days ahead, at most ${MAX_EVENT_SPAN_DAYS} days apart), sorted by start, as { id, masterId, title, startsAt, endsAt, when, allDay, timezone, recurring, recurrenceRule, location, description, emoji, profileIds, source, editable }. All times are shown in ${zoneLabel(tz)} with an explicit offset, and "when" is the same time in plain words; all-day events show dates only. Occurrences of a recurring event have ids like 123-1791803100 (masterId-unixSeconds); pass ids exactly as listed. source is "skylight" for events created here or in the Skylight app; events synced from Google or another calendar have another source and cannot be changed with these tools. Optionally filter by profileId.`,
      inputSchema: {
        after: z.string().optional().describe("First day YYYY-MM-DD (inclusive). Default today."),
        before: z.string().optional().describe(`Last day YYYY-MM-DD (inclusive). Default 7 days after "after"; at most ${MAX_EVENT_SPAN_DAYS} days after it.`),
        profileId: z.string().optional().describe("Only events for this profile or label (id from skylight_list_profiles)."),
      },
      annotations: ANNOTATIONS.read,
    },
    (args) => run(async () => {
      const after = assertDate(args.after ?? localDateString(), "after");
      const before = assertDate(args.before ?? addDays(after, 7), "before");
      if (after > before) throw new ValidationError("after", "must not be later than before");
      if (Date.parse(`${before}T00:00:00Z`) - Date.parse(`${after}T00:00:00Z`) > MAX_EVENT_SPAN_DAYS * 86_400_000) throw new ValidationError("before", `must be within ${MAX_EVENT_SPAN_DAYS} days of after`);
      const profileId = args.profileId === undefined ? null : assertId(args.profileId, "profileId");
      const frameId = await ctx.frames.resolve();
      const events = mapEvents(await ctx.client.request({ method: "GET", path: eventsPath(frameId), query: { date_min: after, date_max: before } }));
      return events.filter((e) => profileId === null || e.profileIds.includes(profileId)).sort(byStart).map((e) => presentEvent(e, tz));
    })
  );

  server.registerTool(
    "skylight_create_event",
    {
      title: "Create a calendar event",
      description: `Create one calendar event. Timed events take startsAt as YYYY-MM-DDTHH:mm, read as ${zoneLabel(tz)} unless you add an explicit offset (e.g. 2026-10-12T18:30:00-04:00 or ...Z); the tool converts it to an explicit offset itself, so just give the local time the user said. The end defaults to one hour later. All-day events use allDay: true with startDate (and endDate for several days). profileIds may be people or labels such as Birthdays. Add recurrence for a repeating event. Not idempotent: repeating the call creates a duplicate.`,
      inputSchema: {
        title: z.string().describe(`Event title, up to ${MAX_EVENT_TITLE_LENGTH} characters.`),
        profileIds: z.array(z.string()).min(1).max(20).describe("Profile or label ids from skylight_list_profiles."),
        ...eventFieldShape(tz),
      },
      annotations: ANNOTATIONS.create,
    },
    (args) => run(async () => {
      const body = buildEventCreateBody(args as EventFields, tz);
      const frameId = await ctx.frames.resolve();
      await assertProfilesExist(ctx, frameId, body.category_ids, "profileIds");
      const events = eventsFrom(await ctx.client.request<unknown>({ method: "POST", path: eventsPath(frameId), body }));
      return { created: events.length, events: events.map((e) => presentEvent(e, tz)), ...(events.length === 0 ? { warning: "Skylight returned no event; call skylight_list_events to confirm before retrying." } : {}) };
    })
  );

  server.registerTool(
    "skylight_update_event",
    {
      title: "Update a calendar event",
      description: `Change fields on an event created in Skylight. Only the provided fields change. Datetimes are read as ${zoneLabel(tz)} unless you add an explicit offset, as for skylight_create_event. For a recurring event the whole series changes (pass applyTo: \"all\"); a single occurrence cannot be edited, and an occurrence id with no applyTo still updates the whole series through its master id. Events synced from Google or another calendar are refused: change them there.`,
      inputSchema: {
        eventId: eventIdSchema,
        title: z.string().optional().describe(`New title, up to ${MAX_EVENT_TITLE_LENGTH} characters.`),
        profileIds: z.array(z.string()).min(1).max(20).optional().describe("Replace the profiles or labels the event belongs to."),
        ...eventFieldShape(tz),
        applyTo: updateScope,
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const { eventId, applyTo, ...rest } = args;
      const ref = parseEventId(eventId, "eventId");
      const body: Record<string, unknown> = buildEventUpdateBody(rest as EventFields, tz);
      if (applyTo !== undefined) body.apply_to = applyTo;
      const frameId = await ctx.frames.resolve();
      if (Array.isArray(body.category_ids)) await assertProfilesExist(ctx, frameId, body.category_ids as string[], "profileIds");
      assertOwnEvent(await lookupEvent(ctx, frameId, ref, eventId));
      const json = await ctx.client.request<unknown>({ method: "PUT", path: `${eventsPath(frameId)}/${ref.masterId}`, body });
      const updated = eventsFrom(json)[0];
      return updated ? presentEvent(updated, tz) : { id: ref.masterId, updated: true };
    })
  );

  server.registerTool(
    "skylight_delete_event",
    {
      title: "Delete a calendar event",
      description: "Delete a calendar event created in Skylight. One-off event: omit applyTo. Recurring event: applyTo \"one\" deletes only the given occurrence and \"future\" that occurrence and all later ones (both need an occurrence id such as 123-1791803100 from skylight_list_events); applyTo \"all\", or the plain id with no applyTo, deletes the WHOLE series. Events synced from Google or another calendar are refused. Without confirm: true this makes NO change and returns what would be deleted. Show that to the user and only call again with confirm: true after they agree.",
      inputSchema: {
        eventId: eventIdSchema,
        applyTo: deleteScope,
        confirm: z.boolean().optional().describe("Must be true to actually delete. Ask the user first."),
      },
      annotations: ANNOTATIONS.destroy,
    },
    (args) => run(async () => {
      const ref = parseEventId(args.eventId, "eventId");
      const applyTo = args.applyTo;
      const single = applyTo === "one" || applyTo === "future";
      if (single && ref.occurrence === null) throw new ValidationError("eventId", `applyTo "${applyTo}" needs an occurrence id like ${ref.masterId}-1791803100, as listed by skylight_list_events`);
      if (ref.occurrence !== null && applyTo === undefined) throw new ValidationError("applyTo", "is required for an occurrence id: one, future or all");
      const frameId = await ctx.frames.resolve();
      const found = await lookupEvent(ctx, frameId, ref, args.eventId);
      assertOwnEvent(found);
      const pathId = single ? args.eventId : ref.masterId;
      if (args.confirm !== true) {
        const shown = found === null ? null : presentEvent(found, tz);
        const scope = applyTo === "one" ? "only this occurrence"
          : applyTo === "future" ? "this occurrence and all later ones"
          : found === null ? "this event, and every occurrence if it is a recurring series (could not check)"
          : found.recurring ? "the whole recurring series (every occurrence)"
          : "this event";
        return {
          confirmed: false,
          wouldDelete: { id: args.eventId, masterId: ref.masterId, title: found?.title ?? null, startsAt: shown?.startsAt ?? null, when: shown?.when ?? null, applyTo: applyTo ?? null, recurring: found?.recurring ?? null },
          message: `Nothing was deleted. This would delete ${scope}${found ? ` ("${found.title}")` : ""}. Ask the user to confirm, then call again with confirm: true.`,
        };
      }
      const json = await ctx.client.request<{ meta?: { destroyed_id?: unknown } } | null>({ method: "DELETE", path: `${eventsPath(frameId)}/${pathId}`, query: single ? { apply_to: applyTo } : {} });
      const destroyed = json?.meta?.destroyed_id;
      return { deleted: true, id: args.eventId, applyTo: applyTo ?? null, destroyedId: typeof destroyed === "string" || typeof destroyed === "number" ? String(destroyed) : null };
    })
  );
}
