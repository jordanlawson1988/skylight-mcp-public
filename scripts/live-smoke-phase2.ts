// Phase 2 live write checks: rewards, routine reordering, lists and calendar events. Called from live-smoke.ts when SKYLIGHT_LIVE_WRITE=1.
// Everything runs through the real MCP tools (in-memory client) where that is the behavior under test, and through raw requests for read-backs.
// Every created object carries the PREFIX; cleanup happens in `finally`, followed by leftover checks for rewards, lists and events.
import { addDays, toOffsetDateTime } from "../src/skylight/time.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRuntime, type Runtime } from "../src/runtime.js";
import { createServer } from "../src/server.js";
import { buildChoreCreateBody } from "../src/skylight/chore-payload.js";
import { buildProfileCreateBody, buildProfileUpdateBody } from "../src/skylight/profile-payload.js";
import { mapChores, mapProfile, mapRewardPoints, mapRewards } from "../src/skylight/types.js";
import { OWN_EVENT_SOURCE } from "../src/skylight/vocab.js";
import { WEEKDAYS } from "../src/skylight/rrule.js";

const PREFIX = "[skylight-mcp smoke]";

interface ToolResult { isError: boolean; text: string; data: unknown }

/** An in-memory MCP client over a runtime whose fetch records every non-GET /api request, so a test can prove a tool sent nothing. */
async function connectTools(writes: string[]) {
  const recording = (async (input: string | URL | Request, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname;
    if (method !== "GET" && path.startsWith("/api/")) writes.push(`${method} ${path}`);
    return globalThis.fetch(input, init);
  }) as typeof globalThis.fetch;
  const server = createServer(createRuntime({ fetch: recording }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "skylight-smoke", version: "0.0.0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
    let data: unknown = text;
    try { data = JSON.parse(text); } catch { /* plain text error */ }
    return { isError: r.isError === true, text, data };
  };
  return { call, close: async () => { await client.close(); await server.close(); } };
}

const ok = (r: ToolResult, what: string): unknown => {
  if (r.isError) throw new Error(`${what} failed: ${r.text}`);
  return r.data;
};

export async function phase2Smoke(rt: Runtime, frameId: string, today: string): Promise<void> {
  const stamp = new Date().toISOString();
  const frame = `/api/frames/${frameId}`;
  const steps: string[] = [];
  const step = (name: string) => { steps.push(name); console.log("ok:", name); };
  const writes: string[] = [];
  const tools = await connectTools(writes);
  const { call } = tools;

  const get = <T = unknown>(path: string, query?: Record<string, string | number | boolean>) => rt.client.request<T>({ method: "GET", path: `${frame}${path}`, ...(query ? { query } : {}) });
  const balance = async (profileId: string): Promise<number> => {
    const hit = mapRewardPoints(await get("/reward_points")).find((b) => b.profileId === profileId);
    if (!hit) throw new Error(`no balance row for ${profileId}`);
    return hit.points;
  };

  let profileId: string | null = null;
  const choreSeries: string[] = [];
  const leftovers = { rewards: 0, lists: 0, events: 0, steps: 0 };
  const smokeRewards = async () => {
    const open = mapRewards(await get("/rewards"));
    const redeemed = mapRewards(await get("/rewards", { redeemed_at_min: "1970-01-01T00:00:00Z" }));
    const seen = new Set(open.map((r) => r.id));
    return [...open, ...redeemed.filter((r) => !seen.has(r.id))].filter((r) => r.title.startsWith(PREFIX));
  };
  const smokeLists = async () => ((ok(await call("skylight_list_lists"), "list lists") as Array<{ id: string; title: string }>)).filter((l) => l.title.startsWith(PREFIX));
  const eventsBetween = async (after: string, before: string) =>
    ok(await call("skylight_list_events", { after, before }), "list events") as Array<{ id: string; masterId: string; title: string; startsAt: string; allDay: boolean; source: string; recurring: boolean }>;
  const smokeEvents = async () => (await eventsBetween(addDays(today, -1), addDays(today, 90))).filter((e) => e.title.startsWith(PREFIX));

  try {
    // A dedicated profile keeps real balances untouched.
    const created = mapProfile(((await rt.client.request<unknown>({ method: "POST", path: `${frame}/categories`, body: buildProfileCreateBody({ name: `${PREFIX} p2 ${stamp}`, color: "#654321", kind: "profile" }) })) as { data?: unknown } | null)?.data);
    if (!created) throw new Error("phase 2 smoke profile create returned no profile");
    profileId = created.id;
    step(`phase 2 profile created ${profileId}`);

    // ---- Rewards: create (cost 4, no respawn), update to 3, preview, redeem, unredeem, delete.
    await rt.client.request({ method: "POST", path: `${frame}/reward_points`, body: { category_ids: [profileId], points: 10 } });
    if ((await balance(profileId)) !== 10) throw new Error("smoke profile balance is not 10 after adding 10 points");
    step("reward points added, balance 10");
    const made = ok(await call("skylight_create_reward", { title: `${PREFIX} reward ${stamp}`, cost: 4, profileIds: [profileId], respawnOnRedemption: false }), "create reward") as { created: number; rewards: Array<{ id: string; cost: number; profileId: string; respawnOnRedemption: boolean }> };
    const reward = made.rewards[0];
    if (made.created !== 1 || !reward || reward.cost !== 4 || reward.profileId !== profileId || reward.respawnOnRedemption !== false) throw new Error(`reward create unexpected: ${JSON.stringify(made)}`);
    step(`reward created ${reward.id} (cost 4, respawn off)`);
    ok(await call("skylight_update_reward", { rewardId: reward.id, cost: 3 }), "update reward");
    const listed = (await smokeRewards()).find((r) => r.id === reward.id);
    if (listed?.cost !== 3) throw new Error(`reward cost after update is ${String(listed?.cost)}`);
    step("reward cost updated to 3");
    const before = writes.length;
    const preview = ok(await call("skylight_redeem_reward", { rewardId: reward.id }), "redeem preview") as { confirmed: boolean; wouldRedeem: { cost: number; currentPoints: number } };
    if (preview.confirmed !== false || preview.wouldRedeem.cost !== 3 || preview.wouldRedeem.currentPoints !== 10) throw new Error(`redeem preview unexpected: ${JSON.stringify(preview)}`);
    if (writes.length !== before || (await balance(profileId)) !== 10) throw new Error("redeem preview changed something");
    step("redeem preview changed nothing");
    const redeemed = ok(await call("skylight_redeem_reward", { rewardId: reward.id, confirm: true }), "redeem") as { redeemed: boolean; balance: { points: number } | null };
    if (!redeemed.redeemed || (await balance(profileId)) !== 7) throw new Error(`balance after redeem is not 7: ${JSON.stringify(redeemed)}`);
    step("reward redeemed, balance 7");
    ok(await call("skylight_unredeem_reward", { rewardId: reward.id }), "unredeem");
    if ((await balance(profileId)) !== 10) throw new Error("balance after unredeem is not 10");
    step("reward unredeemed, balance 10");
    const delPreview = ok(await call("skylight_delete_reward", { rewardId: reward.id }), "delete reward preview") as { confirmed: boolean };
    if (delPreview.confirmed !== false || !(await smokeRewards()).some((r) => r.id === reward.id)) throw new Error("reward delete preview changed something");
    ok(await call("skylight_delete_reward", { rewardId: reward.id, confirm: true }), "delete reward");
    if ((await smokeRewards()).some((r) => r.id === reward.id)) throw new Error("reward still listed after delete");
    step("reward deleted");

    // ---- Routine reorder: two morning steps, move step 2 before step 1.
    const mk = async (summary: string): Promise<string> => {
      const json = await rt.client.request<unknown>({ method: "POST", path: `${frame}/chores/create_multiple`, body: buildChoreCreateBody({ summary: `${PREFIX} ${summary} ${stamp}`, start: today, profileIds: [profileId!], routine: true, timeOfDay: "morning" }) });
      const chore = mapChores(json)[0];
      if (!chore) throw new Error("routine step create returned no chore");
      choreSeries.push(chore.seriesId);
      return chore.seriesId;
    };
    const first = await mk("step one");
    const second = await mk("step two");
    const positions = async (): Promise<Map<string, number | null>> => {
      const rows = mapChores(await get("/chores", { after: today, before: today, include_late: false, include_up_for_grabs: true, filter: "linked_to_profile" }));
      return new Map(rows.filter((c) => c.seriesId === first || c.seriesId === second).map((c) => [c.seriesId, c.position]));
    };
    const p0 = await positions();
    if ((p0.get(first) ?? Infinity) >= (p0.get(second) ?? -Infinity)) throw new Error(`steps are not in creation order: ${JSON.stringify([...p0])}`);
    step("routine steps listed in creation order");
    const moved = ok(await call("skylight_move_routine_step", { choreId: second, beforeChoreId: first }), "move routine step") as { moved: boolean };
    const p1 = await positions();
    if (!moved.moved || (p1.get(second) ?? Infinity) >= (p1.get(first) ?? -Infinity)) throw new Error(`step two is not before step one after the move: ${JSON.stringify([...p1])}`);
    step("routine step two moved before step one");
    for (const id of [...choreSeries]) {
      await rt.client.request({ method: "DELETE", path: `${frame}/chores/${id}`, query: { apply_to: "all" } });
      choreSeries.splice(choreSeries.indexOf(id), 1);
    }
    step("routine steps deleted");

    // ---- Lists: create, add 3 items (one sectioned), complete, rename, move within the null section, bulk delete two, delete list.
    const list = ok(await call("skylight_create_list", { title: `${PREFIX} list ${stamp}`, kind: "to_do" }), "create list") as { id: string; kind: string };
    step(`list created ${list.id}`);
    const added = ok(await call("skylight_add_list_items", { listId: list.id, items: [{ title: "Alpha" }, { title: "Bravo" }, { title: "Charlie", section: "Smoke section" }] }), "add list items") as { added: number; failed: number };
    if (added.added !== 3 || added.failed !== 0) throw new Error(`add list items: ${JSON.stringify(added)}`);
    type Item = { id: string; title: string; done: boolean; section: string | null; position: number | null };
    const items = async () => ok(await call("skylight_list_items", { listId: list.id }), "list items") as Item[];
    let all = await items();
    const byTitle = (t: string): Item => { const hit = all.find((i) => i.title === t); if (!hit) throw new Error(`item ${t} missing: ${JSON.stringify(all)}`); return hit; };
    if (all.length !== 3 || byTitle("Charlie").section !== "Smoke section" || byTitle("Alpha").section !== null) throw new Error(`items unexpected: ${JSON.stringify(all)}`);
    step("list items added (one in a section)");
    ok(await call("skylight_update_list_item", { listId: list.id, itemId: byTitle("Alpha").id, done: true }), "complete item");
    all = await items();
    if (!byTitle("Alpha").done) throw new Error("Alpha is not done after completing it");
    step("list item completed");
    ok(await call("skylight_update_list_item", { listId: list.id, itemId: byTitle("Bravo").id, title: "Bravo renamed" }), "rename item");
    all = await items();
    if (all.some((i) => i.title === "Bravo") || !all.some((i) => i.title === "Bravo renamed")) throw new Error("rename not reflected");
    step("list item renamed");
    ok(await call("skylight_move_list_item", { listId: list.id, itemId: byTitle("Bravo renamed").id, afterItemId: null }), "move item to top");
    all = await items();
    const unsectioned = all.filter((i) => i.section === null).map((i) => i.title);
    if (unsectioned[0] !== "Bravo renamed") throw new Error(`Bravo renamed is not first in the null section: ${unsectioned.join(", ")}`);
    step("list item moved to the top of the null section");
    const cross = await call("skylight_move_list_item", { listId: list.id, itemId: byTitle("Bravo renamed").id, afterItemId: byTitle("Charlie").id });
    if (!cross.isError || !/different section/.test(cross.text)) throw new Error(`cross-section move was not mapped: ${cross.text}`);
    step("cross-section move refused with guidance");
    const delItems = [byTitle("Alpha").id, byTitle("Bravo renamed").id];
    const itemsPreview = ok(await call("skylight_delete_list_items", { listId: list.id, itemIds: delItems }), "delete items preview") as { confirmed: boolean; wouldDelete: { items: unknown[] } };
    if (itemsPreview.confirmed !== false || itemsPreview.wouldDelete.items.length !== 2 || (await items()).length !== 3) throw new Error("delete items preview changed something or listed the wrong items");
    ok(await call("skylight_delete_list_items", { listId: list.id, itemIds: delItems, confirm: true }), "delete items");
    all = await items();
    if (all.length !== 1 || all[0]!.title !== "Charlie") throw new Error(`items after bulk delete: ${JSON.stringify(all)}`);
    step("two list items bulk deleted");
    ok(await call("skylight_update_list", { listId: list.id, hiddenOnDevice: true }), "update list");
    step("list updated");
    const listPreview = ok(await call("skylight_delete_list", { listId: list.id }), "delete list preview") as { wouldDelete: { itemCount: number } };
    if (listPreview.wouldDelete.itemCount !== 1) throw new Error(`list delete preview item count: ${JSON.stringify(listPreview)}`);
    ok(await call("skylight_delete_list", { listId: list.id, confirm: true }), "delete list");
    if ((await smokeLists()).length !== 0) throw new Error("list still present after delete");
    step("list deleted");

    // ---- Events.
    const day1 = addDays(today, 1);
    const allDay = ok(await call("skylight_create_event", { title: `${PREFIX} all-day ${stamp}`, profileIds: [profileId], allDay: true, startDate: day1 }), "create all-day event") as { events: Array<{ id: string; allDay: boolean; startsAt: string }> };
    if (!allDay.events[0]?.allDay) throw new Error(`all-day event came back as ${JSON.stringify(allDay)}`);
    step(`all-day event created ${allDay.events[0].id} (starts ${allDay.events[0].startsAt})`);
    const timed = ok(await call("skylight_create_event", { title: `${PREFIX} timed ${stamp}`, profileIds: [profileId], startsAt: `${day1}T18:30:00-04:00`, timezone: "America/New_York" }), "create timed event") as { events: Array<{ id: string; startsAt: string }> };
    const echoed = timed.events[0]?.startsAt ?? "";
    if (!echoed.startsWith(`${day1}T18:30:00`) || !echoed.endsWith("-04:00")) throw new Error(`timed event did not keep the local time and offset: ${echoed}`);
    step(`timed event keeps local time and offset (${echoed})`);
    // A bare T18:30 is read as Eastern time and sent with an explicit offset (otherwise Skylight would store it as 18:30 UTC).
    const bare = ok(await call("skylight_create_event", { title: `${PREFIX} bare ${stamp}`, profileIds: [profileId], startsAt: `${day1}T18:30` }), "create event from a bare time") as { events: Array<{ id: string; when: string | null }> };
    const bareEvent = bare.events[0];
    if (!bareEvent || !bareEvent.when?.includes("6:30 PM")) throw new Error(`bare-time event 'when' does not say 6:30 PM: ${JSON.stringify(bareEvent)}`);
    const rawRows = (await get<{ data?: Array<{ id: string; attributes?: { starts_at?: string } }> }>("/calendar_events", { date_min: addDays(day1, -1), date_max: addDays(day1, 2) })).data ?? [];
    const rawStart = rawRows.find((r) => r.id === bareEvent.id)?.attributes?.starts_at ?? "";
    // The list endpoint echoes UTC; compare instants, not strings. 18:30 Eastern is 22:30Z (EDT) or 23:30Z (EST).
    const wantInstant = Date.parse(toOffsetDateTime(`${day1}T18:30`, "America/New_York", "startsAt"));
    if (!rawStart || Date.parse(rawStart) !== wantInstant) throw new Error(`Skylight stored the bare-time event as ${rawStart || "(not found)"}, which is not 18:30 Eastern on ${day1}`);
    step(`bare 18:30 input stored as the right instant (${rawStart}); when = ${bareEvent.when}`);
    const weekday = WEEKDAYS[(new Date(`${day1}T00:00:00Z`).getUTCDay() + 6) % 7]!;
    const weekly = ok(await call("skylight_create_event", { title: `${PREFIX} weekly ${stamp}`, profileIds: [profileId], startsAt: `${day1}T09:00:00-04:00`, timezone: "America/New_York", recurrence: { frequency: "weekly", weekdays: [weekday] } }), "create weekly event") as { events: Array<{ id: string }> };
    const master = weekly.events[0]?.id;
    if (!master) throw new Error("weekly event create returned no id");
    const series = (await eventsBetween(day1, addDays(day1, 22))).filter((e) => e.title === `${PREFIX} weekly ${stamp}`);
    const occurrences = series.filter((e) => /^\d+-\d+$/.test(e.id));
    if (series.length < 3 || occurrences.length === 0 || occurrences.some((e) => e.masterId !== series[0]!.masterId)) throw new Error(`weekly series not listed with composite ids: ${series.map((e) => e.id).join(", ")}`);
    step(`weekly event lists ${series.length} occurrences with composite ids (${occurrences[0]!.id})`);
    const target = occurrences[0]!.id;
    const onePreview = ok(await call("skylight_delete_event", { eventId: target, applyTo: "one" }), "delete one preview") as { confirmed: boolean };
    if (onePreview.confirmed !== false) throw new Error("delete preview confirmed something");
    ok(await call("skylight_delete_event", { eventId: target, applyTo: "one", confirm: true }), "delete one occurrence");
    const after = (await eventsBetween(day1, addDays(day1, 22))).filter((e) => e.title === `${PREFIX} weekly ${stamp}`);
    if (after.some((e) => e.id === target) || after.length !== series.length - 1) throw new Error(`occurrence ${target} not removed alone: ${after.map((e) => e.id).join(", ")}`);
    step("one occurrence deleted, the rest remain");
    const seriesPreview = ok(await call("skylight_delete_event", { eventId: series[0]!.masterId }), "delete series preview") as { message: string };
    if (!/whole recurring series/.test(seriesPreview.message)) throw new Error(`series delete preview does not warn: ${seriesPreview.message}`);
    ok(await call("skylight_delete_event", { eventId: series[0]!.masterId, confirm: true }), "delete series");
    if ((await eventsBetween(day1, addDays(day1, 22))).some((e) => e.title === `${PREFIX} weekly ${stamp}`)) throw new Error("weekly series still listed after deleting it");
    step("weekly series deleted");

    // A synced (non-Skylight) event must be refused without any write request.
    const synced = (await eventsBetween(today, addDays(today, 14))).find((e) => e.source !== OWN_EVENT_SOURCE);
    if (synced) {
      const writesBefore = writes.length;
      const refused = await call("skylight_update_event", { eventId: synced.id, title: `${PREFIX} must not apply` });
      const refusedDelete = await call("skylight_delete_event", { eventId: synced.id, applyTo: synced.recurring && /-/.test(synced.id) ? "one" : "all", confirm: true });
      if (!refused.isError || !/synced/.test(refused.text) || !refusedDelete.isError || !/synced/.test(refusedDelete.text)) throw new Error(`synced event was not refused: ${refused.text} / ${refusedDelete.text}`);
      if (writes.length !== writesBefore) throw new Error(`refusing a synced event still sent: ${writes.slice(writesBefore).join(", ")}`);
      step(`synced ${synced.source} event refused for update and delete with no write request`);
    } else {
      console.log("note: no synced event in the next 14 days; refusal not exercised live");
    }
  } finally {
    for (const id of [...choreSeries]) {
      try {
        await rt.client.request({ method: "DELETE", path: `${frame}/chores/${id}`, query: { apply_to: "all" } });
        choreSeries.splice(choreSeries.indexOf(id), 1);
        console.log("cleanup deleted routine step", id);
      } catch (e) { console.error("cleanup FAILED for routine step", id, e instanceof Error ? e.message : e); }
    }
    try {
      const rows = mapChores(await get("/chores", { after: addDays(today, -1), before: addDays(today, 14), include_late: true, include_up_for_grabs: true, filter: "linked_to_profile" }));
      leftovers.steps = rows.filter((c) => c.summary.startsWith(PREFIX)).length;
    } catch (e) { console.error("routine step leftover check failed:", e instanceof Error ? e.message : e); leftovers.steps = -1; }
    try {
      for (const masterId of new Set((await smokeEvents()).map((e) => e.masterId))) {
        try { await rt.client.request({ method: "DELETE", path: `${frame}/calendar_events/${masterId}` }); console.log("cleanup deleted event", masterId); }
        catch (err) { console.error("cleanup FAILED for event", masterId, err instanceof Error ? err.message : err); }
      }
      leftovers.events = (await smokeEvents()).length;
    } catch (e) { console.error("event cleanup failed:", e instanceof Error ? e.message : e); leftovers.events = -1; }
    try {
      for (const l of await smokeLists()) {
        try { await rt.client.request({ method: "DELETE", path: `${frame}/lists/${l.id}` }); console.log("cleanup deleted list", l.id); }
        catch (err) { console.error("cleanup FAILED for list", l.id, err instanceof Error ? err.message : err); }
      }
      leftovers.lists = (await smokeLists()).length;
    } catch (e) { console.error("list cleanup failed:", e instanceof Error ? e.message : e); leftovers.lists = -1; }
    try {
      for (const r of await smokeRewards()) {
        try { await rt.client.request({ method: "DELETE", path: `${frame}/rewards/${r.id}` }); console.log("cleanup deleted reward", r.id); }
        catch (err) { console.error("cleanup FAILED for reward", r.id, err instanceof Error ? err.message : err); }
      }
      leftovers.rewards = (await smokeRewards()).length;
    } catch (e) { console.error("reward cleanup failed:", e instanceof Error ? e.message : e); leftovers.rewards = -1; }
    if (profileId !== null) {
      try {
        await rt.client.request({ method: "DELETE", path: `${frame}/categories/${profileId}` });
        console.log("cleanup deleted profile", profileId);
      } catch {
        try {
          await rt.client.request({ method: "PUT", path: `${frame}/categories/${profileId}`, body: buildProfileUpdateBody({ kind: "label" }) });
          await rt.client.request({ method: "DELETE", path: `${frame}/categories/${profileId}` });
          console.log("cleanup converted profile to a label, then deleted it", profileId);
        } catch (e) { console.error("cleanup FAILED for profile", profileId, e instanceof Error ? e.message : e); }
      }
    }
    await tools.close();
    console.log(`phase 2 leftovers: rewards ${leftovers.rewards}, lists ${leftovers.lists}, events ${leftovers.events}, routine steps ${leftovers.steps}`);
  }
  if (leftovers.rewards !== 0 || leftovers.lists !== 0 || leftovers.events !== 0 || leftovers.steps !== 0) {
    throw new Error(`phase 2 smoke left objects behind (rewards ${leftovers.rewards}, lists ${leftovers.lists}, events ${leftovers.events}, routine steps ${leftovers.steps}; -1 means the check itself failed). Delete the "${PREFIX}" items in the Skylight app.`);
  }
  console.log(`phase 2 write smoke OK (${steps.join("; ")})`);
}
