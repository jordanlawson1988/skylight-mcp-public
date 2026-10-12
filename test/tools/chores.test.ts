import { test } from "node:test";
import assert from "node:assert/strict";
import { connectTestClient } from "../helpers/test-server.js";
import type { MockRoute } from "../helpers/mock-fetch.js";

const FRAMES: MockRoute = { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77" }] } };
const chore = (id: string, summary: string) => ({ id, type: "chore", attributes: { summary, start: "2026-10-13" }, relationships: { category: { data: { id: "12" } } } });

test("list chores passes query and maps", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/chores", json: { data: [chore("1", "Dishes")] } }]);
  const r = await t.callTool("skylight_list_chores", { after: "2026-10-01", before: "2026-10-31" });
  assert.equal(r.isError, false);
  assert.equal((r.data as Array<{ summary: string }>)[0]!.summary, "Dishes");
  const q = t.calls.at(-1)!.url.searchParams;
  assert.equal(q.get("after"), "2026-10-01");
  assert.equal(q.get("include_late"), "true");
  assert.equal(q.get("include_up_for_grabs"), "false");
  assert.equal(q.get("filter"), "linked_to_profile");
  await t.close();
});

test("list chores rejects reversed range without a request", async () => {
  const t = await connectTestClient([FRAMES]);
  const r = await t.callTool("skylight_list_chores", { after: "2026-10-31", before: "2026-10-01" });
  assert.equal(r.isError, true);
  assert.ok(!t.calls.some((c) => c.url.pathname.endsWith("/chores")));
  await t.close();
});

test("create chore posts create_multiple body", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/chores/create_multiple", json: { data: [chore("5", "Feed dog")] } }]);
  const r = await t.callTool("skylight_create_chore", { summary: "Feed dog", start: "2026-10-13", profileIds: ["12"], recurrence: { frequency: "daily" }, rewardPoints: 2 });
  assert.equal(r.isError, false);
  const body = t.calls.at(-1)!.body as Record<string, unknown>;
  assert.equal(body.summary, "Feed dog");
  assert.deepEqual(body.recurrence_set, ["RRULE:FREQ=DAILY"]);
  assert.deepEqual(body.category_ids, ["12"]);
  assert.equal((r.data as { id: string }).id, "5");
  await t.close();
});

test("bulk create: dryRun makes no requests and returns payloads", async () => {
  const t = await connectTestClient([FRAMES]);
  const r = await t.callTool("skylight_bulk_create_chores", { dryRun: true, chores: [{ summary: "A", start: "2026-10-13", profileIds: ["12"] }, { summary: "B", start: "2026-10-13", profileIds: ["13"], routine: true }] });
  assert.equal(r.isError, false);
  const d = r.data as { dryRun: boolean; results: Array<{ ok: boolean; payload?: { routine: boolean } }> };
  assert.equal(d.dryRun, true);
  assert.equal(d.results.length, 2);
  assert.equal(d.results[1]!.payload!.routine, true);
  assert.ok(!t.calls.some((c) => c.method === "POST"));
  await t.close();
});

test("bulk create: invalid item is reported, valid items still created, no request for invalid", async () => {
  let n = 0;
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/chores/create_multiple", handler: () => ({ json: { data: [chore(String(++n), "x")] } }) }]);
  const r = await t.callTool("skylight_bulk_create_chores", { chores: [
    { summary: "A", start: "2026-10-13", profileIds: ["12"] },
    { summary: "B", start: "2026-02-30", profileIds: ["12"] },
    { summary: "C", start: "2026-10-13", profileIds: ["12"] },
  ] });
  const d = r.data as { created: number; failed: number; results: Array<{ index: number; ok: boolean; id?: string; error?: string }> };
  assert.equal(d.created, 2);
  assert.equal(d.failed, 1);
  assert.equal(d.results[1]!.ok, false);
  assert.match(d.results[1]!.error!, /start/);
  assert.equal(d.results[2]!.ok, true);
  assert.equal(t.calls.filter((c) => c.method === "POST").length, 2);
  await t.close();
});

test("bulk create: continues past a failed item", async () => {
  let n = 0;
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/chores/create_multiple", handler: () => (++n === 2 ? { status: 500, text: "boom" } : { json: { data: [chore(String(n), "x")] } }) }]);
  const r = await t.callTool("skylight_bulk_create_chores", { chores: [1, 2, 3].map((i) => ({ summary: `C${i}`, start: "2026-10-13", profileIds: ["12"] })) });
  const d = r.data as { created: number; failed: number; results: Array<{ ok: boolean; error?: string }> };
  assert.equal(r.isError, false);
  assert.equal(d.created, 2);
  assert.equal(d.failed, 1);
  assert.match(d.results[1]!.error!, /500/);
  assert.equal(t.calls.filter((c) => c.method === "POST").length, 3);
  await t.close();
});

test("bulk create rejects more than 50 items before any request", async () => {
  const t = await connectTestClient([FRAMES]);
  const r = await t.callTool("skylight_bulk_create_chores", { chores: Array.from({ length: 51 }, () => ({ summary: "x", start: "2026-10-13", profileIds: ["12"] })) });
  assert.equal(r.isError, true);
  await t.close();
});

test("update chore sends PUT with only provided fields", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/5", json: { data: chore("5", "New") } }]);
  const r = await t.callTool("skylight_update_chore", { choreId: "5", summary: "New" });
  assert.equal(r.isError, false);
  assert.deepEqual(t.calls.at(-1)!.body, { summary: "New" });
  await t.close();
});

test("update chore rejects path-traversal id without a request", async () => {
  const t = await connectTestClient([FRAMES]);
  const r = await t.callTool("skylight_update_chore", { choreId: "../frames", summary: "x" });
  assert.equal(r.isError, true);
  assert.ok(!t.calls.some((c) => c.method === "PUT"));
  await t.close();
});

test("delete without confirm sends no request and returns preview", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/chores", json: { data: [chore("5", "Dishes")] } }]);
  const r = await t.callTool("skylight_delete_chore", { choreId: "5" });
  assert.equal(r.isError, false);
  const d = r.data as { confirmed: boolean; wouldDelete: { id: string; summary: string | null } };
  assert.equal(d.confirmed, false);
  assert.equal(d.wouldDelete.id, "5");
  assert.equal(d.wouldDelete.summary, "Dishes");
  assert.ok(!t.calls.some((c) => c.method === "DELETE"));
  await t.close();
});

test("delete with confirm sends DELETE", async () => {
  const t = await connectTestClient([FRAMES, { method: "DELETE", path: "/api/frames/77/chores/5", status: 204, text: "" }]);
  const r = await t.callTool("skylight_delete_chore", { choreId: "5", confirm: true });
  assert.equal(r.isError, false);
  assert.deepEqual(r.data, { deleted: true, id: "5" });
  assert.equal(t.calls.at(-1)!.method, "DELETE");
  await t.close();
});

test("complete chore PUTs completions with vocab status", async () => {
  const { CHORE_STATUS } = await import("../../src/skylight/vocab.js");
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/5/completions", json: { data: chore("5", "Dishes") } }]);
  const r = await t.callTool("skylight_complete_chore", { choreId: "5", instanceDate: "2026-10-13", profileId: "12" });
  assert.equal(r.isError, false);
  const body = t.calls.at(-1)!.body as Record<string, unknown>;
  assert.equal(body.status, CHORE_STATUS.done);
  assert.equal(body.instance_date, "2026-10-13");
  assert.equal(body.category_id, "12");
  const undo = await t.callTool("skylight_complete_chore", { choreId: "5", instanceDate: "2026-10-13", profileId: "12", done: false });
  assert.equal((t.calls.at(-1)!.body as Record<string, unknown>).status, CHORE_STATUS.notDone);
  assert.equal(undo.isError, false);
  await t.close();
});

test("update chore with applyTo puts apply_to in the PUT body", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/5", json: { data: chore("5", "New") } }]);
  const r = await t.callTool("skylight_update_chore", { choreId: "5", summary: "New", applyTo: "future" });
  assert.equal(r.isError, false);
  assert.deepEqual(t.calls.at(-1)!.body, { summary: "New", apply_to: "future" });
  await t.close();
});

test("delete chore with applyTo puts apply_to in the DELETE query", async () => {
  const t = await connectTestClient([FRAMES, { method: "DELETE", path: "/api/frames/77/chores/5", status: 204, text: "" }]);
  const r = await t.callTool("skylight_delete_chore", { choreId: "5", confirm: true, applyTo: "future" });
  assert.equal(r.isError, false);
  const last = t.calls.at(-1)!;
  assert.equal(last.method, "DELETE");
  assert.equal(last.url.searchParams.get("apply_to"), "future");
  await t.close();
});

test("invalid applyTo is rejected and no PUT or DELETE is sent", async () => {
  const t = await connectTestClient([FRAMES]);
  for (const [name, args] of [
    ["skylight_update_chore", { choreId: "5", summary: "x", applyTo: "bogus" }],
    ["skylight_delete_chore", { choreId: "5", confirm: true, applyTo: "bogus" }],
  ] as const) {
    let rejected = false;
    try {
      const r = await t.callTool(name, args);
      rejected = r.isError;
    } catch {
      rejected = true;
    }
    assert.ok(rejected, `${name} should reject applyTo: bogus`);
  }
  assert.ok(!t.calls.some((c) => c.method === "PUT" || c.method === "DELETE"));
  await t.close();
});
