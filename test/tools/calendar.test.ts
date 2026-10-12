import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectTestClient } from "../helpers/test-server.js";
import type { MockRoute, RecordedCall } from "../helpers/mock-fetch.js";
import { addDays as shiftDay, todayIn } from "../../src/skylight/time.js";

const FRAMES: MockRoute = { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77" }] } };
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
const CATEGORIES: MockRoute = { method: "GET", path: "/api/frames/77/categories", json: { data: [{ id: "12", attributes: { label: "Ellie", linked_to_profile: true } }, { id: "14", attributes: { label: "Birthdays", linked_to_profile: false } }] } };
const EVENTS = "/api/frames/77/calendar_events";
const writes = (t: { calls: RecordedCall[] }) => t.calls.filter((c) => c.method !== "GET");
const addDays = shiftDay;
const ev = (id: string, summary: string, over: Record<string, unknown> = {}, profile = "12") => ({
  id, type: "calendar_event",
  attributes: { summary, starts_at: "2026-10-12T22:30:00.000Z", ends_at: "2026-10-12T23:30:00.000Z", all_day: false, timezone: "America/New_York", recurring: false, rrule: null, source: "skylight", editable: true, ...over },
  relationships: { category: { data: { id: profile, type: "category" } } },
});

test("list events passes date_min/date_max and maps the live fixture sorted by start", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: EVENTS, json: fixture("calendar_events") }]);
  const r = await t.callTool("skylight_list_events", { after: "2026-10-08", before: "2026-10-14" });
  assert.equal(r.isError, false);
  const q = t.calls.at(-1)!.url.searchParams;
  assert.equal(q.get("date_min"), "2026-10-08");
  assert.equal(q.get("date_max"), "2026-10-14");
  const d = r.data as Array<{ id: string; masterId: string; startsAt: string; source: string; recurrenceRule: string | null }>;
  assert.deepEqual(d.map((e) => e.id), ["11019657225", "11019627806-1791803100", "13274086104"]);
  assert.equal(d[1]!.masterId, "11019627806");
  assert.equal(d[1]!.source, "google");
  assert.match(d[1]!.recurrenceRule!, /^RRULE:FREQ=WEEKLY/);
  await t.close();
});

test("list events presents times in the configured zone with a human 'when'; all-day events keep dates", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: EVENTS, json: fixture("calendar_events") }]);
  const d = (await t.callTool("skylight_list_events", { after: "2026-10-08", before: "2026-10-14" })).data as Array<{ id: string; startsAt: string; endsAt: string; when: string; timezone: string | null; allDay: boolean }>;
  const by = (id: string) => d.find((e) => e.id === id)!;
  assert.deepEqual([by("11019657225").startsAt, by("11019657225").endsAt, by("11019657225").when], ["2026-10-08", "2026-10-13", "Thu Oct 8 to Tue Oct 13"]);
  assert.deepEqual([by("13274086104").startsAt, by("13274086104").endsAt, by("13274086104").when], ["2026-10-12T16:00:00-04:00", "2026-10-12T16:15:00-04:00", "Mon Oct 12, 4:00 PM EDT to 4:15 PM EDT"]);
  assert.equal(by("11019627806-1791803100").startsAt, "2026-10-12T07:05:00-04:00");
  assert.equal(by("11019627806-1791803100").timezone, "America/New_York");
  await t.close();
  const utc = await connectTestClient([FRAMES, { method: "GET", path: EVENTS, json: fixture("calendar_events") }], { env: { SKYLIGHT_TIMEZONE: "UTC" } });
  const u = (await utc.callTool("skylight_list_events", { after: "2026-10-08", before: "2026-10-14" })).data as Array<{ id: string; startsAt: string }>;
  assert.equal(u.find((e) => e.id === "13274086104")!.startsAt, "2026-10-12T20:00:00+00:00");
  await utc.close();
});

test("single-day all-day events say just the date in 'when'", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: EVENTS, json: { data: [ev("7", "Field day", { all_day: true, starts_at: "2026-10-12T00:00:00.000Z", ends_at: "2026-10-12T00:00:00.000Z" })] } }]);
  const d = (await t.callTool("skylight_list_events", { after: "2026-10-12", before: "2026-10-12" })).data as Array<{ startsAt: string; endsAt: string; when: string }>;
  assert.deepEqual([d[0]!.startsAt, d[0]!.endsAt, d[0]!.when], ["2026-10-12", "2026-10-12", "Mon Oct 12"]);
  await t.close();
});

test("list events can filter by profileId", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: EVENTS, json: fixture("calendar_events") }]);
  const r = await t.callTool("skylight_list_events", { after: "2026-10-08", before: "2026-10-14", profileId: "15057920" });
  assert.deepEqual((r.data as Array<{ id: string }>).map((e) => e.id), ["11019627806-1791803100"]);
  assert.equal((await t.callTool("skylight_list_events", { profileId: "a/b" })).isError, true);
  await t.close();
});

test("list events defaults to today through 7 days ahead and caps the span at 92 days", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: EVENTS, json: { data: [] } }]);
  await t.callTool("skylight_list_events");
  const q = t.calls.at(-1)!.url.searchParams;
  const today = todayIn("America/New_York");
  assert.deepEqual([q.get("date_min"), q.get("date_max")], [today, addDays(today, 7)]);
  const n = t.calls.length;
  assert.equal((await t.callTool("skylight_list_events", { after: "2026-01-01", before: "2026-04-03" })).isError, false); // exactly 92 days
  assert.equal((await t.callTool("skylight_list_events", { after: "2026-01-01", before: "2026-04-04" })).isError, true);
  assert.equal((await t.callTool("skylight_list_events", { after: "2026-10-10", before: "2026-10-01" })).isError, true);
  assert.equal((await t.callTool("skylight_list_events", { after: "2026-02-30" })).isError, true);
  assert.equal(t.calls.length, n + 1); // only the 92-day call went out
  await t.close();
});

test("create timed event sends the verified body, keeping the offset and defaulting the end to +1h", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: EVENTS, json: { data: [ev("500", "Dentist", { starts_at: "2026-10-12T18:30:00.000-04:00", ends_at: "2026-10-12T19:30:00.000-04:00" })] } }]);
  const r = await t.callTool("skylight_create_event", { title: " Dentist ", profileIds: ["12"], startsAt: "2026-10-12T18:30:00-04:00", timezone: "America/New_York", location: "Main St", description: "Cleaning", emoji: "🦷", countdown: true });
  assert.equal(r.isError, false);
  assert.equal(writes(t).length, 1);
  assert.equal(writes(t)[0]!.url.pathname, EVENTS);
  assert.deepEqual(writes(t)[0]!.body, {
    summary: "Dentist", kind: "standard", category_ids: ["12"], starts_at: "2026-10-12T18:30:00-04:00", ends_at: "2026-10-12T19:30:00-04:00", all_day: false, rrule: null,
    invited_emails: [], location: "Main St", lat: null, lng: null, description: "Cleaning", emoji_icon: "🦷", calendar_account_id: null, calendar_id: null, timezone: "America/New_York", countdown_enabled: true,
  });
  const d = r.data as { created: number; events: Array<{ id: string }> };
  assert.deepEqual([d.created, d.events[0]!.id], [1, "500"]);
  await t.close();
});

test("create timed event: explicit end, minute-precision input, Z offset, default timezone and nulls for omitted fields", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: EVENTS, json: { data: ev("501", "x") } }]);
  await t.callTool("skylight_create_event", { title: "A", profileIds: ["12"], startsAt: "2026-10-12T22:30Z", endsAt: "2026-10-13T00:00:00Z" });
  const body = writes(t)[0]!.body as Record<string, unknown>;
  assert.equal(body.starts_at, "2026-10-12T22:30:00Z");
  assert.equal(body.ends_at, "2026-10-13T00:00:00Z");
  assert.equal(body.timezone, "America/New_York");
  assert.deepEqual([body.location, body.description, body.emoji_icon, body.countdown_enabled], [null, null, null, false]);
  await t.callTool("skylight_create_event", { title: "B", profileIds: ["12"], startsAt: "2026-10-12T23:30:00+02:00" });
  assert.equal((writes(t)[1]!.body as Record<string, unknown>).ends_at, "2026-10-13T00:30:00+02:00");
  await t.close();
});

test("create all-day event sends dates only, with the end defaulting to the start", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: EVENTS, json: { data: [ev("502", "Trip", { all_day: true })] } }]);
  await t.callTool("skylight_create_event", { title: "Field day", profileIds: ["12"], allDay: true, startDate: "2026-10-12", timezone: "America/New_York" });
  let body = writes(t)[0]!.body as Record<string, unknown>;
  assert.deepEqual([body.all_day, body.starts_at, body.ends_at], [true, "2026-10-12", "2026-10-12"]);
  await t.callTool("skylight_create_event", { title: "Trip", profileIds: ["12"], allDay: true, startDate: "2026-10-12", endDate: "2026-10-14" });
  body = writes(t)[1]!.body as Record<string, unknown>;
  assert.deepEqual([body.starts_at, body.ends_at], ["2026-10-12", "2026-10-14"]);
  await t.close();
});

test("create event with a weekly recurrence sends rrule as a one-item array", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: EVENTS, json: { data: [ev("503", "Practice")] } }]);
  await t.callTool("skylight_create_event", { title: "Practice", profileIds: ["12"], startsAt: "2026-10-12T17:00:00-04:00", recurrence: { frequency: "weekly", weekdays: ["MO", "WE"], until: "2026-12-31" } });
  assert.deepEqual((writes(t)[0]!.body as Record<string, unknown>).rrule, ["RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231"]);
  await t.close();
});

test("create event reads a bare datetime as Eastern time and sends an explicit offset", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: EVENTS, json: { data: [ev("1", "Dentist", { starts_at: "2026-10-12T22:30:00.000Z", ends_at: "2026-10-12T23:30:00.000Z" })] } }]);
  const r = await t.callTool("skylight_create_event", { title: "Dentist", profileIds: ["12"], startsAt: "2026-10-12T18:30" });
  assert.equal(r.isError, false);
  const body = writes(t)[0]!.body as Record<string, unknown>;
  assert.deepEqual([body.starts_at, body.ends_at], ["2026-10-12T18:30:00-04:00", "2026-10-12T19:30:00-04:00"]);
  const e = (r.data as { events: Array<{ startsAt: string; endsAt: string; when: string }> }).events[0]!;
  assert.deepEqual([e.startsAt, e.endsAt, e.when], ["2026-10-12T18:30:00-04:00", "2026-10-12T19:30:00-04:00", "Mon Oct 12, 6:30 PM EDT to 7:30 PM EDT"]);
  await t.callTool("skylight_create_event", { title: "Winter", profileIds: ["12"], startsAt: "2026-01-12T18:30:00", endsAt: "2026-01-12T20:00" });
  const winter = writes(t)[1]!.body as Record<string, unknown>;
  assert.deepEqual([winter.starts_at, winter.ends_at], ["2026-01-12T18:30:00-05:00", "2026-01-12T20:00:00-05:00"]);
  await t.close();
  const london = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: EVENTS, json: { data: [ev("2", "x")] } }], { env: { SKYLIGHT_TIMEZONE: "Europe/London" } });
  await london.callTool("skylight_create_event", { title: "x", profileIds: ["12"], startsAt: "2026-07-12T18:30" });
  assert.equal((writes(london)[0]!.body as Record<string, unknown>).starts_at, "2026-07-12T18:30:00+01:00");
  assert.equal((writes(london)[0]!.body as Record<string, unknown>).timezone, "Europe/London");
  await london.close();
});

test("create event rejects a datetime that is neither bare nor offset-qualified, before any request", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: EVENTS, json: { data: ev("1", "x") } }]);
  const r = await t.callTool("skylight_create_event", { title: "x", profileIds: ["12"], startsAt: "6:30 PM" });
  assert.equal(r.isError, true);
  assert.match(r.text, /startsAt: use YYYY-MM-DDTHH:mm, read as America\/New_York time, or add an explicit offset/);
  const end = await t.callTool("skylight_create_event", { title: "x", profileIds: ["12"], startsAt: "2026-10-12T18:30:00Z", endsAt: "tomorrow" });
  assert.match(end.text, /endsAt: use YYYY-MM-DDTHH:mm/);
  assert.equal(t.calls.length, 0);
  await t.close();
});

test("create event validation: shapes, order, timezone, ids and text, all before any request", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: EVENTS, json: { data: ev("1", "x") } }]);
  const timed = { startsAt: "2026-10-12T18:30:00-04:00" };
  for (const args of [
    { title: "x", profileIds: ["12"] },                                                                         // no time at all
    { title: "x", profileIds: ["12"], allDay: true },                                                           // all-day without a date
    { title: "x", profileIds: ["12"], allDay: true, startDate: "2026-10-12", startsAt: timed.startsAt },        // mixed shapes
    { title: "x", profileIds: ["12"], ...timed, startDate: "2026-10-12" },
    { title: "x", profileIds: ["12"], allDay: true, startDate: "2026-10-12", endDate: "2026-10-11" },           // end before start
    { title: "x", profileIds: ["12"], allDay: true, startDate: "2026-02-30" },
    { title: "x", profileIds: ["12"], ...timed, endsAt: "2026-10-12T17:00:00-04:00" },                          // end before start
    { title: "x", profileIds: ["12"], ...timed, timezone: "Mars/Olympus" },
    { title: "x", profileIds: [], ...timed },
    { title: "x", profileIds: ["12", "12"], ...timed },
    { title: " ", profileIds: ["12"], ...timed },
    { title: "x", profileIds: ["12"], ...timed, description: "d".repeat(501) },
    { title: "x", profileIds: ["12"], ...timed, emoji: "a b" },
    { title: "x", profileIds: ["12"], ...timed, recurrence: { frequency: "daily", weekdays: ["MO"] } },
  ]) {
    assert.equal((await t.callTool("skylight_create_event", args)).isError, true, JSON.stringify(args));
  }
  assert.equal(t.calls.filter((c) => c.method === "POST").length, 0);
  await t.close();
});

test("create event allows label ids such as Birthdays but still requires that they exist", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: EVENTS, json: { data: [ev("504", "Mia's birthday", { all_day: true }, "14")] } }]);
  const ok = await t.callTool("skylight_create_event", { title: "Mia's birthday", profileIds: ["14"], allDay: true, startDate: "2026-11-02" });
  assert.equal(ok.isError, false);
  assert.deepEqual((writes(t)[0]!.body as { category_ids: string[] }).category_ids, ["14"]);
  const unknown = await t.callTool("skylight_create_event", { title: "x", profileIds: ["12", "999"], allDay: true, startDate: "2026-11-02" });
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /profileIds: 999 is not a profile on this frame/);
  assert.equal(writes(t).length, 1);
  await t.close();
});

test("create event still posts when the categories lookup fails", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/categories", status: 500, text: "boom" }, { method: "POST", path: EVENTS, json: { data: [ev("505", "x")] } }]);
  const r = await t.callTool("skylight_create_event", { title: "x", profileIds: ["12"], allDay: true, startDate: "2026-11-02" });
  assert.equal(r.isError, false);
  assert.equal(writes(t).length, 1);
  await t.close();
});

const synced = ev("11019627806-1791803100", "Event 3", { source: "google", recurring: true });
function lookupRoute(events: unknown[] | "fail"): MockRoute {
  return events === "fail" ? { method: "GET", path: EVENTS, status: 500, text: "boom" } : { method: "GET", path: EVENTS, json: { data: events } };
}

test("update event PUTs the master id with only the provided fields and apply_to", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, lookupRoute([ev("900", "Dentist")]), { method: "PUT", path: `${EVENTS}/900`, json: { data: ev("900", "Dentist 2") } }]);
  const r = await t.callTool("skylight_update_event", { eventId: "900", title: "Dentist 2", startsAt: "2026-10-12T19:00:00-04:00", endsAt: "2026-10-12T20:00:00-04:00", location: "Elm St", applyTo: "all" });
  assert.equal(r.isError, false);
  assert.deepEqual(writes(t)[0]!.body, { summary: "Dentist 2", starts_at: "2026-10-12T19:00:00-04:00", ends_at: "2026-10-12T20:00:00-04:00", all_day: false, location: "Elm St", apply_to: "all" });
  // the lookup covers a year either side of today
  const q = t.calls.find((c) => c.method === "GET" && c.url.pathname === EVENTS)!.url.searchParams;
  const today = todayIn("America/New_York");
  assert.deepEqual([q.get("date_min"), q.get("date_max")], [addDays(today, -365), addDays(today, 365)]);
  assert.equal((r.data as { title: string }).title, "Dentist 2");
  await t.close();
});

test("update event: all-day dates imply all_day, profileIds and recurrence map to category_ids and rrule, composite ids use the master id", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, lookupRoute([]), { method: "PUT", path: `${EVENTS}/11019627806`, json: { data: ev("11019627806", "x") } }]);
  const r = await t.callTool("skylight_update_event", { eventId: "11019627806-1791803100", startDate: "2026-10-13", profileIds: ["12", "14"], recurrence: { frequency: "daily" }, countdown: false, timezone: "UTC" });
  assert.equal(r.isError, false);
  assert.deepEqual(writes(t)[0]!.body, { starts_at: "2026-10-13", all_day: true, category_ids: ["12", "14"], rrule: ["RRULE:FREQ=DAILY"], countdown_enabled: false, timezone: "UTC" });
  await t.close();
});

test("update event refuses a synced-calendar event with no PUT, and proceeds when the event is simply not found", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, lookupRoute([synced]), { method: "PUT", path: /\/calendar_events\//, json: { data: ev("1", "x") } }]);
  const r = await t.callTool("skylight_update_event", { eventId: "11019627806-1791803100", title: "Nope" });
  assert.equal(r.isError, true);
  assert.match(r.text, /eventId: this event comes from a synced google calendar; change it there/);
  assert.equal(writes(t).length, 0);
  // a different occurrence of the same master is also matched by master id
  const other = await t.callTool("skylight_update_event", { eventId: "11019627806", title: "Nope" });
  assert.match(other.text, /synced google calendar/);
  await t.close();
  const t2 = await connectTestClient([FRAMES, CATEGORIES, lookupRoute([]), { method: "PUT", path: `${EVENTS}/900`, json: { data: ev("900", "x") } }]);
  const ok = await t2.callTool("skylight_update_event", { eventId: "900", title: "Fine" });
  assert.equal(ok.isError, false);
  assert.equal(writes(t2).length, 1);
  await t2.close();
});

test("update event fails closed when the source lookup itself fails: no PUT", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, lookupRoute("fail"), { method: "PUT", path: /\/calendar_events\//, json: { data: ev("900", "x") } }]);
  const r = await t.callTool("skylight_update_event", { eventId: "900", title: "Fine" });
  assert.equal(r.isError, true);
  assert.match(r.text, /^Invalid input\. eventId: could not verify whether this event comes from a synced calendar; try again/);
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("update event validation happens before any request", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, lookupRoute([]), { method: "PUT", path: /\/calendar_events\//, json: {} }]);
  for (const args of [
    { eventId: "900" },
    { eventId: "abc", title: "x" },
    { eventId: "900", startsAt: "6:30 PM" },
    { eventId: "900", startDate: "2026-10-12", startsAt: "2026-10-12T18:30:00Z" },
    { eventId: "900", allDay: true, startsAt: "2026-10-12T18:30:00Z" },
    { eventId: "900", allDay: false, startDate: "2026-10-12" },
    { eventId: "900", startsAt: "2026-10-12T18:30:00Z", endsAt: "2026-10-12T17:30:00Z" },
    { eventId: "900", title: "x", timezone: "Nope/Nope" },
    { eventId: "900", title: "x", applyTo: "one" },
    { eventId: "900", title: "x", applyTo: "future" },
  ]) {
    assert.equal((await t.callTool("skylight_update_event", args)).isError, true, JSON.stringify(args));
  }
  assert.equal(t.calls.length, 0);
  await t.close();
});

test("delete event previews one occurrence, makes no request but the lookup, and DELETEs on confirm", async () => {
  const occ = ev("900-1791803100", "Practice", { recurring: true, starts_at: "2026-10-12T21:00:00.000Z" });
  const t = await connectTestClient([FRAMES, lookupRoute([occ]), { method: "DELETE", path: `${EVENTS}/900-1791803100`, json: { meta: { destroyed_id: "900-1791803100" } } }]);
  const r = await t.callTool("skylight_delete_event", { eventId: "900-1791803100", applyTo: "one" });
  const d = r.data as { confirmed: boolean; wouldDelete: Record<string, unknown>; message: string };
  assert.equal(d.confirmed, false);
  assert.deepEqual(d.wouldDelete, { id: "900-1791803100", masterId: "900", title: "Practice", startsAt: "2026-10-12T17:00:00-04:00", when: "Mon Oct 12, 5:00 PM EDT to 7:30 PM EDT", applyTo: "one", recurring: true });
  assert.match(d.message, /Nothing was deleted/);
  assert.match(d.message, /only this occurrence/);
  assert.equal(writes(t).length, 0);
  const done = await t.callTool("skylight_delete_event", { eventId: "900-1791803100", applyTo: "one", confirm: true });
  assert.deepEqual(done.data, { deleted: true, id: "900-1791803100", applyTo: "one", destroyedId: "900-1791803100" });
  assert.equal(writes(t).length, 1);
  assert.equal(writes(t)[0]!.url.searchParams.get("apply_to"), "one");
  await t.close();
});

test("delete event 'future' keeps the composite id; 'all' on an occurrence id deletes by master id with no query", async () => {
  const t = await connectTestClient([FRAMES, lookupRoute([]),
    { method: "DELETE", path: /\/calendar_events\//, json: { meta: { destroyed_id: "x" } } }]);
  await t.callTool("skylight_delete_event", { eventId: "900-1791803100", applyTo: "future", confirm: true });
  assert.equal(writes(t)[0]!.url.pathname, `${EVENTS}/900-1791803100`);
  assert.equal(writes(t)[0]!.url.searchParams.get("apply_to"), "future");
  await t.callTool("skylight_delete_event", { eventId: "900-1791803100", applyTo: "all", confirm: true });
  assert.equal(writes(t)[1]!.url.pathname, `${EVENTS}/900`);
  assert.equal(writes(t)[1]!.url.search, "");
  const plainAll = await t.callTool("skylight_delete_event", { eventId: "900", applyTo: "all", confirm: true });
  assert.equal(plainAll.isError, false);
  assert.equal(writes(t)[2]!.url.pathname, `${EVENTS}/900`);
  assert.equal(writes(t)[2]!.url.search, "");
  await t.close();
});

test("delete event: a plain id without applyTo sends no apply_to, and the preview says a recurring master deletes the whole series", async () => {
  const master = ev("900", "Practice", { recurring: true });
  const t = await connectTestClient([FRAMES, lookupRoute([master]), { method: "DELETE", path: `${EVENTS}/900`, json: { meta: { destroyed_id: "900" } } }]);
  const preview = await t.callTool("skylight_delete_event", { eventId: "900" });
  assert.match((preview.data as { message: string }).message, /the whole recurring series/);
  assert.equal((preview.data as { wouldDelete: { recurring: boolean } }).wouldDelete.recurring, true);
  const allPreview = await t.callTool("skylight_delete_event", { eventId: "900", applyTo: "all" });
  assert.match((allPreview.data as { message: string }).message, /the whole recurring series/);
  assert.equal(writes(t).length, 0);
  await t.callTool("skylight_delete_event", { eventId: "900", confirm: true });
  assert.equal(writes(t)[0]!.url.search, "");
  await t.close();
  const one = await connectTestClient([FRAMES, lookupRoute([ev("901", "Dentist")])]);
  const p = await one.callTool("skylight_delete_event", { eventId: "901" });
  assert.match((p.data as { message: string }).message, /This would delete this event/);
  await one.close();
});

test("delete event preview after a lookup miss says it could not check and may cover a whole series", async () => {
  const t = await connectTestClient([FRAMES, lookupRoute([]), { method: "DELETE", path: /\/calendar_events\//, json: {} }]);
  for (const args of [{ eventId: "900" }, { eventId: "900", applyTo: "all" }, { eventId: "900-1791803100", applyTo: "all" }]) {
    const r = await t.callTool("skylight_delete_event", args);
    assert.equal(r.isError, false, JSON.stringify(args));
    assert.match((r.data as { message: string }).message, /this event, and every occurrence if it is a recurring series \(could not check\)/, JSON.stringify(args));
  }
  const one = await t.callTool("skylight_delete_event", { eventId: "900-1791803100", applyTo: "one" });
  assert.match((one.data as { message: string }).message, /only this occurrence/);
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("delete event fails closed when the source lookup itself fails, in the preview and on confirm", async () => {
  const t = await connectTestClient([FRAMES, lookupRoute("fail"), { method: "DELETE", path: /\/calendar_events\//, json: {} }]);
  for (const confirm of [undefined, true]) {
    const r = await t.callTool("skylight_delete_event", { eventId: "900", applyTo: "all", ...(confirm ? { confirm } : {}) });
    assert.equal(r.isError, true);
    assert.match(r.text, /eventId: could not verify whether this event comes from a synced calendar; try again/);
  }
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("delete event: one/future need an occurrence id, an occurrence id needs applyTo, bad ids fail; no request at all", async () => {
  const t = await connectTestClient([FRAMES, lookupRoute([]), { method: "DELETE", path: /\/calendar_events\//, json: {} }]);
  for (const args of [
    { eventId: "900", applyTo: "one", confirm: true },
    { eventId: "900", applyTo: "future", confirm: true },
    { eventId: "900-1791803100", confirm: true },
    { eventId: "900-1791803100" },
    { eventId: "../900", confirm: true },
    { eventId: "900", applyTo: "everything", confirm: true },
  ]) {
    assert.equal((await t.callTool("skylight_delete_event", args)).isError, true, JSON.stringify(args));
  }
  assert.equal(t.calls.length, 0);
  await t.close();
});

test("delete event refuses a synced-calendar event in the preview and on confirm, with no DELETE", async () => {
  const t = await connectTestClient([FRAMES, lookupRoute([synced]), { method: "DELETE", path: /\/calendar_events\//, json: {} }]);
  for (const confirm of [undefined, true]) {
    const r = await t.callTool("skylight_delete_event", { eventId: "11019627806-1791803100", applyTo: "one", ...(confirm ? { confirm } : {}) });
    assert.equal(r.isError, true);
    assert.match(r.text, /eventId: this event comes from a synced google calendar; change it there/);
  }
  assert.equal(writes(t).length, 0);
  // the window for an occurrence id is narrowed around the occurrence date
  const q = t.calls.find((c) => c.method === "GET" && c.url.pathname === EVENTS)!.url.searchParams;
  assert.deepEqual([q.get("date_min"), q.get("date_max")], ["2026-10-11", "2026-10-13"]);
  await t.close();
});

test("event tools are annotated: read, create, update, destroy", async () => {
  const t = await connectTestClient([FRAMES]);
  const tools = new Map((await t.client.listTools()).tools.map((x) => [x.name, x]));
  const a = (n: string) => tools.get(n)!.annotations!;
  assert.equal(a("skylight_list_events").readOnlyHint, true);
  assert.deepEqual([a("skylight_create_event").destructiveHint, a("skylight_create_event").openWorldHint], [false, false]);
  assert.equal(a("skylight_update_event").idempotentHint, true);
  assert.deepEqual([a("skylight_delete_event").destructiveHint, a("skylight_delete_event").idempotentHint], [true, false]);
  assert.match(tools.get("skylight_delete_event")!.description ?? "", /confirm: true/);
  assert.match(tools.get("skylight_create_event")!.description ?? "", /Eastern time/);
  await t.close();
});

test("update event converts a bare startsAt to an explicit Eastern offset", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, lookupRoute([]), { method: "PUT", path: `${EVENTS}/900`, json: { data: ev("900", "x") } }]);
  await t.callTool("skylight_update_event", { eventId: "900", startsAt: "2026-07-12T09:00", endsAt: "2026-07-12T10:00" });
  assert.deepEqual(writes(t)[0]!.body, { starts_at: "2026-07-12T09:00:00-04:00", ends_at: "2026-07-12T10:00:00-04:00", all_day: false });
  await t.close();
});

test("'today' comes from the configured zone and the injected clock, not UTC or the process zone", async () => {
  // 23:30 UTC on Oct 12 is already Oct 13 12:30 in Auckland.
  const now = () => new Date("2026-10-12T23:30:00Z");
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "GET", path: EVENTS, json: { data: [] } }, { method: "PUT", path: `${EVENTS}/900`, json: { data: ev("900", "x") } }], { env: { SKYLIGHT_TIMEZONE: "Pacific/Auckland" }, now });
  await t.callTool("skylight_list_events");
  let q = t.calls.at(-1)!.url.searchParams;
  assert.deepEqual([q.get("date_min"), q.get("date_max")], ["2026-10-13", "2026-10-20"]);
  await t.callTool("skylight_update_event", { eventId: "900", title: "x" });
  q = t.calls.filter((c) => c.method === "GET" && c.url.pathname === EVENTS).at(-1)!.url.searchParams;
  assert.deepEqual([q.get("date_min"), q.get("date_max")], [addDays("2026-10-13", -365), addDays("2026-10-13", 365)]);
  await t.close();
  const ny = await connectTestClient([FRAMES, { method: "GET", path: EVENTS, json: { data: [] } }], { now });
  await ny.callTool("skylight_list_events");
  assert.equal(ny.calls.at(-1)!.url.searchParams.get("date_min"), "2026-10-12");
  await ny.close();
});

test("create event refuses a bare time inside the spring-forward gap, with no request", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: EVENTS, json: { data: [ev("1", "x")] } }]);
  const r = await t.callTool("skylight_create_event", { title: "x", profileIds: ["12"], startsAt: "2026-03-08T02:30" });
  assert.equal(r.isError, true);
  assert.match(r.text, /startsAt: 02:30 does not exist on that date in America\/New_York \(clocks skip forward\); pick another time/);
  assert.equal(writes(t).length, 0);
  await t.close();
});
