import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SkylightApiError, ValidationError } from "../skylight/errors.js";
import { buildFrameUpdateBody, MAX_HOUSEHOLD_NAME_LENGTH } from "../skylight/frame-payload.js";
import { assertEmail, assertNumericId } from "../skylight/ids.js";
import { mapFrame, mapFrameUsers, type FrameUser } from "../skylight/types.js";
import { FRAME_USER_STATUS } from "../skylight/vocab.js";
import type { ToolContext } from "./context.js";
import { ANNOTATIONS, run } from "./result.js";

const framePath = (frameId: string) => `/api/frames/${frameId}`;
const usersPath = (frameId: string) => `${framePath(frameId)}/users`;
const dataOf = (json: unknown): unknown => (json as { data?: unknown } | null)?.data;

async function listUsers(ctx: ToolContext, frameId: string): Promise<FrameUser[]> {
  return mapFrameUsers(await ctx.client.request({ method: "GET", path: usersPath(frameId) }));
}

function findUser(users: readonly FrameUser[], userId: string): FrameUser {
  const hit = users.find((u) => u.userId === userId);
  if (!hit) throw new ValidationError("userId", "no one with that user id shares this frame; use skylight_list_frame_users");
  return hit;
}

const who = (u: FrameUser): string => u.email ?? `user ${u.userId}`;
const userIdSchema = z.string().describe("userId from skylight_list_frame_users.");

export function registerFrameTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "skylight_get_frame",
    {
      title: "Get the frame's settings",
      description: "The frame's settings as { id, name, timezone, householdName, locale, photosOpenToPublic, photoViewability, features, plus }. features is a map of feature name to enabled (chores, lists, meals, ...). Share links and the owner's contact details are never returned.",
      inputSchema: {},
      annotations: ANNOTATIONS.read,
    },
    () => run(async () => {
      const frameId = await ctx.frames.resolve();
      const frame = mapFrame(dataOf(await ctx.client.request({ method: "GET", path: framePath(frameId) })));
      if (!frame) throw new SkylightApiError(200, "GET", framePath(frameId), "Frame response had no frame.");
      return frame;
    })
  );

  server.registerTool(
    "skylight_update_frame",
    {
      title: "Update the frame's settings",
      description: "Change the frame's household name (null clears it), time zone (IANA name such as America/Chicago) or locale (such as en). Only the provided fields change. This is the frame's own setting on Skylight; it does not change the time zone this server shows times in (SKYLIGHT_TIMEZONE). Who can see the family's photos is deliberately not available here.",
      inputSchema: {
        householdName: z.string().nullable().optional().describe(`Household name shown by Skylight, up to ${MAX_HOUSEHOLD_NAME_LENGTH} characters. null clears it.`),
        timezone: z.string().optional().describe("IANA time zone of the frame, e.g. America/New_York."),
        locale: z.string().optional().describe("Language code such as en."),
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const body = buildFrameUpdateBody(args);
      const frameId = await ctx.frames.resolve();
      const json = await ctx.client.request<unknown>({ method: "PUT", path: framePath(frameId), body });
      return mapFrame(dataOf(json)) ?? { id: frameId, updated: true };
    })
  );

  server.registerTool(
    "skylight_list_frame_users",
    {
      title: "List who shares the frame",
      description: "List the people who share the frame as { userId, email, status, owner }. status is approved, rejected (blocked) or awaiting_approval. userId is what the block and unblock tools take.",
      inputSchema: {},
      annotations: ANNOTATIONS.read,
    },
    () => run(async () => listUsers(ctx, await ctx.frames.resolve()))
  );

  server.registerTool(
    "skylight_invite_frame_user",
    {
      title: "Invite someone to share the frame",
      description: "Invite a person to share the frame by email. This SENDS A REAL EMAIL: Skylight emails an invitation to that address, a third party outside the family. Without confirm: true it makes NO change and returns the address it would invite. Show that to the user and only call again with confirm: true after they agree. Not idempotent: repeating the call emails the address again.",
      inputSchema: {
        email: z.string().describe("The person's email address."),
        confirm: z.boolean().optional().describe("Must be true to actually send the invitation. Ask the user first."),
      },
      annotations: { ...ANNOTATIONS.create, openWorldHint: true },
    },
    (args) => run(async () => {
      const email = assertEmail(args.email, "email");
      const frameId = await ctx.frames.resolve();
      const existing = (await listUsers(ctx, frameId)).find((u) => u.email?.toLowerCase() === email);
      if (existing) throw new ValidationError("email", `${email} already shares this frame (status ${existing.status ?? "unknown"}); use skylight_list_frame_users`);
      if (args.confirm !== true) {
        return {
          confirmed: false,
          wouldInvite: { email },
          message: `Nothing was sent. Skylight will email an invitation to ${email} to share this frame. Ask the user to confirm, then call again with confirm: true.`,
        };
      }
      await ctx.client.request({ method: "POST", path: usersPath(frameId), body: { email } });
      return { invited: true, email };
    })
  );

  server.registerTool(
    "skylight_block_frame_user",
    {
      title: "Block someone from the frame",
      description: "Block a person from the frame: they lose access to it. The owner cannot be blocked. skylight_unblock_frame_user undoes it. Without confirm: true this makes NO change and returns who would be blocked. Show that to the user and only call again with confirm: true after they agree.",
      inputSchema: { userId: userIdSchema, confirm: z.boolean().optional().describe("Must be true to actually block. Ask the user first.") },
      annotations: ANNOTATIONS.destroy,
    },
    (args) => run(async () => {
      const userId = assertNumericId(args.userId, "userId");
      const frameId = await ctx.frames.resolve();
      const user = findUser(await listUsers(ctx, frameId), userId);
      if (user.owner) throw new ValidationError("userId", `${who(user)} is the owner of this frame and cannot be blocked`);
      if (user.status === FRAME_USER_STATUS.blocked) throw new ValidationError("userId", `${who(user)} is already blocked`);
      if (args.confirm !== true) {
        return {
          confirmed: false,
          wouldBlock: { userId, email: user.email, status: user.status },
          message: `Nothing was changed. This would block ${who(user)} from this frame; they would lose access until unblocked. Ask the user to confirm, then call again with confirm: true.`,
        };
      }
      await ctx.client.request({ method: "DELETE", path: `${usersPath(frameId)}/${userId}` });
      return { blocked: true, userId, email: user.email };
    })
  );

  server.registerTool(
    "skylight_unblock_frame_user",
    {
      title: "Unblock someone on the frame",
      description: "Give a blocked person access to the frame again, or approve one who is awaiting approval. Refused for someone who already has access.",
      inputSchema: { userId: userIdSchema },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const userId = assertNumericId(args.userId, "userId");
      const frameId = await ctx.frames.resolve();
      const user = findUser(await listUsers(ctx, frameId), userId);
      if (user.status === FRAME_USER_STATUS.approved) throw new ValidationError("userId", `${who(user)} already has access`);
      await ctx.client.request({ method: "POST", path: `${usersPath(frameId)}/${userId}/approve` });
      return { unblocked: true, userId, email: user.email };
    })
  );
}
