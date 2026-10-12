import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SkylightApiError, ValidationError } from "../skylight/errors.js";
import { assertId, localDateString } from "../skylight/ids.js";
import { buildProfileCreateBody, buildProfileUpdateBody, type ProfileInput } from "../skylight/profile-payload.js";
import { mapChores, mapProfile, mapProfiles, type Profile } from "../skylight/types.js";
import { DEFAULT_PROFILE_KIND, PROFILE_KINDS, isLabelKind, isPersonKind } from "../skylight/vocab.js";
import type { ToolContext } from "./context.js";
import { ANNOTATIONS, run } from "./result.js";

/** How far ahead the delete preview counts a profile's chores. */
const UPCOMING_DAYS = 90;

const categoriesPath = (frameId: string) => `/api/frames/${frameId}/categories`;

export async function listProfiles(ctx: ToolContext) {
  const frameId = await ctx.frames.resolve();
  return mapProfiles(await ctx.client.request({ method: "GET", path: categoriesPath(frameId) }));
}

const nameSchema = z.string().describe("Display name, e.g. \"Ellie\".");
const colorSchema = z.string().describe("Hex color \"#RRGGBB\", e.g. \"#CB434C\".");
const kindSchema = z.enum(PROFILE_KINDS);

async function countUpcomingChores(ctx: ToolContext, frameId: string, profileId: string): Promise<number | null> {
  try {
    const after = localDateString();
    const before = new Date(Date.parse(`${after}T00:00:00Z`) + UPCOMING_DAYS * 86_400_000).toISOString().slice(0, 10);
    const chores = mapChores(await ctx.client.request({
      method: "GET", path: `/api/frames/${frameId}/chores`,
      query: { after, before, include_late: true, include_up_for_grabs: false, filter: "linked_to_profile" },
    }));
    // Distinct chores, not occurrences: a recurring chore listed on many days counts once.
    return new Set(chores.filter((c) => c.profileIds.includes(profileId)).map((c) => c.seriesId)).size;
  } catch {
    return null;
  }
}

/**
 * Problem text per id that is not a person profile on this frame (a label, or unknown), or null when the categories
 * lookup itself failed (the guard is a convenience and must never block a write).
 */
export async function personProfileProblems(ctx: ToolContext, frameId: string, ids: readonly string[]): Promise<Map<string, string> | null> {
  let profiles: Profile[];
  try {
    profiles = mapProfiles(await ctx.client.request({ method: "GET", path: categoriesPath(frameId) }));
  } catch (e) {
    if (e instanceof SkylightApiError) return null;
    throw e;
  }
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const problems = new Map<string, string>();
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) problems.set(id, `${id} is not a profile on this frame`);
    else if (isLabelKind(p.kind)) problems.set(id, `${id} (${p.name}) is a label, not a person profile`);
  }
  return problems;
}

/** Throws ValidationError(field) when an id is a label (Birthdays etc.) or unknown on this frame. A failed lookup skips the check. */
export async function assertPersonProfiles(ctx: ToolContext, frameId: string, ids: string[], field: string): Promise<void> {
  const problems = await personProfileProblems(ctx, frameId, ids);
  const first = problems === null ? undefined : ids.map((id) => problems.get(id)).find((m) => m !== undefined);
  if (first !== undefined) throw new ValidationError(field, first);
}

function findProfile(profiles: Profile[], id: string, field: string): Profile {
  const hit = profiles.find((p) => p.id === id);
  if (!hit) throw new ValidationError(field, "not found on this frame");
  return hit;
}

export function registerProfileTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "skylight_list_profiles",
    {
      title: "List family profiles",
      description: "List the family member profiles on the Skylight frame with their ids. Chores and reward points are assigned by profile id, so call this first when the user names a person. Categories such as Birthdays are listed too; people have kind: \"profile\" and calendar categories kind: \"label\". Skylight exposes no adult/child flag.",
      inputSchema: {},
      annotations: ANNOTATIONS.read,
    },
    () => run(() => listProfiles(ctx))
  );

  server.registerTool(
    "skylight_create_profile",
    {
      title: "Create a profile or label",
      description: "Create a Skylight profile (a person who gets chores and a chore-chart column) or a label (a calendar category such as Birthdays). kind defaults to \"profile\".",
      inputSchema: {
        name: nameSchema,
        color: colorSchema,
        kind: kindSchema.optional().describe("\"profile\" for a person who gets chores and a chore-chart column; \"label\" for a calendar category like Birthdays. Default \"profile\"."),
      },
      annotations: ANNOTATIONS.create,
    },
    (args) => run(async () => {
      const body = buildProfileCreateBody({ name: args.name, color: args.color, kind: args.kind ?? DEFAULT_PROFILE_KIND });
      const frameId = await ctx.frames.resolve();
      const json = await ctx.client.request<unknown>({ method: "POST", path: categoriesPath(frameId), body });
      return mapProfile((json as { data?: unknown } | null)?.data) ?? { created: true, warning: "Skylight returned no profile id; list profiles to confirm." };
    })
  );

  server.registerTool(
    "skylight_update_profile",
    {
      title: "Update a profile or label",
      description: "Change a profile's name, color or kind. Only the provided fields change. kind: \"label\" is Skylight's \"Convert to Label\" and is the non-destructive way to retire a person profile; the profile keeps its events. kind: \"profile\" turns a label back into a person.",
      inputSchema: {
        profileId: z.string().describe("Profile id from skylight_list_profiles."),
        name: nameSchema.optional(),
        color: colorSchema.optional(),
        kind: kindSchema.optional().describe("\"label\" converts a person to a calendar label (keeps its events); \"profile\" converts a label to a person."),
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const { profileId, ...rest } = args as { profileId: string } & Partial<ProfileInput>;
      const id = assertId(profileId, "profileId");
      const body = buildProfileUpdateBody(rest);
      const frameId = await ctx.frames.resolve();
      const json = await ctx.client.request<unknown>({ method: "PUT", path: `${categoriesPath(frameId)}/${id}`, body });
      return mapProfile((json as { data?: unknown } | null)?.data) ?? { id, updated: true };
    })
  );

  server.registerTool(
    "skylight_delete_profile",
    {
      title: "Delete a profile or label",
      description: "Delete a profile or label. Its chores and events are deleted with it unless reassignToProfileId names another profile to move them to. For a person, prefer skylight_update_profile with kind: \"label\", which keeps the events and only removes the person. Without confirm: true this makes NO change and returns what would be deleted. Show that to the user and only call again with confirm: true after they agree.",
      inputSchema: {
        profileId: z.string().describe("Profile id from skylight_list_profiles."),
        reassignToProfileId: z.string().optional().describe("Another profile id that receives the deleted profile's chores and events. Omit to delete them with it."),
        confirm: z.boolean().optional().describe("Must be true to actually delete. Ask the user first."),
      },
      annotations: ANNOTATIONS.destroy,
    },
    (args) => run(async () => {
      const profileId = assertId(args.profileId, "profileId");
      const reassignId = args.reassignToProfileId === undefined ? null : assertId(args.reassignToProfileId, "reassignToProfileId");
      if (reassignId === profileId) throw new ValidationError("reassignToProfileId", "must be a different profile");
      const frameId = await ctx.frames.resolve();
      const profiles = mapProfiles(await ctx.client.request({ method: "GET", path: categoriesPath(frameId) }));
      const target = findProfile(profiles, profileId, "profileId");
      const reassignTo = reassignId === null ? null : findProfile(profiles, reassignId, "reassignToProfileId");
      if (args.confirm !== true) {
        const upcomingChores = await countUpcomingChores(ctx, frameId, profileId);
        const moves = reassignTo ? `Its chores and events will move to ${reassignTo.name}.` : "Its chores and events will be deleted with it.";
        const alternative = isPersonKind(target.kind) ? " Alternative: skylight_update_profile with kind: \"label\" keeps the events and only removes the person." : "";
        return {
          confirmed: false,
          wouldDelete: { id: target.id, name: target.name, kind: target.kind, upcomingChores, reassignTo: reassignTo ? { id: reassignTo.id, name: reassignTo.name } : null },
          message: `Nothing was deleted. ${moves}${alternative} Ask the user to confirm, then call again with confirm: true.`,
        };
      }
      await ctx.client.request({ method: "DELETE", path: `${categoriesPath(frameId)}/${profileId}`, query: reassignId === null ? {} : { reassign_to_category_id: reassignId } });
      return { deleted: true, id: profileId, reassignedTo: reassignId };
    })
  );
}
