import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectTestClient } from "../helpers/test-server.js";
import type { MockRoute, RecordedCall } from "../helpers/mock-fetch.js";

const FRAMES: MockRoute = { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77" }] } };
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
const writes = (t: { calls: RecordedCall[] }) => t.calls.filter((c) => c.method !== "GET");
const F = "/api/frames/77";
const devices = fixture("devices") as { data: Array<{ id: string; attributes: Record<string, unknown> }> };
const device = devices.data[0]!;
const DEVICE: MockRoute = { method: "GET", path: `${F}/devices/88`, json: { data: device } };

test("list devices maps the fixture", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${F}/devices`, json: devices }]);
  assert.deepEqual((await t.callTool("skylight_list_devices")).data, [{ id: "88", name: "Family Calendar", timezone: "America/New_York", brightness: 255, sleepsAt: "21:00", wakesAt: "06:00", sleeping: false, sleepModeOn: false, showCaption: true, showHeart: false, blurEffect: true, slideshowSpeed: 10, slideshowStyle: 0, startSound: false, currentAlbumId: "all" }]);
  await t.close();
});

test("update device PUTs only the provided fields and returns the device", async () => {
  const flipped = { data: { ...device, attributes: { ...device.attributes, show_heart: true } } };
  const t = await connectTestClient([FRAMES, { method: "PUT", path: `${F}/devices/88`, json: flipped }]);
  const r = await t.callTool("skylight_update_device", { deviceId: "88", showHeart: true });
  assert.equal(r.isError, false);
  assert.deepEqual(writes(t).map((c) => [c.method, c.url.pathname, c.body]), [["PUT", `${F}/devices/88`, { show_heart: true }]]);
  assert.equal((r.data as { showHeart: boolean; brightness: number }).showHeart, true);
  assert.equal((r.data as { brightness: number }).brightness, 255);
  await t.callTool("skylight_update_device", { deviceId: "88", name: " Kitchen ", brightness: 128, sleepsAt: "22:00", wakesAt: "06:30", sleepModeOn: true, showCaption: false, blurEffect: false, startSound: true, slideshowSpeed: 30, slideshowStyle: 2 });
  assert.deepEqual(writes(t)[1]!.body, { name: "Kitchen", brightness: 128, sleeps_at: "22:00", wakes_at: "06:30", sleep_mode_on: true, show_caption: false, blur_effect: false, start_sound: true, slideshow_speed: 30, slideshow_style: 2 });
  await t.close();
});

test("update device: albumId \"all\" sends -1 without a lookup; an album id is checked against the albums first", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: `${F}/devices/88`, json: { data: device } }, { method: "GET", path: `${F}/albums`, json: fixture("albums") }]);
  await t.callTool("skylight_update_device", { deviceId: "88", albumId: "all" });
  assert.deepEqual(writes(t)[0]!.body, { current_album_id: -1 });
  assert.equal(t.calls.filter((c) => c.url.pathname === `${F}/albums`).length, 0);
  await t.callTool("skylight_update_device", { deviceId: "88", albumId: "3001" });
  assert.deepEqual(writes(t)[1]!.body, { current_album_id: 3001 });
  const bad = await t.callTool("skylight_update_device", { deviceId: "88", albumId: "9999" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /albumId/);
  assert.equal(writes(t).length, 2);
  await t.close();
});

test("update device validates before any request: empty, ranges, times, ids", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: /devices/, json: { data: device } }]);
  const cases: Array<Record<string, unknown>> = [
    { deviceId: "88" }, { deviceId: "88", brightness: 300 }, { deviceId: "88", brightness: -1 }, { deviceId: "88", slideshowSpeed: 0 }, { deviceId: "88", slideshowSpeed: 3601 },
    { deviceId: "88", slideshowStyle: 11 }, { deviceId: "88", sleepsAt: "9pm" }, { deviceId: "88", wakesAt: "25:00" }, { deviceId: "88", name: " " }, { deviceId: "88", name: "x".repeat(61) },
    { deviceId: "../88", showHeart: true }, { deviceId: "abc", showHeart: true }, { deviceId: "88", albumId: "summer" },
  ];
  for (const args of cases) assert.equal((await t.callTool("skylight_update_device", args)).isError, true, JSON.stringify(args));
  assert.equal(t.calls.length, 0);
  assert.equal((await t.callTool("skylight_update_device", { deviceId: "88", brightness: 0 })).isError, false);
  assert.deepEqual(writes(t)[0]!.body, { brightness: 0 });
  await t.close();
});

test("set device sleep POSTs start_sleep or end_sleep with no body", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: `${F}/devices/88/start_sleep`, json: {} }, { method: "POST", path: `${F}/devices/88/end_sleep`, json: {} }]);
  assert.deepEqual((await t.callTool("skylight_set_device_sleep", { deviceId: "88", asleep: true })).data, { deviceId: "88", asleep: true });
  assert.deepEqual((await t.callTool("skylight_set_device_sleep", { deviceId: "88", asleep: false })).data, { deviceId: "88", asleep: false });
  assert.deepEqual(writes(t).map((c) => [c.method, c.url.pathname, c.body]), [["POST", `${F}/devices/88/start_sleep`, null], ["POST", `${F}/devices/88/end_sleep`, null]]);
  assert.equal((await t.callTool("skylight_set_device_sleep", { deviceId: "x", asleep: true })).isError, true);
  assert.equal((await t.callTool("skylight_set_device_sleep", { deviceId: "88" })).isError, true);
  await t.close();
});

const DESTROY_ROUTES: MockRoute[] = [FRAMES, DEVICE, { method: "POST", path: `${F}/devices/88/reset`, json: {} }, { method: "DELETE", path: `${F}/devices/88`, json: {} }];

for (const [tool, wording, key] of [["skylight_reset_device", "the screen is wiped and must be set up again", "wouldReset"], ["skylight_remove_device", "the device leaves this frame", "wouldRemove"]] as const) {
  test(`${tool} without both confirmName and confirm only previews the device and what happens, and writes nothing`, async () => {
    const t = await connectTestClient(DESTROY_ROUTES);
    for (const args of [{ deviceId: "88" }, { deviceId: "88", confirm: true }, { deviceId: "88", confirmName: "Family Calendar" }, { deviceId: "88", confirm: false, confirmName: "Family Calendar" }]) {
      const r = await t.callTool(tool, args);
      assert.equal(r.isError, false, JSON.stringify(args));
      const d = r.data as { confirmed: boolean; message: string } & Record<string, unknown>;
      assert.equal(d.confirmed, false);
      assert.deepEqual(d[key], { id: "88", name: "Family Calendar" });
      assert.match(d.message, /Nothing was/);
      assert.ok(d.message.includes(wording), d.message);
      assert.match(d.message, /Family Calendar/);
      assert.match(d.message, /confirmName/);
    }
    assert.equal(writes(t).length, 0);
    await t.close();
  });

  test(`${tool} refuses a confirmName that is not the exact device name, naming the expected one`, async () => {
    const t = await connectTestClient(DESTROY_ROUTES);
    for (const confirmName of ["family calendar", "Family Calendar ", "Kitchen", ""]) {
      for (const confirm of [true, false]) {
        const r = await t.callTool(tool, { deviceId: "88", confirmName, confirm });
        assert.equal(r.isError, true, JSON.stringify({ confirmName, confirm }));
        assert.match(r.text, /Family Calendar/);
        assert.match(r.text, /confirmName/);
      }
    }
    assert.equal(writes(t).length, 0);
    await t.close();
  });
}

test("reset device with the exact name and confirm POSTs /reset; remove device DELETEs the device", async () => {
  const t = await connectTestClient(DESTROY_ROUTES);
  const reset = await t.callTool("skylight_reset_device", { deviceId: "88", confirmName: "Family Calendar", confirm: true });
  assert.deepEqual(reset.data, { reset: true, id: "88", name: "Family Calendar" });
  const removed = await t.callTool("skylight_remove_device", { deviceId: "88", confirmName: "Family Calendar", confirm: true });
  assert.deepEqual(removed.data, { removed: true, id: "88", name: "Family Calendar" });
  assert.deepEqual(writes(t).map((c) => [c.method, c.url.pathname, c.body]), [["POST", `${F}/devices/88/reset`, null], ["DELETE", `${F}/devices/88`, null]]);
  await t.close();
});

test("destroying a device with a bad id or an unknown device sends nothing", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${F}/devices/5`, status: 404, text: "{}" }, ...DESTROY_ROUTES.slice(2)]);
  for (const tool of ["skylight_reset_device", "skylight_remove_device"]) {
    assert.equal((await t.callTool(tool, { deviceId: "../88", confirmName: "x", confirm: true })).isError, true);
    assert.equal((await t.callTool(tool, { deviceId: "5", confirmName: "x", confirm: true })).isError, true);
  }
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("device tools are annotated: read, update, sleep, destroy", async () => {
  const t = await connectTestClient([FRAMES]);
  const tools = new Map((await t.client.listTools()).tools.map((x) => [x.name, x]));
  const a = (n: string) => tools.get(n)!.annotations!;
  assert.equal(a("skylight_list_devices").readOnlyHint, true);
  assert.equal(a("skylight_update_device").idempotentHint, true);
  assert.equal(a("skylight_set_device_sleep").idempotentHint, true);
  for (const n of ["skylight_reset_device", "skylight_remove_device"]) {
    assert.deepEqual([a(n).destructiveHint, a(n).idempotentHint, a(n).openWorldHint], [true, false, false], n);
    assert.match(tools.get(n)!.description ?? "", /confirmName/);
    assert.match(tools.get(n)!.description ?? "", /confirm: true/);
  }
  assert.match(tools.get("skylight_reset_device")!.description ?? "", /wiped/);
  assert.match(tools.get("skylight_update_device")!.description ?? "", /alarm/i);
  await t.close();
});
