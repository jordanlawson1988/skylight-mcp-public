import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.equal(q.get("include_late"), "false");
  assert.equal(q.get("include_up_for_grabs"), "true");
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
  const d = r.data as { ids: string[]; created: Array<{ id: string }> };
  assert.deepEqual(d.ids, ["5"]);
  assert.equal(d.created[0]!.id, "5");
  await t.close();
});

test("bulk create: dryRun makes no requests and returns payloads", async () => {
  const t = await connectTestClient([FRAMES]);
  const r = await t.callTool("skylight_bulk_create_chores", { dryRun: true, chores: [{ summary: "A", start: "2026-10-13", profileIds: ["12"] }, { summary: "B", start: "2026-10-13", profileIds: ["13"], routine: true, timeOfDay: "morning" }] });
  assert.equal(r.isError, false);
  const d = r.data as { dryRun: boolean; results: Array<{ ok: boolean; payload?: { routine: boolean } }> };
  assert.equal(d.dryRun, true);
  assert.equal(d.results.length, 2);
  assert.equal(d.results[1]!.payload!.routine, true);
  assert.deepEqual((d.results[1]!.payload as unknown as { recurrence_set: string[] }).recurrence_set, ["RRULE:FREQ=DAILY;BYHOUR=6"]);
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
  const d = r.data as { created: number; failed: number; results: Array<{ index: number; ok: boolean; ids?: string[]; error?: string }> };
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

test("bulk create: error body echoing the bearer token is redacted in results", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/chores/create_multiple", status: 500, text: 'debug authorization=Bearer AT {"access_token":"AT"}' }]);
  const r = await t.callTool("skylight_bulk_create_chores", { chores: [{ summary: "A", start: "2026-10-13", profileIds: ["12"] }] });
  const d = r.data as { results: Array<{ ok: boolean; error?: string }> };
  assert.equal(d.results[0]!.ok, false);
  assert.match(d.results[0]!.error!, /\[redacted\]/);
  assert.doesNotMatch(d.results[0]!.error!, /Bearer AT/);
  assert.doesNotMatch(r.text, /"access_token":"AT"/);
  await t.close();
});

test("bulk create rejects more than 50 items before any request", async () => {
  const t = await connectTestClient([FRAMES]);
  const r = await t.callTool("skylight_bulk_create_chores", { chores: Array.from({ length: 51 }, () => ({ summary: "x", start: "2026-10-13", profileIds: ["12"] })) });
  assert.equal(r.isError, true);
  assert.equal(t.calls.filter((c) => c.method === "POST").length, 0);
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
  const d = r.data as { confirmed: boolean; wouldDelete: { seriesId: string; instanceDate: string | null; applyTo: string | null; summary: string | null }; message: string };
  assert.equal(d.confirmed, false);
  assert.deepEqual(d.wouldDelete, { seriesId: "5", instanceDate: null, applyTo: null, summary: "Dishes" });
  assert.match(d.message, /this chore/);
  assert.ok(!t.calls.some((c) => c.method === "DELETE"));
  await t.close();
});

test("delete preview describes each scope and finds the summary via a composite id", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/chores", json: { data: [{ id: "5-2026-10-14", attributes: { summary: "Dishes", series: "5", start: "2026-10-13" } }] } }]);
  const all = (await t.callTool("skylight_delete_chore", { choreId: "5", applyTo: "all" })).data as { wouldDelete: Record<string, unknown>; message: string };
  assert.deepEqual(all.wouldDelete, { seriesId: "5", instanceDate: null, applyTo: "all", summary: "Dishes" });
  assert.match(all.message, /every occurrence of this recurring chore/);
  const fut = (await t.callTool("skylight_delete_chore", { choreId: "5-2026-10-14", applyTo: "future" })).data as { wouldDelete: Record<string, unknown>; message: string };
  assert.deepEqual(fut.wouldDelete, { seriesId: "5", instanceDate: "2026-10-14", applyTo: "future", summary: "Dishes" });
  assert.match(fut.message, /this occurrence and all later ones/);
  const one = (await t.callTool("skylight_delete_chore", { choreId: "5", instanceDate: "2026-10-14", applyTo: "one" })).data as { wouldDelete: Record<string, unknown>; message: string };
  assert.deepEqual(one.wouldDelete, { seriesId: "5", instanceDate: "2026-10-14", applyTo: "one", summary: "Dishes" });
  assert.match(one.message, /only this occurrence/);
  assert.ok(!t.calls.some((c) => c.method === "DELETE"));
  await t.close();
});

test("delete with confirm and no applyTo sends DELETE on the series id with no apply_to", async () => {
  const t = await connectTestClient([FRAMES, { method: "DELETE", path: "/api/frames/77/chores/5", status: 204, text: "" }]);
  const r = await t.callTool("skylight_delete_chore", { choreId: "5", confirm: true });
  assert.equal(r.isError, false);
  const last = t.calls.at(-1)!;
  assert.equal(last.method, "DELETE");
  assert.equal(last.url.pathname, "/api/frames/77/chores/5");
  assert.equal(last.url.searchParams.has("apply_to"), false);
  await t.close();
});

test("delete applyTo all uses the series id even when given a composite id", async () => {
  const t = await connectTestClient([FRAMES, { method: "DELETE", path: "/api/frames/77/chores/5", status: 204, text: "" }]);
  const r = await t.callTool("skylight_delete_chore", { choreId: "5-2026-10-14", confirm: true, applyTo: "all" });
  assert.equal(r.isError, false);
  const last = t.calls.at(-1)!;
  assert.equal(last.url.pathname, "/api/frames/77/chores/5");
  assert.equal(last.url.searchParams.get("apply_to"), "all");
  await t.close();
});

test("delete applyTo one/future anchors on seriesId-date in the path", async () => {
  const t = await connectTestClient([FRAMES, { method: "DELETE", path: "/api/frames/77/chores/5-2026-10-14", status: 204, text: "" }]);
  for (const [args, scope] of [
    [{ choreId: "5-2026-10-14", applyTo: "one" }, "one"],
    [{ choreId: "5", instanceDate: "2026-10-14", applyTo: "future" }, "future"],
  ] as const) {
    const r = await t.callTool("skylight_delete_chore", { ...args, confirm: true });
    assert.equal(r.isError, false);
    const last = t.calls.at(-1)!;
    assert.equal(last.url.pathname, "/api/frames/77/chores/5-2026-10-14");
    assert.equal(last.url.searchParams.get("apply_to"), scope);
  }
  await t.close();
});

test("delete applyTo one/future without a date, or with a mismatched date, is rejected before any request", async () => {
  const t = await connectTestClient([FRAMES]);
  for (const applyTo of ["one", "future"]) {
    for (const confirm of [false, true]) {
      const r = await t.callTool("skylight_delete_chore", { choreId: "5", applyTo, confirm });
      assert.equal(r.isError, true);
      assert.match(r.text, /instanceDate/);
    }
  }
  const mm = await t.callTool("skylight_delete_chore", { choreId: "5-2026-10-14", instanceDate: "2026-10-15", applyTo: "one", confirm: true });
  assert.equal(mm.isError, true);
  assert.match(mm.text, /does not match the date in choreId/);
  assert.ok(!t.calls.some((c) => c.method === "DELETE" || c.url.pathname.endsWith("/chores")));
  await t.close();
});

test("complete chore without a date sends only status", async () => {
  const { CHORE_STATUS } = await import("../../src/skylight/vocab.js");
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/5/completions", json: { data: chore("5", "Dishes") } }]);
  const r = await t.callTool("skylight_complete_chore", { choreId: "5" });
  assert.equal(r.isError, false);
  assert.deepEqual(t.calls.at(-1)!.body, { status: CHORE_STATUS.done });
  assert.deepEqual(Object.keys(r.data as object).sort(), ["chore", "instanceDate", "seriesId", "status"]);
  const undo = await t.callTool("skylight_complete_chore", { choreId: "5", done: false });
  assert.deepEqual(t.calls.at(-1)!.body, { status: CHORE_STATUS.notDone });
  assert.equal(undo.isError, false);
  await t.close();
});

test("complete chore with a composite id uses the series id in the path and sends instance_date", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/5/completions", json: { data: chore("5", "Dishes") } }]);
  const r = await t.callTool("skylight_complete_chore", { choreId: "5-2026-10-13" });
  assert.equal(r.isError, false);
  assert.equal(t.calls.at(-1)!.url.pathname, "/api/frames/77/chores/5/completions");
  assert.deepEqual(t.calls.at(-1)!.body, { status: "complete", instance_date: "2026-10-13" });
  const d = r.data as { seriesId: string; instanceDate: string };
  assert.deepEqual({ s: d.seriesId, d: d.instanceDate }, { s: "5", d: "2026-10-13" });
  const ok2 = await t.callTool("skylight_complete_chore", { choreId: "5-2026-10-13", instanceDate: "2026-10-13" });
  assert.equal(ok2.isError, false);
  await t.close();
});

test("complete chore with a plain id plus instanceDate sends instance_date; time and profile only when given", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/5/completions", json: { data: chore("5", "Dishes") } }]);
  await t.callTool("skylight_complete_chore", { choreId: "5", instanceDate: "2026-10-13" });
  assert.deepEqual(t.calls.at(-1)!.body, { status: "complete", instance_date: "2026-10-13" });
  await t.callTool("skylight_complete_chore", { choreId: "5", instanceDate: "2026-10-13", instanceTime: "07:30", profileId: "12" });
  assert.deepEqual(t.calls.at(-1)!.body, { status: "complete", instance_date: "2026-10-13", instance_time: "07:30", category_id: "12" });
  await t.close();
});

test("complete chore rejects a mismatched instanceDate without a request", async () => {
  const t = await connectTestClient([FRAMES]);
  const r = await t.callTool("skylight_complete_chore", { choreId: "5-2026-10-13", instanceDate: "2026-10-14" });
  assert.equal(r.isError, true);
  assert.match(r.text, /instanceDate: does not match the date in choreId/);
  assert.ok(!t.calls.some((c) => c.method === "PUT"));
  await t.close();
});

test("complete chore maps the two instance_date 422s to guidance and leaves other errors alone", async () => {
  const mk = (text: string, status = 422) => connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/5/completions", status, text }]);
  let t = await mk('{"errors":{"instance_date":["can\'t be blank"]}}');
  let r = await t.callTool("skylight_complete_chore", { choreId: "5" });
  assert.equal(r.isError, true);
  assert.match(r.text, /instanceDate: this chore is recurring; pass the occurrence date/);
  await t.close();
  t = await mk('{"errors":{"instance_date":["must be blank"]}}');
  r = await t.callTool("skylight_complete_chore", { choreId: "5", instanceDate: "2026-10-13" });
  assert.match(r.text, /instanceDate: this is a one-time chore; omit instanceDate/);
  await t.close();
  t = await mk('{"errors":{"category_id":["must be blank"]}}');
  r = await t.callTool("skylight_complete_chore", { choreId: "5", profileId: "12" });
  assert.equal(r.isError, true);
  assert.match(r.text, /422/);
  assert.match(r.text, /category_id/);
  await t.close();
  t = await mk("boom", 500);
  r = await t.callTool("skylight_complete_chore", { choreId: "5" });
  assert.match(r.text, /500/);
  await t.close();
});

test("update chore with applyTo puts apply_to in the PUT body", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/5", json: { data: chore("5", "New") } }]);
  const r = await t.callTool("skylight_update_chore", { choreId: "5", summary: "New", applyTo: "all" });
  assert.equal(r.isError, false);
  assert.deepEqual(t.calls.at(-1)!.body, { summary: "New", apply_to: "all" });
  await t.close();
});

test("update rejects applyTo values other than all, and delete rejects bogus; no PUT or DELETE is sent", async () => {
  const t = await connectTestClient([FRAMES]);
  for (const applyTo of ["bogus", "future", "one"]) {
    let rejected = false;
    try { rejected = (await t.callTool("skylight_update_chore", { choreId: "5", summary: "x", applyTo })).isError; } catch { rejected = true; }
    assert.ok(rejected, `update should reject applyTo: ${applyTo}`);
  }
  let bogus = false;
  try { bogus = (await t.callTool("skylight_delete_chore", { choreId: "5-2026-10-14", confirm: true, applyTo: "bogus" })).isError; } catch { bogus = true; }
  assert.ok(bogus);
  assert.ok(!t.calls.some((c) => c.method === "PUT" || c.method === "DELETE"));
  await t.close();
});

test("update chore with a composite id puts to the series id", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/5", json: { data: chore("5", "New") } }]);
  const r = await t.callTool("skylight_update_chore", { choreId: "5-2026-10-14", summary: "New", applyTo: "all" });
  assert.equal(r.isError, false);
  assert.equal(t.calls.at(-1)!.url.pathname, "/api/frames/77/chores/5");
  assert.deepEqual(t.calls.at(-1)!.body, { summary: "New", apply_to: "all" });
  await t.close();
});

test("list chores: include_late is false by default and true with includeLate", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/chores", json: { data: [] } }]);
  await t.callTool("skylight_list_chores", { after: "2026-10-01", before: "2026-10-02" });
  assert.equal(t.calls.at(-1)!.url.searchParams.get("include_late"), "false");
  await t.callTool("skylight_list_chores", { after: "2026-10-01", before: "2026-10-02", includeLate: true });
  assert.equal(t.calls.at(-1)!.url.searchParams.get("include_late"), "true");
  assert.equal(t.calls.at(-1)!.url.searchParams.get("filter"), "linked_to_profile");
  await t.close();
});

test("list chores sorts by instanceDate (nulls last) then summary and exposes seriesId", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/chores", json: { data: [
    { id: "9", attributes: { summary: "Zed" } },
    { id: "5-2026-10-14", attributes: { summary: "Bed", series: "5" } },
    { id: "6", attributes: { summary: "Dishes", start: "2026-10-13" } },
    { id: "7", attributes: { summary: "Alpha", start: "2026-10-13" } },
  ] } }]);
  const r = await t.callTool("skylight_list_chores", { after: "2026-10-01", before: "2026-10-31" });
  const d = r.data as Array<{ id: string; seriesId: string; instanceDate: string | null }>;
  assert.deepEqual(d.map((c) => c.id), ["7", "6", "5-2026-10-14", "9"]);
  assert.equal(d[2]!.seriesId, "5");
  assert.equal(d[2]!.instanceDate, "2026-10-14");
  await t.close();
});

test("create chore with two profiles returns both created ids", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/chores/create_multiple", json: { data: [chore("5", "Feed dog"), chore("6", "Feed dog")] } }]);
  const r = await t.callTool("skylight_create_chore", { summary: "Feed dog", start: "2026-10-13", profileIds: ["12", "13"] });
  assert.equal(r.isError, false);
  const d = r.data as { ids: string[]; created: unknown[] };
  assert.deepEqual(d.ids, ["5", "6"]);
  assert.equal(d.created.length, 2);
  await t.close();
});

test("create chore with an unmappable response warns instead of fabricating an id", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/chores/create_multiple", json: { data: [] } }]);
  const r = await t.callTool("skylight_create_chore", { summary: "Feed dog", start: "2026-10-13", profileIds: ["12"] });
  assert.equal(r.isError, false);
  const d = r.data as { ids: string[]; warning?: string };
  assert.deepEqual(d.ids, []);
  assert.match(d.warning!, /no chore ids/);
  await t.close();
});

test("bulk create records every id when a chore fans out to several profiles", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/chores/create_multiple", json: { data: [chore("5", "x"), chore("6", "x")] } }]);
  const r = await t.callTool("skylight_bulk_create_chores", { chores: [{ summary: "x", start: "2026-10-13", profileIds: ["12", "13"] }] });
  const d = r.data as { created: number; results: Array<{ ok: boolean; ids?: string[] }> };
  assert.equal(d.created, 1);
  assert.deepEqual(d.results[0]!.ids, ["5", "6"]);
  await t.close();
});

test("bulk create stops after an auth failure and marks the rest not attempted", async () => {
  let n = 0;
  const t = await connectTestClient([
    FRAMES,
    { method: "POST", path: "/oauth/token", status: 400, json: { error: "invalid_grant" } },
    { method: "POST", path: "/api/frames/77/chores/create_multiple", handler: () => (++n === 2 ? { status: 401, text: "nope" } : { json: { data: [chore(String(n), "x")] } }) },
  ]);
  const r = await t.callTool("skylight_bulk_create_chores", { chores: [1, 2, 3].map((i) => ({ summary: `C${i}`, start: "2026-10-13", profileIds: ["12"] })) });
  const d = r.data as { created: number; failed: number; results: Array<{ ok: boolean; error?: string }> };
  assert.equal(d.results.length, 3);
  assert.equal(d.created, 1);
  assert.equal(d.failed, 2);
  assert.equal(d.results[1]!.ok, false);
  assert.match(d.results[2]!.error!, /^not attempted/);
  assert.equal(t.calls.filter((c) => c.url.pathname.endsWith("/create_multiple")).length, 2);
  await t.close();
});

test("bulk create stops after a 429 and marks the rest not attempted", async () => {
  let n = 0;
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/chores/create_multiple", handler: () => (++n === 2 ? { status: 429, text: "slow down" } : { json: { data: [chore(String(n), "x")] } }) }]);
  const r = await t.callTool("skylight_bulk_create_chores", { chores: [1, 2, 3].map((i) => ({ summary: `C${i}`, start: "2026-10-13", profileIds: ["12"] })) });
  const d = r.data as { created: number; failed: number; results: Array<{ ok: boolean; error?: string }> };
  assert.equal(d.results.length, 3);
  assert.equal(d.failed, 2);
  assert.match(d.results[2]!.error!, /not attempted: rate limited/);
  assert.equal(t.calls.filter((c) => c.method === "POST").length, 2);
  await t.close();
});

test("list chores defaults before to after + 14 days", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/chores", json: { data: [] } }]);
  const r = await t.callTool("skylight_list_chores", { after: "2027-01-01" });
  assert.equal(r.isError, false);
  assert.equal(t.calls.at(-1)!.url.searchParams.get("before"), "2027-01-15");
  await t.close();
});

test("complete chore rejects a malformed instanceTime without a request", async () => {
  const t = await connectTestClient([FRAMES]);
  const r = await t.callTool("skylight_complete_chore", { choreId: "5", instanceDate: "2026-10-13", instanceTime: "25:99" });
  assert.equal(r.isError, true);
  assert.ok(!t.calls.some((c) => c.method === "PUT"));
  await t.close();
});

test("delete preview looks up the summary for the known date only, else a 30d back / 60d ahead window without late chores", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/chores", json: { data: [] } }]);
  await t.callTool("skylight_delete_chore", { choreId: "5-2026-10-14", applyTo: "one" });
  let q = t.calls.at(-1)!.url.searchParams;
  assert.equal(q.get("after"), "2026-10-14");
  assert.equal(q.get("before"), "2026-10-14");
  assert.equal(q.get("include_late"), "false");
  await t.callTool("skylight_delete_chore", { choreId: "5" });
  q = t.calls.at(-1)!.url.searchParams;
  const day = 86_400_000;
  const span = (Date.parse(`${q.get("before")}T00:00:00Z`) - Date.parse(`${q.get("after")}T00:00:00Z`)) / day;
  assert.equal(span, 90);
  assert.equal(q.get("include_late"), "false");
  await t.close();
});

test("delete with a composite id and no applyTo uses the series path and sends no apply_to", async () => {
  const t = await connectTestClient([FRAMES, { method: "DELETE", path: "/api/frames/77/chores/5", status: 204, text: "" }]);
  const r = await t.callTool("skylight_delete_chore", { choreId: "5-2026-10-14", confirm: true });
  assert.equal(r.isError, false);
  const last = t.calls.at(-1)!;
  assert.equal(last.url.pathname, "/api/frames/77/chores/5");
  assert.equal(last.url.searchParams.has("apply_to"), false);
  await t.close();
});

test("delete with a malformed instanceDate is a validation error before any request", async () => {
  const t = await connectTestClient([FRAMES]);
  for (const bad of ["2026-02-30", "10/14/2026", "tomorrow"]) {
    for (const applyTo of [undefined, "all", "one"]) {
      const r = await t.callTool("skylight_delete_chore", { choreId: "5", instanceDate: bad, confirm: true, ...(applyTo ? { applyTo } : {}) });
      assert.equal(r.isError, true);
      assert.match(r.text, /^Invalid input\. instanceDate:/);
    }
  }
  assert.ok(!t.calls.some((c) => c.method === "DELETE" || c.url.pathname.endsWith("/chores")));
  await t.close();
});

const ROUTINE_ID = "60913118-2026-10-12-0600";

test("complete chore with a time-suffixed id sends instance_date and instance_time and a numeric path", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/60913118/completions", json: { data: chore("60913118", "Brush teeth") } }]);
  const r = await t.callTool("skylight_complete_chore", { choreId: ROUTINE_ID });
  assert.equal(r.isError, false);
  assert.equal(t.calls.at(-1)!.url.pathname, "/api/frames/77/chores/60913118/completions");
  assert.deepEqual(t.calls.at(-1)!.body, { status: "complete", instance_date: "2026-10-12", instance_time: "06:00" });
  const same = await t.callTool("skylight_complete_chore", { choreId: ROUTINE_ID, instanceTime: "06:00" });
  assert.equal(same.isError, false);
  const undo = await t.callTool("skylight_complete_chore", { choreId: ROUTINE_ID, done: false });
  assert.deepEqual(t.calls.at(-1)!.body, { status: "pending", instance_date: "2026-10-12", instance_time: "06:00" });
  assert.equal(undo.isError, false);
  await t.close();
});

test("complete chore rejects an instanceTime that disagrees with the id, before any request", async () => {
  const t = await connectTestClient([FRAMES]);
  const r = await t.callTool("skylight_complete_chore", { choreId: ROUTINE_ID, instanceTime: "14:00" });
  assert.equal(r.isError, true);
  assert.match(r.text, /instanceTime: does not match the time in choreId/);
  assert.ok(!t.calls.some((c) => c.method === "PUT"));
  await t.close();
});

test("delete all on a time-suffixed id uses the numeric series path", async () => {
  const t = await connectTestClient([FRAMES, { method: "DELETE", path: "/api/frames/77/chores/60913118", status: 204, text: "" }]);
  const all = await t.callTool("skylight_delete_chore", { choreId: ROUTINE_ID, applyTo: "all", confirm: true });
  assert.equal(all.isError, false);
  assert.equal(t.calls.at(-1)!.url.pathname, "/api/frames/77/chores/60913118");
  await t.close();
});

test("update chore with a time-suffixed id puts to the series id", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/60913118", json: { data: chore("60913118", "New") } }]);
  const r = await t.callTool("skylight_update_chore", { choreId: ROUTINE_ID, summary: "New" });
  assert.equal(r.isError, false);
  assert.equal(t.calls.at(-1)!.url.pathname, "/api/frames/77/chores/60913118");
  await t.close();
});

test("tool descriptions explain series-date-HHMM ids", async () => {
  const t = await connectTestClient([FRAMES]);
  const tools = (await t.client.listTools()).tools;
  for (const name of ["skylight_list_chores", "skylight_complete_chore"]) {
    assert.match(tools.find((x) => x.name === name)!.description ?? "", /HHMM|-0600/, name);
  }
  await t.close();
});

test("create routine step sends blank start_time, BYHOUR and routine: true", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/chores/create_multiple", json: { data: [chore("5", "Brush teeth")] } }]);
  const r = await t.callTool("skylight_create_chore", { summary: "Brush teeth", start: "2026-10-13", profileIds: ["12"], routine: true, timeOfDay: "evening" });
  assert.equal(r.isError, false);
  const body = t.calls.at(-1)!.body as Record<string, unknown>;
  assert.equal(body.routine, true);
  assert.equal(body.start_time, null);
  assert.deepEqual(body.recurrence_set, ["RRULE:FREQ=DAILY;BYHOUR=20"]);
  await t.close();
});

test("create routine rejects a missing timeOfDay or a startTime, and timeOfDay on a plain chore, without a request", async () => {
  const t = await connectTestClient([FRAMES]);
  const base = { summary: "x", start: "2026-10-13", profileIds: ["12"] };
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ routine: true }, /routine steps need timeOfDay/],
    [{ routine: true, timeOfDay: "morning", startTime: "06:00" }, /routines use timeOfDay, not startTime/],
    [{ timeOfDay: "morning" }, /timeOfDay is only for routine steps/],
  ];
  for (const [extra, re] of cases) {
    const r = await t.callTool("skylight_create_chore", { ...base, ...extra });
    assert.equal(r.isError, true);
    assert.match(r.text, re);
  }
  const bad = await t.callTool("skylight_create_chore", { ...base, routine: true, timeOfDay: "noon" }).catch(() => ({ isError: true }));
  assert.equal(bad.isError, true);
  assert.ok(!t.calls.some((c) => c.method === "POST"));
  await t.close();
});

test("update routine step sends BYHOUR with the full recurrence", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/5", json: { data: chore("5", "x") } }]);
  const r = await t.callTool("skylight_update_chore", { choreId: "5", timeOfDay: "afternoon", recurrence: { frequency: "daily" } });
  assert.equal(r.isError, false);
  assert.deepEqual(t.calls.at(-1)!.body, { recurrence_set: ["RRULE:FREQ=DAILY;BYHOUR=14"], recurring_until: null });
  await t.close();
});

test("tool schemas expose timeOfDay with the slot names and describe startTime as not for routines", async () => {
  const t = await connectTestClient([FRAMES]);
  const tools = (await t.client.listTools()).tools;
  const create = tools.find((x) => x.name === "skylight_create_chore")!;
  const props = create.inputSchema.properties as Record<string, { enum?: string[]; description?: string }>;
  assert.deepEqual(props.timeOfDay!.enum, ["morning", "afternoon", "evening"]);
  assert.match(props.startTime!.description ?? "", /Not allowed on routine steps/);
  await t.close();
});

test("list chores: includeUpForGrabs defaults to true and can be turned off", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/chores", json: { data: [] } }]);
  await t.callTool("skylight_list_chores", { after: "2026-10-01", before: "2026-10-02" });
  assert.equal(t.calls.at(-1)!.url.searchParams.get("include_up_for_grabs"), "true");
  await t.callTool("skylight_list_chores", { after: "2026-10-01", before: "2026-10-02", includeUpForGrabs: false });
  assert.equal(t.calls.at(-1)!.url.searchParams.get("include_up_for_grabs"), "false");
  await t.close();
});

test("list chores returns the live fixture including the claimed up-for-grabs chore", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/chores", json: JSON.parse(readFileSync(new URL("../fixtures/chores.json", import.meta.url), "utf8")) }]);
  const r = await t.callTool("skylight_list_chores", { after: "2026-05-01", before: "2026-10-31" });
  const d = r.data as Array<{ id: string; upForGrabs: boolean; completedByProfileId: string | null; timeOfDay: string | null }>;
  assert.deepEqual(d.map((c) => c.id), ["65827263-2026-05-19", "60913118-2026-10-12-0600", "93308731"]);
  assert.deepEqual(d.find((c) => c.id === "93308731"), { ...d.find((c) => c.id === "93308731")!, upForGrabs: true, completedByProfileId: "15057970" });
  assert.equal(d.find((c) => c.id === "60913118-2026-10-12-0600")!.timeOfDay, "morning");
  await t.close();
});

test("create an unassigned up-for-grabs chore with no start", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/chores/create_multiple", json: { data: [{ id: "9", attributes: { summary: "Wash car", up_for_grabs: true, start: null }, relationships: { category: { data: null } } }] } }]);
  const r = await t.callTool("skylight_create_chore", { summary: "Wash car", upForGrabs: true, description: "Front and back", timerSeconds: 600 });
  assert.equal(r.isError, false);
  const body = t.calls.at(-1)!.body as Record<string, unknown>;
  assert.equal(body.up_for_grabs, true);
  assert.equal(body.start, null);
  assert.deepEqual(body.category_ids, []);
  assert.equal(body.description, "Front and back");
  assert.equal(body.timer_seconds, 600);
  assert.equal((r.data as { created: Array<{ upForGrabs: boolean }> }).created[0]!.upForGrabs, true);
  await t.close();
});

test("create without start or profileIds is rejected unless up for grabs, and names the field", async () => {
  const t = await connectTestClient([FRAMES]);
  const noStart = await t.callTool("skylight_create_chore", { summary: "x", profileIds: ["12"] });
  assert.equal(noStart.isError, true);
  assert.match(noStart.text, /start: is required unless upForGrabs is true/);
  const noProfiles = await t.callTool("skylight_create_chore", { summary: "x", start: "2026-10-13" });
  assert.equal(noProfiles.isError, true);
  assert.match(noProfiles.text, /profileIds: is required unless upForGrabs is true/);
  const bulk = await t.callTool("skylight_bulk_create_chores", { dryRun: true, chores: [{ summary: "x" }, { summary: "y", upForGrabs: true }] });
  const d = bulk.data as { results: Array<{ ok: boolean; error?: string }> };
  assert.deepEqual(d.results.map((x) => x.ok), [false, true]);
  assert.ok(!t.calls.some((c) => c.method === "POST"));
  await t.close();
});

test("update chore sends description and timer_seconds", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/5", json: { data: chore("5", "x") } }]);
  const r = await t.callTool("skylight_update_chore", { choreId: "5", description: "More detail", timerSeconds: 90 });
  assert.equal(r.isError, false);
  assert.deepEqual(t.calls.at(-1)!.body, { description: "More detail", timer_seconds: 90 });
  const bad = await t.callTool("skylight_update_chore", { choreId: "5", timerSeconds: 90000 }).catch(() => ({ isError: true }));
  assert.equal(bad.isError, true);
  await t.close();
});

test("update chore with nulls sends nulls in the body to clear fields", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/5", json: { data: chore("5", "x") } }]);
  const r = await t.callTool("skylight_update_chore", { choreId: "5", startTime: null, emoji: null, rewardPoints: null, description: null, timerSeconds: null, recurrence: null });
  assert.equal(r.isError, false);
  assert.deepEqual(t.calls.at(-1)!.body, { start_time: null, emoji_icon: null, reward_points: null, description: null, timer_seconds: null, recurrence_set: null, recurring_until: null });
  await t.close();
});

test("update chore with null rewardPoints alone clears only the points; omitted fields stay out of the body", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/5", json: { data: chore("5", "x") } }]);
  await t.callTool("skylight_update_chore", { choreId: "5", rewardPoints: null });
  assert.deepEqual(t.calls.at(-1)!.body, { reward_points: null });
  await t.close();
});

test("only the documented update fields accept null", async () => {
  const t = await connectTestClient([FRAMES]);
  for (const field of ["summary", "start", "profileIds"]) {
    const r = await t.callTool("skylight_update_chore", { choreId: "5", [field]: null }).catch(() => ({ isError: true }));
    assert.equal(r.isError, true, field);
  }
  assert.ok(!t.calls.some((c) => c.method === "PUT"));
  await t.close();
});

const CATS: MockRoute = { method: "GET", path: "/api/frames/77/categories", json: { data: [
  { id: "12", attributes: { label: "Ellie", linked_to_profile: true } },
  { id: "13", attributes: { label: "Sam", linked_to_profile: true } },
  { id: "14", attributes: { label: "Birthdays", linked_to_profile: false } },
] } };
const CREATE: MockRoute = { method: "POST", path: "/api/frames/77/chores/create_multiple", json: { data: [chore("5", "x")] } };
const categoryGets = (t: { calls: Array<{ method: string; url: URL }> }) => t.calls.filter((c) => c.method === "GET" && c.url.pathname === "/api/frames/77/categories").length;

test("create chore refuses a label or unknown profile before any POST", async () => {
  const t = await connectTestClient([FRAMES, CATS, CREATE]);
  const label = await t.callTool("skylight_create_chore", { summary: "x", start: "2026-10-13", profileIds: ["12", "14"] });
  assert.equal(label.isError, true);
  assert.match(label.text, /profileIds: 14 \(Birthdays\) is a label, not a person profile/);
  const unknown = await t.callTool("skylight_create_chore", { summary: "x", start: "2026-10-13", profileIds: ["999"] });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /profileIds: 999 is not a profile on this frame/);
  assert.ok(!t.calls.some((c) => c.method === "POST"));
  const ok = await t.callTool("skylight_create_chore", { summary: "x", start: "2026-10-13", profileIds: ["12"] });
  assert.equal(ok.isError, false);
  await t.close();
});

test("a failed categories lookup does not block the write", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/categories", status: 500, text: "boom" }, CREATE]);
  const r = await t.callTool("skylight_create_chore", { summary: "x", start: "2026-10-13", profileIds: ["14"] });
  assert.equal(r.isError, false);
  assert.equal(t.calls.filter((c) => c.method === "POST").length, 1);
  await t.close();
});

test("up-for-grabs create without profileIds does no categories lookup", async () => {
  const t = await connectTestClient([FRAMES, CATS, CREATE]);
  const r = await t.callTool("skylight_create_chore", { summary: "x", upForGrabs: true });
  assert.equal(r.isError, false);
  assert.equal(categoryGets(t), 0);
  await t.close();
});

test("bulk create does one lookup for the batch and reports label items without posting them", async () => {
  const t = await connectTestClient([FRAMES, CATS, CREATE]);
  const r = await t.callTool("skylight_bulk_create_chores", { chores: [
    { summary: "A", start: "2026-10-13", profileIds: ["12"] },
    { summary: "B", start: "2026-10-13", profileIds: ["12", "14"] },
    { summary: "C", start: "2026-10-13", profileIds: ["13"] },
  ] });
  const d = r.data as { created: number; failed: number; results: Array<{ ok: boolean; error?: string }> };
  assert.equal(categoryGets(t), 1);
  assert.equal(d.created, 2);
  assert.equal(d.failed, 1);
  assert.match(d.results[1]!.error!, /14 \(Birthdays\) is a label/);
  assert.equal(t.calls.filter((c) => c.method === "POST").length, 2);
  const idxOfFirstPost = t.calls.findIndex((c) => c.method === "POST");
  assert.ok(t.calls.findIndex((c) => c.url.pathname === "/api/frames/77/categories") < idxOfFirstPost);
  await t.close();
});

test("bulk create dry run also flags labels", async () => {
  const t = await connectTestClient([FRAMES, CATS]);
  const r = await t.callTool("skylight_bulk_create_chores", { dryRun: true, chores: [{ summary: "B", start: "2026-10-13", profileIds: ["14"] }] });
  const d = r.data as { valid: number; invalid: number; results: Array<{ ok: boolean; error?: string }> };
  assert.equal(d.invalid, 1);
  assert.equal(d.results[0]!.ok, false);
  assert.ok(!t.calls.some((c) => c.method === "POST"));
  await t.close();
});

test("update chore guards profileIds when given, and skips the lookup otherwise", async () => {
  const t = await connectTestClient([FRAMES, CATS, { method: "PUT", path: "/api/frames/77/chores/5", json: { data: chore("5", "x") } }]);
  const bad = await t.callTool("skylight_update_chore", { choreId: "5", profileIds: ["14"] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /is a label, not a person profile/);
  assert.ok(!t.calls.some((c) => c.method === "PUT"));
  const ok = await t.callTool("skylight_update_chore", { choreId: "5", profileIds: ["13"] });
  assert.equal(ok.isError, false);
  assert.deepEqual(t.calls.at(-1)!.body, { category_ids: ["13"] });
  const before = categoryGets(t);
  await t.callTool("skylight_update_chore", { choreId: "5", summary: "y" });
  assert.equal(categoryGets(t), before);
  await t.close();
});

test("points and timer schemas advertise their bounds", async () => {
  const t = await connectTestClient([FRAMES]);
  const tools = (await t.client.listTools()).tools;
  const props = (name: string) => tools.find((x) => x.name === name)!.inputSchema.properties as Record<string, { minimum?: number; maximum?: number; anyOf?: Array<{ minimum?: number; maximum?: number }> }>;
  const rp = props("skylight_create_chore").rewardPoints!;
  assert.deepEqual([rp.minimum, rp.maximum], [-10000, 10000]);
  const ts = props("skylight_create_chore").timerSeconds!;
  assert.deepEqual([ts.minimum, ts.maximum], [0, 86400]);
  const add = props("skylight_add_reward_points").points!;
  assert.deepEqual([add.minimum, add.maximum], [-10000, 10000]);
  const upd = props("skylight_update_chore").rewardPoints!;
  assert.ok(upd.anyOf?.some((a) => a.minimum === -10000 && a.maximum === 10000));
  const bulk = tools.find((x) => x.name === "skylight_bulk_create_chores")!;
  assert.match(bulk.description ?? "", /resend ONLY the failed items; resending the whole batch creates duplicates/);
  const over = await t.callTool("skylight_create_chore", { summary: "x", start: "2026-10-13", profileIds: ["12"], rewardPoints: 10001 }).catch(() => ({ isError: true }));
  assert.equal(over.isError, true);
  assert.ok(!t.calls.some((c) => c.method === "POST"));
  await t.close();
});

const ROUTINE_DELETE_MSG = /applyTo: Skylight does not allow deleting a single occurrence of a routine step; use applyTo: "all" to delete the whole step/;

test("delete one/future on a time-suffixed (routine) id is rejected before any request, preview included", async () => {
  const t = await connectTestClient([FRAMES]);
  for (const applyTo of ["one", "future"]) {
    for (const confirm of [false, true]) {
      const r = await t.callTool("skylight_delete_chore", { choreId: ROUTINE_ID, applyTo, confirm });
      assert.equal(r.isError, true);
      assert.match(r.text, ROUTINE_DELETE_MSG);
    }
  }
  assert.ok(!t.calls.some((c) => c.method === "DELETE" || c.url.pathname.endsWith("/chores")));
  await t.close();
});

test("delete all on a routine id still works, and non-routine one/future keep the date-only path", async () => {
  const t = await connectTestClient([FRAMES,
    { method: "DELETE", path: "/api/frames/77/chores/60913118", status: 204, text: "" },
    { method: "DELETE", path: "/api/frames/77/chores/5-2026-10-14", status: 204, text: "" }]);
  assert.equal((await t.callTool("skylight_delete_chore", { choreId: ROUTINE_ID, applyTo: "all", confirm: true })).isError, false);
  assert.equal(t.calls.at(-1)!.url.searchParams.get("apply_to"), "all");
  assert.equal((await t.callTool("skylight_delete_chore", { choreId: "5-2026-10-14", applyTo: "one", confirm: true })).isError, false);
  await t.close();
});

test("the server's routine single-instance 400 maps to the same validation error", async () => {
  const t = await connectTestClient([FRAMES, { method: "DELETE", path: "/api/frames/77/chores/5-2026-10-14", status: 400, text: '{"message":"you may not edit a single instance of a routine"}' }]);
  const r = await t.callTool("skylight_delete_chore", { choreId: "5-2026-10-14", applyTo: "one", confirm: true });
  assert.equal(r.isError, true);
  assert.match(r.text, ROUTINE_DELETE_MSG);
  const other = await connectTestClient([FRAMES, { method: "DELETE", path: "/api/frames/77/chores/5", status: 400, text: "something else" }]);
  const r2 = await other.callTool("skylight_delete_chore", { choreId: "5", applyTo: "all", confirm: true });
  assert.match(r2.text, /400/);
  await other.close();
  await t.close();
});

test("delete description says routines can only be deleted as a whole", async () => {
  const t = await connectTestClient([FRAMES]);
  const d = (await t.client.listTools()).tools.find((x) => x.name === "skylight_delete_chore")!.description ?? "";
  assert.match(d, /routine steps can only be deleted as a whole series/i);
  await t.close();
});

test("a categories response with zero profiles never blocks a write (create, update, bulk)", async () => {
  for (const json of [{ data: [] }, {}]) {
    const cats: MockRoute = { method: "GET", path: "/api/frames/77/categories", json };
    const t = await connectTestClient([FRAMES, cats, CREATE, { method: "PUT", path: "/api/frames/77/chores/5", json: { data: chore("5", "x") } }]);
    assert.equal((await t.callTool("skylight_create_chore", { summary: "x", start: "2026-10-13", profileIds: ["12"] })).isError, false);
    assert.equal((await t.callTool("skylight_update_chore", { choreId: "5", profileIds: ["12"] })).isError, false);
    const bulk = await t.callTool("skylight_bulk_create_chores", { chores: [{ summary: "x", start: "2026-10-13", profileIds: ["14"] }] });
    assert.equal((bulk.data as { created: number }).created, 1);
    assert.equal(t.calls.filter((c) => c.method === "POST").length, 2);
    assert.equal(t.calls.filter((c) => c.method === "PUT").length, 1);
    await t.close();
  }
});

test("bulk create with a failed categories lookup still posts every valid item", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/categories", status: 500, text: "boom" }, CREATE]);
  const r = await t.callTool("skylight_bulk_create_chores", { chores: [{ summary: "A", start: "2026-10-13", profileIds: ["14"] }, { summary: "B", start: "2026-10-13", profileIds: ["12"] }] });
  assert.equal((r.data as { created: number }).created, 2);
  assert.equal(t.calls.filter((c) => c.method === "POST").length, 2);
  await t.close();
});

test("invalid create/update input costs no request at all, not even the frame or categories lookup", async () => {
  const t = await connectTestClient([FRAMES, CATS, CREATE]);
  const bad = await t.callTool("skylight_create_chore", { summary: "x", start: "2026-13-01", profileIds: ["14"] });
  assert.match(bad.text, /start/);
  const bad2 = await t.callTool("skylight_update_chore", { choreId: "5", profileIds: ["14"], startTime: "7:00" });
  assert.match(bad2.text, /startTime/);
  assert.equal(t.calls.length, 0);
  await t.close();
});

test("list chores breaks same-day ties by instanceTime, then position, then summary (nulls last)", async () => {
  const row = (id: string, summary: string, start_time: string | null, position: number | null) => ({ id, attributes: { summary, start: "2026-10-12", routine: start_time !== null, start_time, position, recurring: true } });
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/chores", json: { data: [
    row("9-2026-10-12", "Alpha chore", null, null),
    row("1-2026-10-12-2000", "Evening", "20:00", 1),
    row("2-2026-10-12-0600", "Morning B", "06:00", 2),
    row("3-2026-10-12-0600", "Morning A", "06:00", 1),
    row("4-2026-10-12-1400", "Afternoon", "14:00", null),
    row("5-2026-10-12-0600", "Morning Z", "06:00", null),
    row("8-2026-10-12", "Beta chore", null, 3),
  ] } }]);
  const d = (await t.callTool("skylight_list_chores", { after: "2026-10-12", before: "2026-10-12" })).data as Array<{ summary: string }>;
  assert.deepEqual(d.map((c) => c.summary), ["Morning A", "Morning B", "Morning Z", "Afternoon", "Evening", "Beta chore", "Alpha chore"]);
  await t.close();
});

test("update 422s about a routine's missing BYHOUR map to a timeOfDay hint; other 422s pass through", async () => {
  for (const text of ['{"errors":{"recurrence_set":["cannot be empty for routines"]}}', '{"errors":{"recurrence_set":["must contain exactly one BYHOUR of 6, 14 or 20"]}}']) {
    const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/5", status: 422, text }]);
    const r = await t.callTool("skylight_update_chore", { choreId: "5", recurrence: { frequency: "daily" } });
    assert.equal(r.isError, true);
    assert.match(r.text, /timeOfDay: updating a routine step's recurrence also needs timeOfDay: morning, afternoon or evening/);
    await t.close();
  }
  for (const text of ['{"errors":{"recurrence_set":["BYHOUR not allowed for non-routine chores"]}}', '{"errors":{"summary":["is invalid"]}}']) {
    const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/5", status: 422, text }]);
    const r = await t.callTool("skylight_update_chore", { choreId: "5", summary: "x" });
    assert.match(r.text, /422/);
    await t.close();
  }
});

test("delete preview refuses one/future when the lookup shows a routine, even without a time suffix", async () => {
  const routineRow = { id: "60913118-2026-10-12-0600", attributes: { summary: "Brush", series: "60913118", routine: true, start: "2026-10-12", start_time: "06:00" } };
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/chores", json: { data: [routineRow] } }]);
  for (const args of [{ choreId: "60913118", instanceDate: "2026-10-12", applyTo: "one" }, { choreId: "60913118-2026-10-12", applyTo: "future" }]) {
    const r = await t.callTool("skylight_delete_chore", args);
    assert.equal(r.isError, true);
    assert.match(r.text, ROUTINE_DELETE_MSG);
  }
  const all = await t.callTool("skylight_delete_chore", { choreId: "60913118", applyTo: "all" });
  assert.equal(all.isError, false);
  assert.equal((all.data as { wouldDelete: { summary: string } }).wouldDelete.summary, "Brush");
  assert.ok(!t.calls.some((c) => c.method === "DELETE"));
  await t.close();
});

test("delete preview proceeds as before when the lookup finds nothing or fails", async () => {
  const t1 = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/chores", json: { data: [] } }]);
  const r1 = await t1.callTool("skylight_delete_chore", { choreId: "5-2026-10-14", applyTo: "one" });
  assert.equal(r1.isError, false);
  assert.equal((r1.data as { wouldDelete: { summary: unknown } }).wouldDelete.summary, null);
  await t1.close();
  const t2 = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/chores", status: 404, text: "no" }]);
  assert.equal((await t2.callTool("skylight_delete_chore", { choreId: "5-2026-10-14", applyTo: "one" })).isError, false);
  await t2.close();
});

test("bulk tool description says dryRun needs a login and reports label ids", async () => {
  const t = await connectTestClient([FRAMES]);
  const d = (await t.client.listTools()).tools.find((x) => x.name === "skylight_bulk_create_chores")!.description ?? "";
  assert.match(d, /dryRun[^.]*needs a login[^.]*reports labels/);
  await t.close();
});

test("planCompletion sends an explicit instanceTime with a plain id", async () => {
  const { planCompletion } = await import("../../src/tools/chores.js");
  assert.deepEqual(planCompletion({ choreId: "60913118", instanceDate: "2026-10-12", instanceTime: "06:00" }), { seriesId: "60913118", instanceDate: "2026-10-12", status: "complete", body: { status: "complete", instance_date: "2026-10-12", instance_time: "06:00" } });
  assert.throws(() => planCompletion({ choreId: "60913118-2026-10-12-0600", instanceTime: "14:00" }), /does not match the time/);
});

test("move routine step before another sends position.before with numeric series ids", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/chores/60913118/move", json: {} }]);
  const r = await t.callTool("skylight_move_routine_step", { choreId: "60913118-2026-10-12-0600", beforeChoreId: "60913117-2026-10-12-0600" });
  assert.equal(r.isError, false);
  const post = t.calls.filter((c) => c.method === "POST");
  assert.equal(post.length, 1);
  assert.equal(post[0]!.url.pathname, "/api/frames/77/chores/60913118/move");
  assert.deepEqual(post[0]!.body, { position: { before: 60913117 } });
  assert.deepEqual(r.data, { moved: true, seriesId: "60913118", position: "before", relativeTo: "60913117" });
  await t.close();
});

test("move routine step after another sends position.after", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/chores/5/move", json: null }]);
  const r = await t.callTool("skylight_move_routine_step", { choreId: "5", afterChoreId: "6" });
  assert.equal(r.isError, false);
  assert.deepEqual(t.calls.at(-1)!.body, { position: { after: 6 } });
  assert.deepEqual(r.data, { moved: true, seriesId: "5", position: "after", relativeTo: "6" });
  await t.close();
});

test("move routine step needs exactly one anchor, two different steps and valid ids, before any request", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: /\/move$/, json: {} }]);
  for (const args of [
    { choreId: "5" },
    { choreId: "5", beforeChoreId: "6", afterChoreId: "7" },
    { choreId: "5", beforeChoreId: "5" },
    { choreId: "5-2026-10-12-0600", afterChoreId: "5-2026-10-13-0600" },
    { choreId: "../5", beforeChoreId: "6" },
    { choreId: "5", beforeChoreId: "a/b" },
    { choreId: "abc", beforeChoreId: "6" },
  ]) {
    assert.equal((await t.callTool("skylight_move_routine_step", args)).isError, true, JSON.stringify(args));
  }
  assert.equal(t.calls.filter((c) => c.method === "POST").length, 0);
  await t.close();
});

test("move routine step is annotated idempotent update", async () => {
  const t = await connectTestClient([FRAMES]);
  const tool = (await t.client.listTools()).tools.find((x) => x.name === "skylight_move_routine_step")!;
  assert.equal(tool.annotations?.idempotentHint, true);
  assert.match(tool.description ?? "", /position/);
  await t.close();
});

test("list chores shows completedAt in Eastern time", async () => {
  const done = { ...chore("9", "Walk dog"), attributes: { summary: "Walk dog", start: "2026-10-13", completed_at: "2026-08-27T16:00:00.000Z" } };
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/chores", json: { data: [done, chore("10", "Open")] } }]);
  const d = (await t.callTool("skylight_list_chores", { after: "2026-10-01", before: "2026-10-31" })).data as Array<{ id: string; completedAt: string | null }>;
  assert.equal(d.find((c) => c.id === "9")!.completedAt, "2026-08-27T12:00:00-04:00");
  assert.equal(d.find((c) => c.id === "10")!.completedAt, null);
  await t.close();
});

test("complete chore shows the returned completedAt in Eastern time", async () => {
  const done = { ...chore("9", "Walk dog"), attributes: { summary: "Walk dog", start: "2026-10-13", completed_at: "2026-01-27T16:00:00Z" } };
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/chores/9/completions", json: { data: done } }]);
  const d = (await t.callTool("skylight_complete_chore", { choreId: "9" })).data as { chore: { completedAt: string } };
  assert.equal(d.chore.completedAt, "2026-01-27T11:00:00-05:00");
  await t.close();
});

test("list chores and the delete preview default to the configured zone's today", async () => {
  const now = () => new Date("2026-10-12T23:30:00Z"); // Oct 13 in Auckland, Oct 12 in UTC and New York
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/chores", json: { data: [] } }], { env: { SKYLIGHT_TIMEZONE: "Pacific/Auckland" }, now });
  await t.callTool("skylight_list_chores");
  let q = t.calls.at(-1)!.url.searchParams;
  assert.deepEqual([q.get("after"), q.get("before")], ["2026-10-13", "2026-10-27"]);
  await t.callTool("skylight_delete_chore", { choreId: "123" });
  q = t.calls.at(-1)!.url.searchParams;
  assert.deepEqual([q.get("after"), q.get("before")], ["2026-09-13", "2026-12-12"]);
  await t.close();
});
