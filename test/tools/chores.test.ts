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
  assert.equal(q.get("include_late"), "false");
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
  const d = r.data as { ids: string[]; created: Array<{ id: string }> };
  assert.deepEqual(d.ids, ["5"]);
  assert.equal(d.created[0]!.id, "5");
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

test("delete one/future on a time-suffixed id uses the date-only composite path", async () => {
  const t = await connectTestClient([FRAMES, { method: "DELETE", path: "/api/frames/77/chores/60913118-2026-10-12", status: 204, text: "" }]);
  for (const applyTo of ["one", "future"]) {
    const r = await t.callTool("skylight_delete_chore", { choreId: ROUTINE_ID, applyTo, confirm: true });
    assert.equal(r.isError, false);
    assert.equal(t.calls.at(-1)!.url.pathname, "/api/frames/77/chores/60913118-2026-10-12");
    assert.equal(t.calls.at(-1)!.url.searchParams.get("apply_to"), applyTo);
  }
  const all = await t.callTool("skylight_delete_chore", { choreId: ROUTINE_ID, applyTo: "all", confirm: true });
  assert.equal(all.isError, true); // no mock for the series path
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
  for (const name of ["skylight_list_chores", "skylight_complete_chore", "skylight_delete_chore"]) {
    assert.match(tools.find((x) => x.name === name)!.description ?? "", /HHMM|-0600/, name);
  }
  await t.close();
});
