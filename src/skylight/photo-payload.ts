import { ValidationError } from "./errors.js";
import { assertNumericId, cleanText } from "./ids.js";

export const MAX_CAPTION_LENGTH = 200;
export const MAX_ALBUM_TITLE_LENGTH = 100;

/** An empty (or blank) caption clears it. */
export function buildCaptionBody(caption: string): { caption: string } {
  if (typeof caption !== "string") throw new ValidationError("caption", "must be a string");
  const trimmed = caption.trim();
  return { caption: trimmed === "" ? "" : cleanText(trimmed, "caption", MAX_CAPTION_LENGTH) };
}

export function assertAlbumTitle(title: string): string {
  return cleanText(title, "title", MAX_ALBUM_TITLE_LENGTH);
}

/** 1..max numeric photo ids without repeats. */
export function assertPhotoIds(ids: string[], field: string, max: number): string[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > max) throw new ValidationError(field, `must list 1 to ${max} photo ids`);
  const out = ids.map((id) => assertNumericId(id, field));
  if (new Set(out).size !== out.length) throw new ValidationError(field, "must not repeat");
  return out;
}

/** add_to / remove_from bodies take numbers. */
export function buildAlbumMembershipBody(albumId: string, photoIds: readonly string[]): { album_ids: number[]; message_ids: number[] } {
  return { album_ids: [Number(assertNumericId(albumId, "albumId"))], message_ids: photoIds.map(Number) };
}

export function buildDestroyPhotosBody(photoIds: readonly string[]): { message_ids: number[] } {
  return { message_ids: photoIds.map(Number) };
}
