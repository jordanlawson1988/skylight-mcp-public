import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectTestClient } from "../helpers/test-server.js";
import type { MockRoute, RecordedCall } from "../helpers/mock-fetch.js";

const FRAMES: MockRoute = { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77" }] } };
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
const writes = (t: { calls: RecordedCall[] }) => t.calls.filter((c) => c.method !== "GET");
const F = "/api/frames/77";
const FRAME: MockRoute = { method: "GET", path: F, json: fixture("frame") };
const USERS: MockRoute = { method: "GET", path: `${F}/users`, json: fixture("frame_users") };
const frameUsers = fixture("frame_users") as { data: Array<Record<string, unknown>>; included: Array<{ id: string; type: string; attributes: { email: string } }> };
// Distinct addresses and statuses so the tools can be told apart.
const usersJson = {
  data: [
    { id: "1", type: "frame_user", attributes: { status: "approved", is_owner: true }, relationships: { user: { data: { id: "100" } } } },
    { id: "2", type: "frame_user", attributes: { status: "approved", is_owner: false }, relationships: { user: { data: { id: "200" } } } },
    { id: "3", type: "frame_user", attributes: { status: "rejected", is_owner: false }, relationships: { user: { data: { id: "300" } } } },
    { id: "4", type: "frame_user", attributes: { status: "awaiting_approval", is_owner: false }, relationships: { user: { data: { id: "400" } } } },
  ],
  included: [100, 200, 300, 400].map((id) => ({ id: String(id), type: "user", attributes: { email: `u${id}@example.com` } })),
};
const NAMED_USERS: MockRoute = { method: "GET", path: `${F}/users`, json: usersJson };

test("get frame returns the settings and feature flags, and none of the secrets", async () => {
  const t = await connectTestClient([FRAMES, FRAME]);
  const r = await t.callTool("skylight_get_frame");
  const d = r.data as { id: string; features: Record<string, boolean> } & Record<string, unknown>;
  assert.deepEqual([d.id, d.name, d.timezone, d.householdName, d.locale, d.photosOpenToPublic, d.photoViewability, d.plus], ["77", "familyframe", "America/New_York", null, "en", false, "only_viewable_to_owner", true]);
  assert.equal(d.features.chores, true);
  assert.equal(d.features.lists, true);
  assert.equal(d.features.meals, true);
  assert.equal(d.features.dinner_plans, false);
  for (const secret of ["share_token", "notification_email", "owner_birthday", "owner_name", "hardware_model", "12311021"]) assert.ok(!r.text.includes(secret), secret);
  assert.deepEqual(t.calls.filter((c) => c.url.pathname === F).map((c) => c.method), ["GET"]);
  await t.close();
});

test("update frame PUTs only household name, timezone and locale", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: F, json: fixture("frame") }]);
  const r = await t.callTool("skylight_update_frame", { timezone: "America/New_York" });
  assert.equal(r.isError, false);
  assert.deepEqual(writes(t).map((c) => [c.method, c.url.pathname, c.body]), [["PUT", F, { timezone: "America/New_York" }]]);
  assert.equal((r.data as { timezone: string }).timezone, "America/New_York");
  assert.ok(!r.text.includes("share_token"));
  await t.callTool("skylight_update_frame", { householdName: " The Lawsons ", locale: "en" });
  assert.deepEqual(writes(t)[1]!.body, { household_name: "The Lawsons", locale: "en" });
  await t.callTool("skylight_update_frame", { householdName: null });
  assert.deepEqual(writes(t)[2]!.body, { household_name: null });
  await t.close();
});

test("update frame validates before any request, and exposes no photo privacy fields", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: F, json: fixture("frame") }]);
  for (const args of [{}, { timezone: "Mars/Olympus" }, { householdName: "x".repeat(61) }, { householdName: " " }, { locale: "english please" }]) {
    assert.equal((await t.callTool("skylight_update_frame", args)).isError, true, JSON.stringify(args));
  }
  assert.equal(t.calls.length, 0);
  const tool = (await t.client.listTools()).tools.find((x) => x.name === "skylight_update_frame")!;
  assert.deepEqual(Object.keys((tool.inputSchema as { properties: object }).properties).sort(), ["householdName", "locale", "timezone"]);
  // extra keys are dropped by the schema, never forwarded
  await t.callTool("skylight_update_frame", { timezone: "America/Chicago", open_to_public: true, openToPublic: true, messageViewability: "everyone" });
  assert.deepEqual(writes(t)[0]!.body, { timezone: "America/Chicago" });
  await t.close();
});

test("list frame users maps the fixture", async () => {
  const t = await connectTestClient([FRAMES, USERS]);
  const r = await t.callTool("skylight_list_frame_users");
  assert.equal((r.data as unknown[]).length, 4);
  assert.deepEqual((r.data as unknown[])[3], { userId: "12311021", email: "user@example.invalid", status: "approved", owner: true });
  assert.deepEqual(frameUsers.data.length, 4);
  await t.close();
});

test("invite frame user previews first: the email is validated, nothing is sent, and the message says Skylight will email an invitation", async () => {
  const t = await connectTestClient([FRAMES, NAMED_USERS, { method: "POST", path: `${F}/users`, json: {} }]);
  const r = await t.callTool("skylight_invite_frame_user", { email: " New.Person@Example.com " });
  const d = r.data as { confirmed: boolean; wouldInvite: { email: string }; message: string };
  assert.equal(d.confirmed, false);
  assert.deepEqual(d.wouldInvite, { email: "new.person@example.com" });
  assert.match(d.message, /Skylight will email an invitation to new\.person@example\.com/);
  assert.match(d.message, /confirm: true/);
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("invite frame user with confirm POSTs { email }", async () => {
  const t = await connectTestClient([FRAMES, NAMED_USERS, { method: "POST", path: `${F}/users`, json: { data: {} } }]);
  const r = await t.callTool("skylight_invite_frame_user", { email: "new@example.com", confirm: true });
  assert.deepEqual(r.data, { invited: true, email: "new@example.com" });
  assert.deepEqual(writes(t).map((c) => [c.method, c.url.pathname, c.body]), [["POST", `${F}/users`, { email: "new@example.com" }]]);
  await t.close();
});

test("invite frame user refuses a bad address and one already on the frame, with no POST", async () => {
  const t = await connectTestClient([FRAMES, NAMED_USERS, { method: "POST", path: `${F}/users`, json: {} }]);
  for (const email of ["nope", "a@b", "a b@c.com", ""]) assert.equal((await t.callTool("skylight_invite_frame_user", { email, confirm: true })).isError, true, email);
  const dup = await t.callTool("skylight_invite_frame_user", { email: "U200@example.com", confirm: true });
  assert.equal(dup.isError, true);
  assert.match(dup.text, /already/i);
  assert.equal((await t.callTool("skylight_invite_frame_user", { email: "u300@example.com" })).isError, true, "also in the preview");
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("block frame user previews, refuses the owner, and DELETEs the user id on confirm", async () => {
  const t = await connectTestClient([FRAMES, NAMED_USERS, { method: "DELETE", path: `${F}/users/200`, json: {} }]);
  const preview = await t.callTool("skylight_block_frame_user", { userId: "200" });
  const d = preview.data as { confirmed: boolean; wouldBlock: Record<string, unknown>; message: string };
  assert.equal(d.confirmed, false);
  assert.deepEqual(d.wouldBlock, { userId: "200", email: "u200@example.com", status: "approved" });
  assert.match(d.message, /Nothing was changed/);
  assert.match(d.message, /u200@example\.com/);
  assert.equal(writes(t).length, 0);
  const owner = await t.callTool("skylight_block_frame_user", { userId: "100", confirm: true });
  assert.equal(owner.isError, true);
  assert.match(owner.text, /owner/i);
  assert.equal((await t.callTool("skylight_block_frame_user", { userId: "100" })).isError, true, "refused in the preview too");
  assert.equal((await t.callTool("skylight_block_frame_user", { userId: "999", confirm: true })).isError, true);
  assert.equal((await t.callTool("skylight_block_frame_user", { userId: "300", confirm: true })).isError, true, "already blocked");
  assert.equal(writes(t).length, 0);
  const done = await t.callTool("skylight_block_frame_user", { userId: "200", confirm: true });
  assert.deepEqual(done.data, { blocked: true, userId: "200", email: "u200@example.com" });
  assert.deepEqual(writes(t).map((c) => [c.method, c.url.pathname]), [["DELETE", `${F}/users/200`]]);
  await t.close();
});

test("unblock frame user POSTs /approve for a blocked or waiting user and refuses one who already has access", async () => {
  const t = await connectTestClient([FRAMES, NAMED_USERS, { method: "POST", path: /\/users\/\d+\/approve$/, json: {} }]);
  assert.deepEqual((await t.callTool("skylight_unblock_frame_user", { userId: "300" })).data, { unblocked: true, userId: "300", email: "u300@example.com" });
  assert.equal((await t.callTool("skylight_unblock_frame_user", { userId: "400" })).isError, false);
  assert.deepEqual(writes(t).map((c) => [c.method, c.url.pathname, c.body]), [["POST", `${F}/users/300/approve`, null], ["POST", `${F}/users/400/approve`, null]]);
  for (const userId of ["200", "100", "999", "../1"]) assert.equal((await t.callTool("skylight_unblock_frame_user", { userId })).isError, true, userId);
  assert.equal(writes(t).length, 2);
  await t.close();
});

test("sharing tools are annotated: only the invite reaches outside the family", async () => {
  const t = await connectTestClient([FRAMES]);
  const tools = new Map((await t.client.listTools()).tools.map((x) => [x.name, x]));
  const a = (n: string) => tools.get(n)!.annotations!;
  assert.equal(a("skylight_get_frame").readOnlyHint, true);
  assert.equal(a("skylight_list_frame_users").readOnlyHint, true);
  assert.equal(a("skylight_update_frame").idempotentHint, true);
  assert.deepEqual([a("skylight_invite_frame_user").destructiveHint, a("skylight_invite_frame_user").idempotentHint, a("skylight_invite_frame_user").openWorldHint], [false, false, true]);
  assert.deepEqual([a("skylight_block_frame_user").destructiveHint, a("skylight_block_frame_user").idempotentHint], [true, false]);
  assert.equal(a("skylight_unblock_frame_user").idempotentHint, true);
  assert.match(tools.get("skylight_invite_frame_user")!.description ?? "", /email/i);
  assert.match(tools.get("skylight_invite_frame_user")!.description ?? "", /confirm: true/);
  assert.match(tools.get("skylight_block_frame_user")!.description ?? "", /confirm: true/);
  for (const [name, tool] of tools) if (name !== "skylight_invite_frame_user") assert.equal(tool.annotations!.openWorldHint, false, name);
  await t.close();
});
