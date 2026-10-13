import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDeviceUpdateBody } from "../../src/skylight/device-payload.js";
import { buildFrameUpdateBody } from "../../src/skylight/frame-payload.js";
import { ValidationError } from "../../src/skylight/errors.js";

const bad = (fn: () => unknown, field: string) => assert.throws(fn, (e: unknown) => e instanceof ValidationError && e.field === field, field);

test("buildDeviceUpdateBody sends only the provided fields, with the verified wire names", () => {
  assert.deepEqual(buildDeviceUpdateBody({ showHeart: true }), { show_heart: true });
  assert.deepEqual(buildDeviceUpdateBody({ name: " Kitchen ", brightness: 0, sleepsAt: "21:30", wakesAt: "06:00", sleepModeOn: false, showCaption: true, showHeart: false, blurEffect: true, startSound: false, slideshowSpeed: 3600, slideshowStyle: 10 }), {
    name: "Kitchen", brightness: 0, sleeps_at: "21:30", wakes_at: "06:00", sleep_mode_on: false, show_caption: true, show_heart: false, blur_effect: true, start_sound: false, slideshow_speed: 3600, slideshow_style: 10,
  });
});

test("buildDeviceUpdateBody maps albumId: \"all\" is -1, an id is a number", () => {
  assert.deepEqual(buildDeviceUpdateBody({ albumId: "all" }), { current_album_id: -1 });
  assert.deepEqual(buildDeviceUpdateBody({ albumId: "3001" }), { current_album_id: 3001 });
  bad(() => buildDeviceUpdateBody({ albumId: "-1" }), "albumId");
  bad(() => buildDeviceUpdateBody({ albumId: "summer" }), "albumId");
});

test("buildDeviceUpdateBody validates ranges and needs at least one field", () => {
  bad(() => buildDeviceUpdateBody({}), "update");
  bad(() => buildDeviceUpdateBody({ brightness: 256 }), "brightness");
  bad(() => buildDeviceUpdateBody({ brightness: -1 }), "brightness");
  bad(() => buildDeviceUpdateBody({ brightness: 1.5 }), "brightness");
  bad(() => buildDeviceUpdateBody({ slideshowSpeed: 0 }), "slideshowSpeed");
  bad(() => buildDeviceUpdateBody({ slideshowSpeed: 3601 }), "slideshowSpeed");
  bad(() => buildDeviceUpdateBody({ slideshowStyle: 11 }), "slideshowStyle");
  bad(() => buildDeviceUpdateBody({ sleepsAt: "9pm" }), "sleepsAt");
  bad(() => buildDeviceUpdateBody({ wakesAt: "24:00" }), "wakesAt");
  bad(() => buildDeviceUpdateBody({ name: "  " }), "name");
  bad(() => buildDeviceUpdateBody({ name: "x".repeat(61) }), "name");
});

test("buildFrameUpdateBody sends only the provided fields; householdName null clears it", () => {
  assert.deepEqual(buildFrameUpdateBody({ timezone: "America/Chicago" }), { timezone: "America/Chicago" });
  assert.deepEqual(buildFrameUpdateBody({ householdName: " The Lawsons ", timezone: "America/New_York", locale: "en" }), { household_name: "The Lawsons", timezone: "America/New_York", locale: "en" });
  assert.deepEqual(buildFrameUpdateBody({ householdName: null }), { household_name: null });
});

test("buildFrameUpdateBody validates, needs a change, and has no photo privacy fields", () => {
  bad(() => buildFrameUpdateBody({}), "update");
  bad(() => buildFrameUpdateBody({ timezone: "Mars/Olympus" }), "timezone");
  bad(() => buildFrameUpdateBody({ householdName: "x".repeat(61) }), "householdName");
  bad(() => buildFrameUpdateBody({ householdName: " " }), "householdName");
  bad(() => buildFrameUpdateBody({ locale: "english please" }), "locale");
  const body = buildFrameUpdateBody({ householdName: "H", timezone: "America/New_York", locale: "en", ...{ openToPublic: true, messageViewability: "everyone", open_to_public: true } } as never);
  assert.deepEqual(Object.keys(body).sort(), ["household_name", "locale", "timezone"]);
});
