import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectTestClient } from "../helpers/test-server.js";
import type { MockRoute, RecordedCall } from "../helpers/mock-fetch.js";

const FRAMES: MockRoute = { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77" }] } };
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
const writes = (t: { calls: RecordedCall[] }) => t.calls.filter((c) => c.method !== "GET");
const F = "/api/frames/77";
const messages = fixture("messages") as { data: Array<{ id: string }> };
const albums = fixture("albums") as { data: Array<Record<string, unknown>> };
const photoRoutes: MockRoute[] = messages.data.map((m) => ({ method: "GET", path: `${F}/messages/${m.id}`, json: { data: m } }));

test("list photos sends the page and returns the page, page count and photos without any URL", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${F}/messages`, json: messages }]);
  const r = await t.callTool("skylight_list_photos", { page: 2 });
  assert.equal(t.calls.find((c) => c.url.pathname === `${F}/messages`)!.url.searchParams.get("page"), "2");
  const d = r.data as { page: number; pages: number; photos: Array<Record<string, unknown>> };
  assert.deepEqual([d.page, d.pages], [1, 2]);
  assert.deepEqual(d.photos[1], { id: "1794275814", type: "photo", createdAt: "2026-07-10T14:27:03-04:00", caption: "Beach day", from: "user@example.invalid", commentsCount: 0 });
  for (const secret of ["asset_url", "thumbnail", "example.invalid/asset", "bucket", "12311021"]) assert.ok(!r.text.includes(secret), secret);
  await t.callTool("skylight_list_photos");
  assert.equal(t.calls.filter((c) => c.url.pathname === `${F}/messages`)[1]!.url.searchParams.get("page"), "1");
  for (const page of [0, -1, 1.5]) assert.equal((await t.callTool("skylight_list_photos", { page })).isError, true, String(page));
  await t.close();
});

const ownerPage = (over: (m: Record<string, unknown>, i: number) => Record<string, unknown>) => ({
  ...messages, data: (messages.data as unknown as Array<{ attributes: Record<string, unknown> }>).map((m, i) => ({ ...m, attributes: over(m.attributes, i) })),
});

test("list photos shows \"you\" for photos the frame owner sent and never returns the owner's email", async () => {
  const page = ownerPage((a, i) => (i === 0 ? { ...a, from_email: "owner@example.invalid", sender_id: 12311021, frame_owner_id: 12311021 } : a));
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${F}/messages`, json: page }]);
  const r = await t.callTool("skylight_list_photos");
  assert.deepEqual((r.data as { photos: Array<{ from: string }> }).photos.map((p) => p.from), ["you", "user@example.invalid"]);
  assert.ok(!r.text.includes("owner@example.invalid"));
  assert.equal(t.calls.filter((c) => c.url.pathname === `${F}/users`).length, 0, "every message names the owner, so no extra request");
  await t.close();
});

test("list photos asks the frame users for the owner when messages do not carry frame_owner_id", async () => {
  const page = ownerPage((a, i) => { const { frame_owner_id: _gone, ...rest } = a; return i === 0 ? { ...rest, from_email: "owner@example.invalid", sender_id: 12311021 } : rest; });
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${F}/messages`, json: page }, { method: "GET", path: `${F}/users`, json: fixture("frame_users") }]);
  const r = await t.callTool("skylight_list_photos");
  assert.deepEqual((r.data as { photos: Array<{ from: string }> }).photos.map((p) => p.from), ["you", "user@example.invalid"]);
  assert.ok(!r.text.includes("owner@example.invalid"));
  await t.close();
});

test("list photos withholds senders (from: null) rather than risk the owner's email when the owner cannot be found", async () => {
  const page = ownerPage((a) => { const { frame_owner_id: _gone, ...rest } = a; return { ...rest, from_email: "owner@example.invalid", sender_id: 12311021 }; });
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${F}/messages`, json: page }, { method: "GET", path: `${F}/users`, status: 500, text: "boom" }]);
  const r = await t.callTool("skylight_list_photos");
  assert.equal(r.isError, false);
  assert.deepEqual((r.data as { photos: Array<{ from: string | null }> }).photos.map((p) => p.from), [null, null]);
  assert.ok(!r.text.includes("owner@example.invalid"));
  await t.close();
});

test("list photos shows creation times in the configured zone", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${F}/messages`, json: messages }], { env: { SKYLIGHT_TIMEZONE: "America/Los_Angeles" } });
  const d = (await t.callTool("skylight_list_photos")).data as { photos: Array<{ createdAt: string }> };
  assert.equal(d.photos[0]!.createdAt, "2026-07-10T11:27:09-07:00");
  await t.close();
});

test("update photo caption PUTs the caption; an empty caption clears it", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: `${F}/messages/1794275894/caption`, json: { data: { id: "1794275894" } } }]);
  const r = await t.callTool("skylight_update_photo_caption", { photoId: "1794275894", caption: "  First day " });
  assert.equal(r.isError, false);
  assert.deepEqual(writes(t).map((c) => [c.method, c.url.pathname, c.body]), [["PUT", `${F}/messages/1794275894/caption`, { caption: "First day" }]]);
  assert.deepEqual(r.data, { id: "1794275894", caption: "First day", updated: true });
  await t.callTool("skylight_update_photo_caption", { photoId: "1794275894", caption: "" });
  assert.deepEqual(writes(t)[1]!.body, { caption: "" });
  for (const args of [{ photoId: "x", caption: "a" }, { photoId: "1", caption: "x".repeat(201) }, { photoId: "../1", caption: "a" }]) assert.equal((await t.callTool("skylight_update_photo_caption", args)).isError, true);
  assert.equal(writes(t).length, 2);
  await t.close();
});

test("delete photos previews each photo's date and caption and writes nothing", async () => {
  const t = await connectTestClient([FRAMES, ...photoRoutes, { method: "DELETE", path: `${F}/messages/destroy_multiple`, json: {} }]);
  const r = await t.callTool("skylight_delete_photos", { photoIds: ["1794275894", "1794275814"] });
  const d = r.data as { confirmed: boolean; wouldDelete: { photos: Array<Record<string, unknown>> }; message: string };
  assert.equal(d.confirmed, false);
  assert.deepEqual(d.wouldDelete.photos, [
    { id: "1794275894", type: "photo", createdAt: "2026-07-10T14:27:09-04:00", caption: "" },
    { id: "1794275814", type: "photo", createdAt: "2026-07-10T14:27:03-04:00", caption: "Beach day" },
  ]);
  assert.match(d.message, /Nothing was deleted/);
  assert.match(d.message, /permanent/i);
  assert.match(d.message, /everyone/i);
  assert.match(d.message, /Beach day/);
  assert.match(d.message, /confirm: true/);
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("delete photos with confirm sends one DELETE /messages/destroy_multiple with numeric ids", async () => {
  const t = await connectTestClient([FRAMES, ...photoRoutes, { method: "DELETE", path: `${F}/messages/destroy_multiple`, json: {} }]);
  const r = await t.callTool("skylight_delete_photos", { photoIds: ["1794275894", "1794275814"], confirm: true });
  assert.deepEqual(r.data, { deleted: true, photoIds: ["1794275894", "1794275814"] });
  assert.deepEqual(writes(t).map((c) => [c.method, c.url.pathname, c.body]), [["DELETE", `${F}/messages/destroy_multiple`, { message_ids: [1794275894, 1794275814] }]]);
  await t.close();
});

test("delete photos: an unknown id is a validation error in the preview and on confirm, with no DELETE; bad input costs no request", async () => {
  const t = await connectTestClient([FRAMES, ...photoRoutes, { method: "GET", path: `${F}/messages/42`, status: 404, text: '{"error":"not found"}' }, { method: "DELETE", path: `${F}/messages/destroy_multiple`, json: {} }]);
  const preview = await t.callTool("skylight_delete_photos", { photoIds: ["1794275894", "42"] });
  assert.equal(preview.isError, true);
  assert.match(preview.text, /42/);
  assert.equal((await t.callTool("skylight_delete_photos", { photoIds: ["1794275894", "42"], confirm: true })).isError, true);
  assert.equal(writes(t).length, 0);
  const before = t.calls.length;
  for (const photoIds of [[], ["1", "1"], ["abc"], Array.from({ length: 51 }, (_, i) => String(i + 1))]) assert.equal((await t.callTool("skylight_delete_photos", { photoIds, confirm: true })).isError, true);
  assert.equal(t.calls.length, before);
  await t.close();
});

test("delete photos does not hide a server failure behind a validation message", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${F}/messages/7`, status: 500, text: "boom" }]);
  const r = await t.callTool("skylight_delete_photos", { photoIds: ["7"] });
  assert.equal(r.isError, true);
  assert.match(r.text, /500/);
  await t.close();
});

test("list albums maps the fixture", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${F}/albums`, json: albums }]);
  assert.deepEqual((await t.callTool("skylight_list_albums")).data, [{ id: "3001", title: "Summer", photoCount: 1, videoCount: 0, editable: true }]);
  await t.close();
});

test("create album POSTs { title } and returns the album", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: `${F}/albums`, json: { data: { id: "3002", type: "album_with_messages", attributes: { title: "Fall", editable: true, photos_count: 0, videos_count: 0 } } } }]);
  const r = await t.callTool("skylight_create_album", { title: " Fall " });
  assert.deepEqual(writes(t).map((c) => [c.url.pathname, c.body]), [[`${F}/albums`, { title: "Fall" }]]);
  assert.deepEqual(r.data, { id: "3002", title: "Fall", photoCount: 0, videoCount: 0, editable: true });
  for (const title of [" ", "x".repeat(101)]) assert.equal((await t.callTool("skylight_create_album", { title })).isError, true);
  assert.equal(writes(t).length, 1);
  await t.close();
});

test("rename album PATCHes { title } after finding the album", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${F}/albums`, json: albums }, { method: "PATCH", path: `${F}/albums/3001`, json: { data: { id: "3001", attributes: { title: "Summer 26", editable: true, photos_count: 1, videos_count: 0 } } } }]);
  const r = await t.callTool("skylight_rename_album", { albumId: "3001", title: "Summer 26" });
  assert.deepEqual(writes(t).map((c) => [c.method, c.url.pathname, c.body]), [["PATCH", `${F}/albums/3001`, { title: "Summer 26" }]]);
  assert.equal((r.data as { title: string }).title, "Summer 26");
  await t.close();
});

test("rename and delete album refuse an unknown album and one that is not editable, with no write", async () => {
  const locked = { data: [{ id: "3009", type: "album_with_messages", attributes: { title: "Favorites", kind: "system", editable: false, photos_count: 5, videos_count: 0 } }] };
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${F}/albums`, json: { data: [...albums.data, ...locked.data] } }, { method: "PATCH", path: /albums/, json: {} }, { method: "DELETE", path: /albums/, json: {} }]);
  for (const [tool, args] of [["skylight_rename_album", { albumId: "9999", title: "x" }], ["skylight_rename_album", { albumId: "3009", title: "x" }], ["skylight_delete_album", { albumId: "9999", confirm: true }], ["skylight_delete_album", { albumId: "3009", confirm: true }], ["skylight_delete_album", { albumId: "3009" }]] as const) {
    assert.equal((await t.callTool(tool, args)).isError, true, `${tool} ${JSON.stringify(args)}`);
  }
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("add and remove photos refuse an unknown or built-in album with no POST (the same check as rename and delete)", async () => {
  const locked = { id: "3009", type: "album_with_messages", attributes: { title: "Favorites", kind: "system", editable: false, photos_count: 5, videos_count: 0 } };
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${F}/albums`, json: { data: [...albums.data, locked] } }, { method: "POST", path: /albums/, json: {} }]);
  for (const tool of ["skylight_add_photos_to_album", "skylight_remove_photos_from_album"]) {
    const unknown = await t.callTool(tool, { albumId: "9999", photoIds: ["1"] });
    assert.equal(unknown.isError, true, tool);
    assert.match(unknown.text, /albumId: no album with that id/);
    const builtIn = await t.callTool(tool, { albumId: "3009", photoIds: ["1"] });
    assert.equal(builtIn.isError, true, tool);
    assert.match(builtIn.text, /built-in album that cannot be changed/);
  }
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("update photo caption maps a 404 to a validation error and lets other failures through", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: `${F}/messages/42/caption`, status: 404, text: '{"error":"not found"}' }, { method: "PUT", path: `${F}/messages/43/caption`, status: 500, text: "boom" }]);
  const missing = await t.callTool("skylight_update_photo_caption", { photoId: "42", caption: "x" });
  assert.equal(missing.isError, true);
  assert.equal(missing.text, "Invalid input. photoId: no photo with that id on this frame");
  const broken = await t.callTool("skylight_update_photo_caption", { photoId: "43", caption: "x" });
  assert.equal(broken.isError, true);
  assert.match(broken.text, /500/);
  assert.doesNotMatch(broken.text, /no photo with that id/);
  await t.close();
});

test("delete album previews that the photos stay on the frame, then DELETEs on confirm", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${F}/albums`, json: albums }, { method: "DELETE", path: `${F}/albums/3001`, json: {} }]);
  const r = await t.callTool("skylight_delete_album", { albumId: "3001" });
  const d = r.data as { confirmed: boolean; wouldDelete: Record<string, unknown>; message: string };
  assert.equal(d.confirmed, false);
  assert.deepEqual(d.wouldDelete, { id: "3001", title: "Summer", photoCount: 1, videoCount: 0 });
  assert.match(d.message, /Nothing was deleted/);
  assert.match(d.message, /photos (and videos )?stay on the frame/i);
  assert.equal(writes(t).length, 0);
  const done = await t.callTool("skylight_delete_album", { albumId: "3001", confirm: true });
  assert.deepEqual(done.data, { deleted: true, id: "3001" });
  assert.deepEqual(writes(t).map((c) => [c.method, c.url.pathname]), [["DELETE", `${F}/albums/3001`]]);
  await t.close();
});

test("add and remove photos POST numeric album_ids and message_ids, after checking the album", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${F}/albums`, json: albums }, { method: "POST", path: `${F}/albums/add_to`, json: {} }, { method: "POST", path: `${F}/albums/remove_from`, json: {} }]);
  const added = await t.callTool("skylight_add_photos_to_album", { albumId: "3001", photoIds: ["1794275894", "1794275814"] });
  assert.deepEqual(added.data, { added: 2, albumId: "3001", photoIds: ["1794275894", "1794275814"] });
  const removed = await t.callTool("skylight_remove_photos_from_album", { albumId: "3001", photoIds: ["1794275894"] });
  assert.deepEqual(removed.data, { removed: 1, albumId: "3001", photoIds: ["1794275894"] });
  assert.deepEqual(writes(t).map((c) => [c.url.pathname, c.body]), [
    [`${F}/albums/add_to`, { album_ids: [3001], message_ids: [1794275894, 1794275814] }],
    [`${F}/albums/remove_from`, { album_ids: [3001], message_ids: [1794275894] }],
  ]);
  assert.equal(t.calls.filter((c) => c.url.pathname === `${F}/albums`).length, 2, "each call looks the album up first");
  await t.close();
});

test("add and remove photos validate: 1..100 distinct numeric ids and a numeric album, before any request", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${F}/albums`, json: albums }, { method: "POST", path: `${F}/albums/add_to`, json: {} }]);
  for (const tool of ["skylight_add_photos_to_album", "skylight_remove_photos_from_album"]) {
    for (const args of [{ albumId: "3001", photoIds: [] }, { albumId: "3001", photoIds: ["1", "1"] }, { albumId: "summer", photoIds: ["1"] }, { albumId: "3001", photoIds: ["x"] }, { albumId: "3001", photoIds: Array.from({ length: 101 }, (_, i) => String(i + 1)) }]) {
      assert.equal((await t.callTool(tool, args)).isError, true, `${tool} ${JSON.stringify(args).slice(0, 60)}`);
    }
  }
  assert.equal(t.calls.length, 0);
  assert.equal((await t.callTool("skylight_add_photos_to_album", { albumId: "3001", photoIds: Array.from({ length: 100 }, (_, i) => String(i + 1)) })).isError, false, "exactly 100 ids is allowed");
  assert.equal(writes(t).length, 1);
  await t.close();
});

test("photo tools are annotated: read, update, destroy, create", async () => {
  const t = await connectTestClient([FRAMES]);
  const tools = new Map((await t.client.listTools()).tools.map((x) => [x.name, x]));
  const a = (n: string) => tools.get(n)!.annotations!;
  assert.equal(a("skylight_list_photos").readOnlyHint, true);
  assert.equal(a("skylight_list_albums").readOnlyHint, true);
  assert.equal(a("skylight_update_photo_caption").idempotentHint, true);
  assert.deepEqual([a("skylight_delete_photos").destructiveHint, a("skylight_delete_photos").idempotentHint], [true, false]);
  assert.deepEqual([a("skylight_delete_album").destructiveHint, a("skylight_delete_album").idempotentHint], [true, false]);
  assert.equal(a("skylight_create_album").idempotentHint, false);
  assert.equal(a("skylight_rename_album").idempotentHint, true);
  assert.equal(a("skylight_add_photos_to_album").idempotentHint, true);
  assert.equal(a("skylight_remove_photos_from_album").idempotentHint, true);
  assert.match(tools.get("skylight_delete_photos")!.description ?? "", /permanent/i);
  assert.match(tools.get("skylight_delete_photos")!.description ?? "", /confirm: true/);
  await t.close();
});
