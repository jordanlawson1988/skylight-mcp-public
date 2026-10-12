import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SkylightApiError, ValidationError } from "../skylight/errors.js";
import { assertNumericId } from "../skylight/ids.js";
import { assertAlbumTitle, assertPhotoIds, buildAlbumMembershipBody, buildCaptionBody, buildDestroyPhotosBody, MAX_ALBUM_TITLE_LENGTH, MAX_CAPTION_LENGTH } from "../skylight/photo-payload.js";
import { mapAlbum, mapAlbums, mapFrameUsers, mapPhoto, mapPhotoPage, photosCarryOwner, type Album, type Photo } from "../skylight/types.js";
import { formatOffsetDateTime } from "../skylight/time.js";
import type { ToolContext } from "./context.js";
import { ANNOTATIONS, run } from "./result.js";

export const MAX_DELETE_PHOTOS = 50;
export const MAX_ALBUM_PHOTOS = 100;
/** Photos looked up at once when checking ids. */
const LOOKUP_PARALLEL = 5;

const messagesPath = (frameId: string) => `/api/frames/${frameId}/messages`;
const albumsPath = (frameId: string) => `/api/frames/${frameId}/albums`;
const dataOf = (json: unknown): unknown => (json as { data?: unknown } | null)?.data;

/** A photo for display: createdAt in the configured zone. */
const present = (p: Photo, tz: string): Photo => (p.createdAt === null ? p : { ...p, createdAt: formatOffsetDateTime(p.createdAt, tz) });

/** One photo by id; an id Skylight does not know (a 4xx other than a rate limit) is the caller's mistake, anything else is not. */
async function getPhoto(ctx: ToolContext, frameId: string, id: string): Promise<Photo> {
  let json: unknown;
  try {
    json = await ctx.client.request({ method: "GET", path: `${messagesPath(frameId)}/${id}` });
  } catch (e) {
    if (e instanceof SkylightApiError && e.status >= 400 && e.status < 500 && e.status !== 429) throw new ValidationError("photoIds", `${id} is not a photo on this frame (use skylight_list_photos for ids)`);
    throw e;
  }
  const data = dataOf(json);
  const photo = mapPhoto(Array.isArray(data) ? data[0] : data);
  if (!photo) throw new ValidationError("photoIds", `${id} is not a photo on this frame (use skylight_list_photos for ids)`);
  return photo;
}

async function getPhotos(ctx: ToolContext, frameId: string, ids: readonly string[]): Promise<Photo[]> {
  const out: Photo[] = [];
  for (let i = 0; i < ids.length; i += LOOKUP_PARALLEL) out.push(...(await Promise.all(ids.slice(i, i + LOOKUP_PARALLEL).map((id) => getPhoto(ctx, frameId, id)))));
  return out;
}

/** An album from the album list, which must exist and be one we may change. */
async function getEditableAlbum(ctx: ToolContext, frameId: string, albumId: string): Promise<Album> {
  const album = mapAlbums(await ctx.client.request({ method: "GET", path: albumsPath(frameId) })).find((a) => a.id === albumId);
  if (!album) throw new ValidationError("albumId", "no album with that id; use skylight_list_albums");
  if (album.editable === false) throw new ValidationError("albumId", `"${album.title}" is a built-in album that cannot be changed`);
  return album;
}

const photoIdSchema = z.string().describe("Photo id from skylight_list_photos.");
const albumIdSchema = z.string().describe("Album id from skylight_list_albums.");

export function registerPhotoTools(server: McpServer, ctx: ToolContext): void {
  const tz = ctx.config.timezone;

  server.registerTool(
    "skylight_list_photos",
    {
      title: "List photos",
      description: "List the photos and videos on the frame, newest first, one page at a time, as { page, pages, photos: [{ id, type, createdAt, caption, from, commentsCount }] }. type is photo or video; createdAt is in the configured time zone; from is \"you\" for photos the frame owner sent and the sender's email for anyone else. Photo ids are needed for captions, albums and deletion. Photo files and links are never returned.",
      inputSchema: { page: z.number().int().min(1).optional().describe("Page number, starting at 1 (default 1). pages in the result is the total.") },
      annotations: ANNOTATIONS.read,
    },
    (args) => run(async () => {
      const page = args.page ?? 1;
      if (!Number.isInteger(page) || page < 1) throw new ValidationError("page", "must be a whole number from 1");
      const frameId = await ctx.frames.resolve();
      const json = await ctx.client.request({ method: "GET", path: messagesPath(frameId), query: { page } });
      // Messages normally name the frame owner; if one does not, find the owner among the frame's users so their own photos show "you", not their email.
      let ownerId: string | null = null;
      if (!photosCarryOwner(json)) {
        try { ownerId = mapFrameUsers(await ctx.client.request({ method: "GET", path: `/api/frames/${frameId}/users` })).find((u) => u.owner)?.userId ?? null; }
        catch (e) { if (!(e instanceof SkylightApiError)) throw e; }
      }
      const result = mapPhotoPage(json, page, ownerId);
      return { ...result, photos: result.photos.map((p) => present(p, tz)) };
    })
  );

  server.registerTool(
    "skylight_update_photo_caption",
    {
      title: "Set a photo caption",
      description: `Set the caption of a photo or video, up to ${MAX_CAPTION_LENGTH} characters. An empty caption removes it.`,
      inputSchema: {
        photoId: photoIdSchema,
        caption: z.string().describe(`New caption, up to ${MAX_CAPTION_LENGTH} characters. "" clears it.`),
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const id = assertNumericId(args.photoId, "photoId");
      const body = buildCaptionBody(args.caption);
      const frameId = await ctx.frames.resolve();
      await ctx.client.request({ method: "PUT", path: `${messagesPath(frameId)}/${id}/caption`, body });
      return { id, caption: body.caption, updated: true };
    })
  );

  server.registerTool(
    "skylight_delete_photos",
    {
      title: "Delete photos",
      description: `PERMANENTLY delete up to ${MAX_DELETE_PHOTOS} photos or videos from the frame, for everyone who shares it; this cannot be undone. Without confirm: true this makes NO change and returns each photo's date and caption (an id that is not a photo on the frame is an error). Show that to the user and only call again with confirm: true after they clearly agree.`,
      inputSchema: {
        photoIds: z.array(z.string()).min(1).max(MAX_DELETE_PHOTOS).describe("Photo ids from skylight_list_photos."),
        confirm: z.boolean().optional().describe("Must be true to actually delete. Ask the user first."),
      },
      annotations: ANNOTATIONS.destroy,
    },
    (args) => run(async () => {
      const ids = assertPhotoIds(args.photoIds, "photoIds", MAX_DELETE_PHOTOS);
      const frameId = await ctx.frames.resolve();
      // One lookup serves the preview and, on confirm, the check that every id is still a photo on this frame.
      const photos = (await getPhotos(ctx, frameId, ids)).map((p) => present(p, tz));
      if (args.confirm !== true) {
        const lines = photos.map((p) => `${p.createdAt?.slice(0, 10) ?? "unknown date"}${p.caption ? ` "${p.caption}"` : " (no caption)"}`);
        return {
          confirmed: false,
          wouldDelete: { photos: photos.map((p) => ({ id: p.id, type: p.type, createdAt: p.createdAt, caption: p.caption })) },
          message: `Nothing was deleted. This would PERMANENTLY delete ${photos.length} photo${photos.length === 1 ? "" : "s"} from the frame for everyone: ${lines.join("; ")}. This cannot be undone. Ask the user to confirm, then call again with confirm: true.`,
        };
      }
      await ctx.client.request({ method: "DELETE", path: `${messagesPath(frameId)}/destroy_multiple`, body: buildDestroyPhotosBody(ids) });
      return { deleted: true, photoIds: ids };
    })
  );

  server.registerTool(
    "skylight_list_albums",
    {
      title: "List albums",
      description: "List the photo albums as { id, title, photoCount, videoCount, editable }. editable: false marks built-in albums that cannot be renamed or deleted.",
      inputSchema: {},
      annotations: ANNOTATIONS.read,
    },
    () => run(async () => mapAlbums(await ctx.client.request({ method: "GET", path: albumsPath(await ctx.frames.resolve()) })))
  );

  server.registerTool(
    "skylight_create_album",
    {
      title: "Create an album",
      description: `Create an empty photo album, up to ${MAX_ALBUM_TITLE_LENGTH} characters in the title. Not idempotent: repeating the call creates a second album.`,
      inputSchema: { title: z.string().describe(`Album name, up to ${MAX_ALBUM_TITLE_LENGTH} characters.`) },
      annotations: ANNOTATIONS.create,
    },
    (args) => run(async () => {
      const title = assertAlbumTitle(args.title);
      const frameId = await ctx.frames.resolve();
      const json = await ctx.client.request<unknown>({ method: "POST", path: albumsPath(frameId), body: { title } });
      return mapAlbum(dataOf(json)) ?? { created: true, warning: "Skylight returned no album id; call skylight_list_albums to confirm." };
    })
  );

  server.registerTool(
    "skylight_rename_album",
    {
      title: "Rename an album",
      description: "Rename a photo album. Built-in albums (editable: false) are refused.",
      inputSchema: { albumId: albumIdSchema, title: z.string().describe(`New name, up to ${MAX_ALBUM_TITLE_LENGTH} characters.`) },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const id = assertNumericId(args.albumId, "albumId");
      const title = assertAlbumTitle(args.title);
      const frameId = await ctx.frames.resolve();
      await getEditableAlbum(ctx, frameId, id);
      const json = await ctx.client.request<unknown>({ method: "PATCH", path: `${albumsPath(frameId)}/${id}`, body: { title } });
      return mapAlbum(dataOf(json)) ?? { id, title, updated: true };
    })
  );

  server.registerTool(
    "skylight_delete_album",
    {
      title: "Delete an album",
      description: "Delete a photo album. The photos and videos in it stay on the frame; only the album goes. Built-in albums (editable: false) are refused. Without confirm: true this makes NO change and returns the album's title and counts. Show that to the user and only call again with confirm: true after they agree.",
      inputSchema: { albumId: albumIdSchema, confirm: z.boolean().optional().describe("Must be true to actually delete. Ask the user first.") },
      annotations: ANNOTATIONS.destroy,
    },
    (args) => run(async () => {
      const id = assertNumericId(args.albumId, "albumId");
      const frameId = await ctx.frames.resolve();
      const album = await getEditableAlbum(ctx, frameId, id);
      if (args.confirm !== true) {
        return {
          confirmed: false,
          wouldDelete: { id: album.id, title: album.title, photoCount: album.photoCount, videoCount: album.videoCount },
          message: `Nothing was deleted. This would delete the album "${album.title}". Its photos and videos stay on the frame. Ask the user to confirm, then call again with confirm: true.`,
        };
      }
      await ctx.client.request({ method: "DELETE", path: `${albumsPath(frameId)}/${id}` });
      return { deleted: true, id };
    })
  );

  server.registerTool(
    "skylight_add_photos_to_album",
    {
      title: "Add photos to an album",
      description: `Add up to ${MAX_ALBUM_PHOTOS} photos or videos to an album. The photos stay on the frame and in any other album. Adding one that is already in the album changes nothing.`,
      inputSchema: { albumId: albumIdSchema, photoIds: z.array(z.string()).min(1).max(MAX_ALBUM_PHOTOS).describe("Photo ids from skylight_list_photos.") },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const photoIds = assertPhotoIds(args.photoIds, "photoIds", MAX_ALBUM_PHOTOS);
      const body = buildAlbumMembershipBody(args.albumId, photoIds);
      const frameId = await ctx.frames.resolve();
      await ctx.client.request({ method: "POST", path: `${albumsPath(frameId)}/add_to`, body });
      return { added: photoIds.length, albumId: String(body.album_ids[0]), photoIds };
    })
  );

  server.registerTool(
    "skylight_remove_photos_from_album",
    {
      title: "Remove photos from an album",
      description: `Take up to ${MAX_ALBUM_PHOTOS} photos or videos out of an album. They stay on the frame; only their place in this album goes.`,
      inputSchema: { albumId: albumIdSchema, photoIds: z.array(z.string()).min(1).max(MAX_ALBUM_PHOTOS).describe("Photo ids from skylight_list_photos.") },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const photoIds = assertPhotoIds(args.photoIds, "photoIds", MAX_ALBUM_PHOTOS);
      const body = buildAlbumMembershipBody(args.albumId, photoIds);
      const frameId = await ctx.frames.resolve();
      await ctx.client.request({ method: "POST", path: `${albumsPath(frameId)}/remove_from`, body });
      return { removed: photoIds.length, albumId: String(body.album_ids[0]), photoIds };
    })
  );
}
