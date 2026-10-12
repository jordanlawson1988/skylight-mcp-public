import { ValidationError } from "./errors.js";
import { assertNumericId, assertTime, cleanText } from "./ids.js";
import { ALL_PHOTOS, ALL_PHOTOS_ALBUM_ID } from "./vocab.js";

export const MAX_DEVICE_NAME_LENGTH = 60;
export const MAX_BRIGHTNESS = 255;
export const MAX_SLIDESHOW_SPEED = 3600;
export const MAX_SLIDESHOW_STYLE = 10;

export interface DeviceUpdateInput {
  name?: string | undefined;
  brightness?: number | undefined;
  sleepsAt?: string | undefined;
  wakesAt?: string | undefined;
  sleepModeOn?: boolean | undefined;
  showCaption?: boolean | undefined;
  showHeart?: boolean | undefined;
  blurEffect?: boolean | undefined;
  startSound?: boolean | undefined;
  slideshowSpeed?: number | undefined;
  slideshowStyle?: number | undefined;
  /** An album id, or "all" for every photo. */
  albumId?: string | undefined;
}

export interface DeviceUpdateBody {
  name?: string;
  brightness?: number;
  sleeps_at?: string;
  wakes_at?: string;
  sleep_mode_on?: boolean;
  show_caption?: boolean;
  show_heart?: boolean;
  blur_effect?: boolean;
  start_sound?: boolean;
  slideshow_speed?: number;
  slideshow_style?: number;
  current_album_id?: number;
}

function intInRange(value: number, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new ValidationError(field, `must be a whole number from ${min} to ${max}`);
  return value;
}

/** Only the provided fields; Skylight leaves every other device setting as it is (verified live). */
export function buildDeviceUpdateBody(input: DeviceUpdateInput): DeviceUpdateBody {
  const out: DeviceUpdateBody = {};
  if (input.name !== undefined) out.name = cleanText(input.name, "name", MAX_DEVICE_NAME_LENGTH);
  if (input.brightness !== undefined) out.brightness = intInRange(input.brightness, "brightness", 0, MAX_BRIGHTNESS);
  if (input.sleepsAt !== undefined) out.sleeps_at = assertTime(input.sleepsAt, "sleepsAt");
  if (input.wakesAt !== undefined) out.wakes_at = assertTime(input.wakesAt, "wakesAt");
  if (input.sleepModeOn !== undefined) out.sleep_mode_on = input.sleepModeOn;
  if (input.showCaption !== undefined) out.show_caption = input.showCaption;
  if (input.showHeart !== undefined) out.show_heart = input.showHeart;
  if (input.blurEffect !== undefined) out.blur_effect = input.blurEffect;
  if (input.startSound !== undefined) out.start_sound = input.startSound;
  if (input.slideshowSpeed !== undefined) out.slideshow_speed = intInRange(input.slideshowSpeed, "slideshowSpeed", 1, MAX_SLIDESHOW_SPEED);
  if (input.slideshowStyle !== undefined) out.slideshow_style = intInRange(input.slideshowStyle, "slideshowStyle", 0, MAX_SLIDESHOW_STYLE);
  if (input.albumId !== undefined) out.current_album_id = input.albumId === ALL_PHOTOS ? ALL_PHOTOS_ALBUM_ID : Number(assertNumericId(input.albumId, "albumId"));
  if (Object.keys(out).length === 0) throw new ValidationError("update", "provide at least one setting to change");
  return out;
}
