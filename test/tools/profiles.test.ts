import { test } from "node:test";
import assert from "node:assert/strict";
import { connectTestClient } from "../helpers/test-server.js";

const FRAMES = { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77", attributes: { household_name: "L" } }] } } as const;

test("tool list contains only expected tools with full annotations", async () => {
  const t = await connectTestClient([FRAMES]);
  const { tools } = await t.client.listTools();
  const names = tools.map((x) => x.name).sort();
  assert.ok(names.includes("skylight_auth_status"));
  assert.ok(names.includes("skylight_list_profiles"));
  for (const bad of ["delete_account", "user_delete", "photo", "device", "invite", "frame_transfer"]) {
    assert.ok(!names.some((n) => n.includes(bad)), `unexpected tool matching ${bad}`);
  }
  for (const tool of tools) {
    const a = tool.annotations ?? {};
    for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) assert.equal(typeof (a as Record<string, unknown>)[k], "boolean", `${tool.name}.${k}`);
    assert.equal((a as Record<string, unknown>).openWorldHint, false);
  }
  await t.close();
});

test("skylight_auth_status never leaks tokens", async () => {
  const t = await connectTestClient([FRAMES]);
  const r = await t.callTool("skylight_auth_status");
  assert.equal(r.isError, false);
  assert.equal((r.data as { loggedIn: boolean }).loggedIn, true);
  assert.equal((r.data as { frameId: string }).frameId, "77");
  assert.ok(!r.text.includes("AT") && !r.text.includes("RT"));
  await t.close();
});

test("skylight_list_profiles maps categories", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/categories", json: { data: [{ id: "12", attributes: { label: "Ellie", color: "#f00", linked_to_profile: true, selected_for_chore_chart: false } }] } }]);
  const r = await t.callTool("skylight_list_profiles");
  assert.equal(r.isError, false);
  assert.deepEqual(r.data, [{ id: "12", name: "Ellie", color: "#f00", kind: "profile", onChoreChart: false }]);
  await t.close();
});

test("logged-out call returns a tool error pointing at login, not a crash", async () => {
  const t = await connectTestClient([FRAMES], { loggedIn: false });
  const r = await t.callTool("skylight_list_profiles");
  assert.equal(r.isError, true);
  assert.match(r.text, /skylight-mcp login/);
  await t.close();
});

// ---- profile create / update / delete ----
import type { MockRoute } from "../helpers/mock-fetch.js";

const cat = (id: string, label: string, linked: boolean) => ({ id, type: "category", attributes: { label, color: "#111111", linked_to_profile: linked, selected_for_chore_chart: linked } });
const CATS: MockRoute = { method: "GET", path: "/api/frames/77/categories", json: { data: [cat("12", "Ellie", true), cat("13", "Birthdays", false), cat("14", "Sam", true)] } };
const choreFor = (id: string, ...cats: string[]) => ({ id, type: "chore", attributes: { summary: `c${id}`, start: "2026-10-13" }, relationships: { category: { data: cats.map((c) => ({ id: c, type: "category" })) } } });
const CHORES: MockRoute = { method: "GET", path: "/api/frames/77/chores", json: { data: [choreFor("1", "12"), choreFor("2", "12", "14"), choreFor("3", "14")] } };
const writes = (t: { calls: Array<{ method: string }> }) => t.calls.filter((c) => c.method !== "GET");

test("create profile sends the exact body and returns the mapped profile", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/categories", status: 201, json: { data: cat("99", "Ellie", true) } }]);
  const r = await t.callTool("skylight_create_profile", { name: "Ellie", color: "#cb434c" });
  assert.equal(r.isError, false);
  assert.deepEqual(r.data, { id: "99", name: "Ellie", color: "#111111", kind: "profile", onChoreChart: true });
  const post = t.calls.find((c) => c.method === "POST")!;
  assert.deepEqual(post.body, { label: "Ellie", color: "#CB434C", linked_to_profile: true, selected_for_chore_chart: true });
  assert.equal(post.url.search, "");
  await t.close();
});

test("create profile with kind label sends both flags false; empty response gets a warning", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/categories", json: {} }]);
  const r = await t.callTool("skylight_create_profile", { name: "Birthdays", color: "#123456", kind: "label" });
  assert.deepEqual(t.calls.find((c) => c.method === "POST")!.body, { label: "Birthdays", color: "#123456", linked_to_profile: false, selected_for_chore_chart: false });
  const d = r.data as { created: boolean; warning: string };
  assert.equal(d.created, true);
  assert.match(d.warning, /list profiles/);
  await t.close();
});

test("create profile rejects bad color or kind before any request", async () => {
  const t = await connectTestClient([FRAMES]);
  assert.equal((await t.callTool("skylight_create_profile", { name: "A", color: "red" })).isError, true);
  let bad = false;
  try { bad = (await t.callTool("skylight_create_profile", { name: "A", color: "#123456", kind: "adult" })).isError; } catch { bad = true; }
  assert.equal(bad, true);
  assert.equal(t.calls.length, 0);
  await t.close();
});

test("update profile with only kind label sends both flags false", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/categories/12", json: { data: cat("12", "Ellie", false) } }]);
  const r = await t.callTool("skylight_update_profile", { profileId: "12", kind: "label" });
  assert.equal(r.isError, false);
  assert.equal((r.data as { kind: string }).kind, "label");
  assert.deepEqual(t.calls.find((c) => c.method === "PUT")!.body, { linked_to_profile: false, selected_for_chore_chart: false });
  await t.close();
});

test("update profile sends only the provided fields; empty update and bad id are rejected before any request", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/categories/12", json: {} }]);
  const ok = await t.callTool("skylight_update_profile", { profileId: "12", name: "Ellie B", color: "#abcdef" });
  assert.deepEqual(t.calls.find((c) => c.method === "PUT")!.body, { label: "Ellie B", color: "#ABCDEF" });
  assert.deepEqual(ok.data, { id: "12", updated: true });
  const before = t.calls.length;
  assert.equal((await t.callTool("skylight_update_profile", { profileId: "12" })).isError, true);
  assert.equal((await t.callTool("skylight_update_profile", { profileId: "../x", name: "A" })).isError, true);
  assert.equal(t.calls.length, before);
  await t.close();
});

test("delete preview for a profile makes no DELETE, counts upcoming chores, and offers the label alternative", async () => {
  const t = await connectTestClient([FRAMES, CATS, CHORES]);
  const r = await t.callTool("skylight_delete_profile", { profileId: "12" });
  assert.equal(r.isError, false);
  const d = r.data as { confirmed: boolean; wouldDelete: Record<string, unknown>; message: string };
  assert.equal(d.confirmed, false);
  assert.deepEqual(d.wouldDelete, { id: "12", name: "Ellie", kind: "profile", upcomingChores: 2, reassignTo: null });
  assert.match(d.message, /Nothing was deleted\./);
  assert.match(d.message, /chores and events will be deleted with it/);
  assert.match(d.message, /skylight_update_profile with kind: "label"/);
  assert.match(d.message, /confirm: true/);
  assert.equal(writes(t).length, 0);
  const q = t.calls.find((c) => c.url.pathname.endsWith("/chores"))!.url.searchParams;
  assert.equal(q.get("include_late"), "true");
  assert.equal(q.get("include_up_for_grabs"), "false");
  assert.equal(q.get("filter"), "linked_to_profile");
  assert.match(q.get("after")!, /^\d{4}-\d{2}-\d{2}$/);
  const days = (Date.parse(q.get("before")!) - Date.parse(q.get("after")!)) / 86_400_000;
  assert.equal(days, 90);
  assert.equal(t.calls.filter((c) => c.url.pathname.endsWith("/categories")).length, 1);
  await t.close();
});

test("delete preview for a label omits the alternative; reassign target is named", async () => {
  const t = await connectTestClient([FRAMES, CATS, CHORES]);
  const label = (await t.callTool("skylight_delete_profile", { profileId: "13" })).data as { message: string };
  assert.doesNotMatch(label.message, /skylight_update_profile/);
  const re = (await t.callTool("skylight_delete_profile", { profileId: "12", reassignToProfileId: "14" })).data as { wouldDelete: { reassignTo: unknown }; message: string };
  assert.deepEqual(re.wouldDelete.reassignTo, { id: "14", name: "Sam" });
  assert.match(re.message, /Its chores and events will move to Sam\./);
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("delete preview uses null upcomingChores when the chore lookup fails", async () => {
  const t = await connectTestClient([FRAMES, CATS, { method: "GET", path: "/api/frames/77/chores", status: 500, text: "boom" }]);
  const r = await t.callTool("skylight_delete_profile", { profileId: "12" });
  assert.equal(r.isError, false);
  assert.equal((r.data as { wouldDelete: { upcomingChores: unknown } }).wouldDelete.upcomingChores, null);
  await t.close();
});

test("delete with confirm sends DELETE without a query by default", async () => {
  const t = await connectTestClient([FRAMES, CATS, { method: "DELETE", path: "/api/frames/77/categories/13", status: 204 }]);
  const r = await t.callTool("skylight_delete_profile", { profileId: "13", confirm: true });
  assert.equal(r.isError, false);
  assert.deepEqual(r.data, { deleted: true, id: "13", reassignedTo: null });
  const del = t.calls.find((c) => c.method === "DELETE")!;
  assert.equal(del.url.search, "");
  await t.close();
});

test("delete with confirm and reassignToProfileId sends reassign_to_category_id", async () => {
  const t = await connectTestClient([FRAMES, CATS, { method: "DELETE", path: "/api/frames/77/categories/12", status: 204 }]);
  const r = await t.callTool("skylight_delete_profile", { profileId: "12", reassignToProfileId: "14", confirm: true });
  assert.deepEqual(r.data, { deleted: true, id: "12", reassignedTo: "14" });
  assert.equal(t.calls.find((c) => c.method === "DELETE")!.url.searchParams.get("reassign_to_category_id"), "14");
  await t.close();
});

test("delete rejects same-id reassign and bad ids before any request", async () => {
  const t = await connectTestClient([FRAMES, CATS]);
  const same = await t.callTool("skylight_delete_profile", { profileId: "12", reassignToProfileId: "12", confirm: true });
  assert.equal(same.isError, true);
  assert.match(same.text, /reassignToProfileId: must be a different profile/);
  assert.equal((await t.callTool("skylight_delete_profile", { profileId: "a/b", confirm: true })).isError, true);
  assert.equal((await t.callTool("skylight_delete_profile", { profileId: "12", reassignToProfileId: "../x", confirm: true })).isError, true);
  assert.equal(t.calls.length, 0);
  await t.close();
});

test("delete rejects an unknown profile or unknown reassign target without deleting", async () => {
  const t = await connectTestClient([FRAMES, CATS]);
  const unknown = await t.callTool("skylight_delete_profile", { profileId: "999", confirm: true });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /profileId: not found on this frame/);
  const target = await t.callTool("skylight_delete_profile", { profileId: "12", reassignToProfileId: "999", confirm: true });
  assert.equal(target.isError, true);
  assert.match(target.text, /reassignToProfileId: not found on this frame/);
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("profile tools have the right annotations", async () => {
  const t = await connectTestClient([FRAMES]);
  const { tools } = await t.client.listTools();
  const ann = (n: string) => tools.find((x) => x.name === n)!.annotations!;
  assert.equal(ann("skylight_delete_profile").destructiveHint, true);
  assert.equal(ann("skylight_create_profile").destructiveHint, false);
  assert.equal(ann("skylight_update_profile").idempotentHint, true);
  assert.match(tools.find((x) => x.name === "skylight_update_profile")!.description!, /Convert to Label/);
  await t.close();
});

test("upcomingChores counts distinct chores, not occurrences", async () => {
  const occ = (date: string) => ({ id: `5-${date}`, type: "chore", attributes: { summary: "Dishes", start: date, series: "5", recurring: true }, relationships: { category: { data: { id: "12", type: "category" } } } });
  const chores: MockRoute = { method: "GET", path: "/api/frames/77/chores", json: { data: [occ("2026-10-13"), occ("2026-10-14"), occ("2026-10-15"), choreFor("1", "12"), choreFor("3", "14")] } };
  const t = await connectTestClient([FRAMES, CATS, chores]);
  const r = await t.callTool("skylight_delete_profile", { profileId: "12" });
  assert.equal((r.data as { wouldDelete: { upcomingChores: number } }).wouldDelete.upcomingChores, 2);
  await t.close();
});

test("update with kind profile sends both flags true", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/categories/13", json: { data: cat("13", "Birthdays", true) } }]);
  const r = await t.callTool("skylight_update_profile", { profileId: "13", kind: "profile" });
  assert.equal(r.isError, false);
  assert.deepEqual(t.calls.find((c) => c.method === "PUT")!.body, { linked_to_profile: true, selected_for_chore_chart: true });
  await t.close();
});

test("delete with confirm: false sends no DELETE", async () => {
  const t = await connectTestClient([FRAMES, CATS, CHORES]);
  const r = await t.callTool("skylight_delete_profile", { profileId: "12", confirm: false });
  assert.equal((r.data as { confirmed: boolean }).confirmed, false);
  assert.equal(t.calls.filter((c) => c.method === "DELETE").length, 0);
  await t.close();
});

test("confirmed delete never fetches chores", async () => {
  const t = await connectTestClient([FRAMES, CATS, { method: "DELETE", path: "/api/frames/77/categories/12", status: 204 }]);
  await t.callTool("skylight_delete_profile", { profileId: "12", confirm: true });
  await t.callTool("skylight_delete_profile", { profileId: "12", reassignToProfileId: "14", confirm: true });
  assert.ok(!t.calls.some((c) => c.method === "GET" && c.url.pathname.endsWith("/chores")));
  assert.equal(t.calls.filter((c) => c.method === "DELETE").length, 2);
  await t.close();
});

test("preview with reassign sends no DELETE", async () => {
  const t = await connectTestClient([FRAMES, CATS, CHORES]);
  const r = await t.callTool("skylight_delete_profile", { profileId: "12", reassignToProfileId: "14" });
  assert.equal((r.data as { confirmed: boolean }).confirmed, false);
  assert.equal(t.calls.filter((c) => c.method === "DELETE").length, 0);
  await t.close();
});
