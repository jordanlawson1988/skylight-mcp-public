import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectTestClient } from "../helpers/test-server.js";
import type { MockRoute, RecordedCall } from "../helpers/mock-fetch.js";

const FRAMES: MockRoute = { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77" }] } };
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
const writes = (t: { calls: RecordedCall[] }) => t.calls.filter((c) => c.method !== "GET");
const MEALS = "/api/frames/77/meals";
const CATEGORIES: MockRoute = { method: "GET", path: `${MEALS}/categories`, json: fixture("meal_categories") };
const SITTINGS: MockRoute = { method: "GET", path: `${MEALS}/sittings`, json: fixture("meal_sittings") };
const INCLUDE = "meal_category,meal_recipe";
const NOW = () => new Date("2026-10-12T15:00:00Z");

test("list meal categories maps the fixture sorted by position", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES]);
  const r = await t.callTool("skylight_list_meal_categories");
  assert.deepEqual(r.data, [
    { id: "6859334", name: "Breakfast", color: "#A8D4D3", enabled: true, position: 0 },
    { id: "6859335", name: "Lunch", color: "#F66951", enabled: true, position: 1 },
    { id: "6859336", name: "Dinner", color: "#915EA1", enabled: true, position: 2 },
    { id: "6859337", name: "Snack", color: "#FDC36D", enabled: true, position: 3 },
  ]);
  await t.close();
});

test("update meal category PATCHes label, color and enabled, and only those provided", async () => {
  const t = await connectTestClient([FRAMES, { method: "PATCH", path: `${MEALS}/categories/6859334`, json: { data: { id: "6859334", type: "meal_category", attributes: { label: "Brunch", color: "#A8D4D3", enabled: false, position: 0 } } } }]);
  const r = await t.callTool("skylight_update_meal_category", { categoryId: "6859334", name: " Brunch ", enabled: false });
  assert.equal(r.isError, false);
  assert.deepEqual(writes(t).map((c) => [c.method, c.url.pathname, c.body]), [["PATCH", `${MEALS}/categories/6859334`, { label: "Brunch", enabled: false }]]);
  assert.deepEqual(r.data, { id: "6859334", name: "Brunch", color: "#A8D4D3", enabled: false, position: 0 });
  await t.callTool("skylight_update_meal_category", { categoryId: "6859334", color: "#a8d4d3" });
  assert.deepEqual(writes(t)[1]!.body, { color: "#A8D4D3" });
  await t.close();
});

test("update meal category validates before any request", async () => {
  const t = await connectTestClient([FRAMES]);
  for (const args of [{ categoryId: "6859334" }, { categoryId: "6859334", color: "blue" }, { categoryId: "6859334", name: " " }, { categoryId: "../1", name: "x" }, { categoryId: "abc", name: "x" }]) {
    assert.equal((await t.callTool("skylight_update_meal_category", args)).isError, true, JSON.stringify(args));
  }
  assert.equal(t.calls.length, 0);
  await t.close();
});

test("list meals sends date_min/date_max/include and returns one row per date, sorted by date then category position", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, SITTINGS]);
  const r = await t.callTool("skylight_list_meals", { after: "2026-10-13", before: "2026-10-15" });
  const q = t.calls.find((c) => c.url.pathname === `${MEALS}/sittings`)!.url.searchParams;
  assert.deepEqual([q.get("date_min"), q.get("date_max"), q.get("include")], ["2026-10-13", "2026-10-16", INCLUDE]);
  const rows = r.data as Array<{ mealId: string; date: string; category: { name: string }; title: string }>;
  assert.deepEqual(rows.map((x) => [x.date, x.mealId, x.title, x.category.name]), [
    ["2026-10-13", "1002", "Cereal", "Breakfast"], ["2026-10-13", "1001", "Pasta night", "Dinner"], ["2026-10-14", "1002", "Cereal", "Breakfast"], ["2026-10-15", "1002", "Cereal", "Breakfast"],
  ]);
  assert.deepEqual(rows[1], { mealId: "1001", date: "2026-10-13", category: { id: "6859336", name: "Dinner" }, title: "Pasta night", recipeId: "2001", note: "Use the big pot", recurring: false, recurrenceRule: null } as never);
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("list meals defaults to today through 7 days ahead in the configured zone, caps the span at 62 days and checks order", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, SITTINGS], { now: NOW });
  await t.callTool("skylight_list_meals");
  const q = t.calls.find((c) => c.url.pathname === `${MEALS}/sittings`)!.url.searchParams;
  assert.deepEqual([q.get("date_min"), q.get("date_max")], ["2026-10-12", "2026-10-20"]);
  const before = t.calls.length;
  assert.equal((await t.callTool("skylight_list_meals", { after: "2026-10-01", before: "2026-12-04" })).isError, true);
  assert.equal((await t.callTool("skylight_list_meals", { after: "2026-10-05", before: "2026-10-01" })).isError, true);
  assert.equal((await t.callTool("skylight_list_meals", { after: "10/01" })).isError, true);
  assert.equal(t.calls.length, before);
  assert.equal((await t.callTool("skylight_list_meals", { after: "2026-10-01", before: "2026-12-02" })).isError, false);
  await t.close();
});

const created = (id: string, over: Record<string, unknown> = {}) => ({ id, type: "meal_sitting", attributes: { summary: "Taco night", description: null, note: null, rrule: null, draft: false, recurring: false, instances: ["2026-10-13"], ...over }, relationships: { meal_category: { data: { id: "6859336" } }, meal_recipe: { data: null }, profiles: { data: [] } } });

test("plan meal POSTs the verified body with date_min/date_max/include, and returns the created rows", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: `${MEALS}/sittings`, json: { data: [created("5001")] } }]);
  const r = await t.callTool("skylight_plan_meal", { date: "2026-10-13", category: "dinner", title: " Taco night " });
  assert.equal(r.isError, false);
  const [post] = writes(t);
  assert.equal(post!.url.pathname, `${MEALS}/sittings`);
  assert.deepEqual([post!.url.searchParams.get("date_min"), post!.url.searchParams.get("date_max"), post!.url.searchParams.get("include")], ["2026-10-13", "2026-10-14", INCLUDE]);
  assert.deepEqual(post!.body, { meal_category_id: "6859336", add_to_grocery_list: false, summary: "Taco night", date: "2026-10-13" });
  const d = r.data as { created: number; meals: Array<{ mealId: string; date: string; title: string; category: { name: string } }> };
  assert.equal(d.created, 1);
  assert.deepEqual([d.meals[0]!.mealId, d.meals[0]!.date, d.meals[0]!.title, d.meals[0]!.category.name], ["5001", "2026-10-13", "Taco night", "Dinner"]);
  await t.close();
});

test("plan meal resolves a category by id or case-insensitive name, and lists the names when it is unknown", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: `${MEALS}/sittings`, json: { data: [created("5001")] } }]);
  await t.callTool("skylight_plan_meal", { date: "2026-10-13", category: "6859334", title: "x" });
  await t.callTool("skylight_plan_meal", { date: "2026-10-13", category: " SNACK ", title: "x" });
  assert.deepEqual(writes(t).map((c) => (c.body as { meal_category_id: string }).meal_category_id), ["6859334", "6859337"]);
  const bad = await t.callTool("skylight_plan_meal", { date: "2026-10-13", category: "Brunch", title: "x" });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Brunch/);
  for (const name of ["Breakfast", "Lunch", "Dinner", "Snack"]) assert.match(bad.text, new RegExp(name));
  assert.equal(writes(t).length, 2);
  await t.close();
});

test("plan meal with a recipe: meal_recipe_id, no summary, addToGroceryList; recurrence loses the RRULE: prefix", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: `${MEALS}/sittings`, json: { data: [created("5002", { rrule: "FREQ=DAILY", recurring: true, instances: ["2026-10-13"] })] } }]);
  const r = await t.callTool("skylight_plan_meal", { date: "2026-10-13", category: "Dinner", recipeId: "48148099", note: "Double it", addToGroceryList: true, recurrence: { frequency: "daily" } });
  assert.equal(r.isError, false);
  assert.deepEqual(writes(t)[0]!.body, { meal_category_id: "6859336", meal_recipe_id: "48148099", add_to_grocery_list: true, date: "2026-10-13", note: "Double it", rrule: "FREQ=DAILY" });
  assert.deepEqual((r.data as { meals: Array<{ recurring: boolean; recurrenceRule: string }> }).meals.map((m) => [m.recurring, m.recurrenceRule]), [[true, "FREQ=DAILY"]]);
  await t.close();
});

test("plan meal validation happens before any request", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: `${MEALS}/sittings`, json: { data: [created("5001")] } }]);
  const base = { date: "2026-10-13", category: "Dinner" };
  for (const args of [
    { ...base }, { ...base, title: "x", recipeId: "5" }, { ...base, title: " " }, { ...base, date: "2026-02-30", title: "x" }, { ...base, title: "x", addToGroceryList: true },
    { ...base, title: "x", recurrence: { frequency: "weekly", weekdays: [] } }, { ...base, recipeId: "nope" },
  ]) assert.equal((await t.callTool("skylight_plan_meal", args)).isError, true, JSON.stringify(args));
  assert.equal(t.calls.length, 0);
  await t.close();
});

const one = { ...(fixture("meal_sittings") as { data: unknown[] }) };
const sittingsFor = (...ids: string[]): MockRoute => ({ method: "GET", path: `${MEALS}/sittings`, json: { data: (one.data as Array<{ id: string }>).filter((s) => ids.includes(s.id)) } });

test("update meal on a one-time meal PATCHes the instance path with no apply_to, then re-reads that date", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, sittingsFor("1001"), { method: "PATCH", path: `${MEALS}/sittings/1001/instances/2026-10-13`, json: { data: [] } }]);
  const r = await t.callTool("skylight_update_meal", { mealId: "1001", date: "2026-10-13", note: "New note", category: "lunch" });
  assert.equal(r.isError, false);
  const [patch] = writes(t);
  assert.equal(patch!.method, "PATCH");
  assert.equal(patch!.url.pathname, `${MEALS}/sittings/1001/instances/2026-10-13`);
  assert.equal(patch!.url.searchParams.get("apply_to"), null);
  assert.deepEqual([patch!.url.searchParams.get("date_min"), patch!.url.searchParams.get("date_max"), patch!.url.searchParams.get("include")], ["2026-10-13", "2026-10-14", INCLUDE]);
  assert.deepEqual(patch!.body, { note: "New note", meal_category_id: "6859335" });
  const d = r.data as { updated: boolean; meals: Array<{ mealId: string }> };
  assert.equal(d.updated, true);
  assert.deepEqual(d.meals.map((m) => m.mealId), ["1001"]);
  await t.close();
});

test("update meal on a recurring meal needs applyTo, sends it as apply_to, and the description warns that one splits", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, sittingsFor("1002"), { method: "PATCH", path: /\/meals\/sittings\/1002\/instances\/2026-10-14$/, json: { data: [] } }]);
  const missing = await t.callTool("skylight_update_meal", { mealId: "1002", date: "2026-10-14", title: "Oatmeal" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /applyTo/);
  assert.equal(writes(t).length, 0);
  for (const applyTo of ["one", "future", "all"]) {
    const r = await t.callTool("skylight_update_meal", { mealId: "1002", date: "2026-10-14", title: "Oatmeal", applyTo });
    assert.equal(r.isError, false, applyTo);
  }
  assert.deepEqual(writes(t).map((c) => c.url.searchParams.get("apply_to")), ["one", "future", "all"]);
  assert.deepEqual(writes(t)[0]!.body, { summary: "Oatmeal" });
  const tools = new Map((await t.client.listTools()).tools.map((x) => [x.name, x]));
  assert.match(tools.get("skylight_update_meal")!.description ?? "", /new mealId/i);
  await t.close();
});

test("update meal rejects applyTo on a one-time meal, an unknown meal, a date that is not one of its dates, and an empty change", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, sittingsFor("1001", "1002"), { method: "PATCH", path: /sittings/, json: {} }]);
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ mealId: "1001", date: "2026-10-13", note: "x", applyTo: "one" }, /one-time/],
    [{ mealId: "9999", date: "2026-10-13", note: "x" }, /mealId/],
    [{ mealId: "1002", date: "2026-10-20", note: "x", applyTo: "all" }, /2026-10-13/],
    [{ mealId: "1001", date: "2026-10-13" }, /update/],
    [{ mealId: "1001", date: "2026-10-13", note: "x", category: "Brunch" }, /Brunch/],
    [{ mealId: "1002", date: "2026-10-13", note: "x", applyTo: "sometimes" }, /./],
    [{ mealId: "1001", date: "tomorrow", note: "x" }, /date/],
  ];
  for (const [args, pattern] of cases) {
    const r = await t.callTool("skylight_update_meal", args);
    assert.equal(r.isError, true, JSON.stringify(args));
    assert.match(r.text, pattern, JSON.stringify(args));
  }
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("delete meal previews each scope in words and writes nothing", async () => {
  const t = await connectTestClient([FRAMES, sittingsFor("1001", "1002"), { method: "DELETE", path: /sittings/, json: {} }]);
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ mealId: "1002", date: "2026-10-14", applyTo: "one" }, "only this date"],
    [{ mealId: "1002", date: "2026-10-14", applyTo: "future" }, "this date and later"],
    [{ mealId: "1002", date: "2026-10-14", applyTo: "all" }, "every date of this meal"],
    [{ mealId: "1001", date: "2026-10-13" }, "this meal"],
  ];
  for (const [args, scope] of cases) {
    const r = await t.callTool("skylight_delete_meal", args);
    const d = r.data as { confirmed: boolean; wouldDelete: Record<string, unknown>; message: string };
    assert.equal(d.confirmed, false, JSON.stringify(args));
    assert.match(d.message, /Nothing was deleted/);
    assert.ok(d.message.includes(scope), `${scope} in ${d.message}`);
    assert.match(d.message, /confirm: true/);
  }
  const first = await t.callTool("skylight_delete_meal", { mealId: "1001", date: "2026-10-13" });
  assert.deepEqual((first.data as { wouldDelete: unknown }).wouldDelete, { mealId: "1001", date: "2026-10-13", title: "Pasta night", applyTo: null, recurring: false });
  assert.match((first.data as { message: string }).message, /Pasta night/);
  assert.match((first.data as { message: string }).message, /Tue Oct 13/);
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("delete meal with confirm DELETEs the instance, sending apply_to only for a recurring meal", async () => {
  const t = await connectTestClient([FRAMES, sittingsFor("1001", "1002"), { method: "DELETE", path: /sittings/, json: {} }]);
  const a = await t.callTool("skylight_delete_meal", { mealId: "1001", date: "2026-10-13", confirm: true });
  assert.deepEqual(a.data, { deleted: true, mealId: "1001", date: "2026-10-13", applyTo: null });
  await t.callTool("skylight_delete_meal", { mealId: "1002", date: "2026-10-14", applyTo: "future", confirm: true });
  assert.deepEqual(writes(t).map((c) => [c.method, c.url.pathname, c.url.search]), [
    ["DELETE", `${MEALS}/sittings/1001/instances/2026-10-13`, ""],
    ["DELETE", `${MEALS}/sittings/1002/instances/2026-10-14`, "?apply_to=future"],
  ]);
  await t.close();
});

test("delete meal enforces the applyTo rule and finds the meal on that date, in the preview and on confirm, with no DELETE", async () => {
  const t = await connectTestClient([FRAMES, sittingsFor("1001", "1002"), { method: "DELETE", path: /sittings/, json: {} }]);
  const cases: Array<Record<string, unknown>> = [
    { mealId: "1002", date: "2026-10-14" }, { mealId: "1001", date: "2026-10-13", applyTo: "all" }, { mealId: "9999", date: "2026-10-13" },
    { mealId: "1002", date: "2026-10-30", applyTo: "one" }, { mealId: "1001", date: "bad" },
  ];
  for (const args of cases) {
    assert.equal((await t.callTool("skylight_delete_meal", args)).isError, true, JSON.stringify(args));
    assert.equal((await t.callTool("skylight_delete_meal", { ...args, confirm: true })).isError, true, JSON.stringify(args));
  }
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("a server-side apply_to refusal is turned into guidance on update and delete", async () => {
  const refusal = { status: 422, text: '{"errors":{"apply_to":["must not provide apply_to with a non-recurring sitting"]}}' };
  const t = await connectTestClient([FRAMES, CATEGORIES, sittingsFor("1002"), { method: "PATCH", path: /sittings/, ...refusal }, { method: "DELETE", path: /sittings/, ...refusal }]);
  const update = await t.callTool("skylight_update_meal", { mealId: "1002", date: "2026-10-14", applyTo: "one", note: "x" });
  assert.equal(update.isError, true);
  assert.match(update.text, /^Invalid input\. applyTo: Skylight refused this scope/);
  const del = await t.callTool("skylight_delete_meal", { mealId: "1002", date: "2026-10-14", applyTo: "one", confirm: true });
  assert.match(del.text, /^Invalid input\. applyTo: Skylight refused this scope/);
  // an unrelated server error passes through untouched
  const other = await connectTestClient([FRAMES, CATEGORIES, sittingsFor("1002"), { method: "DELETE", path: /sittings/, status: 500, text: "boom" }]);
  assert.match((await other.callTool("skylight_delete_meal", { mealId: "1002", date: "2026-10-14", applyTo: "one", confirm: true })).text, /500/);
  await other.close();
  await t.close();
});

test("meal tools are annotated: read, update, create, destroy", async () => {
  const t = await connectTestClient([FRAMES]);
  const tools = new Map((await t.client.listTools()).tools.map((x) => [x.name, x]));
  const a = (n: string) => tools.get(n)!.annotations!;
  assert.equal(a("skylight_list_meal_categories").readOnlyHint, true);
  assert.equal(a("skylight_list_meals").readOnlyHint, true);
  assert.deepEqual([a("skylight_plan_meal").destructiveHint, a("skylight_plan_meal").idempotentHint], [false, false]);
  assert.equal(a("skylight_update_meal").idempotentHint, true);
  assert.equal(a("skylight_update_meal_category").idempotentHint, true);
  assert.deepEqual([a("skylight_delete_meal").destructiveHint, a("skylight_delete_meal").idempotentHint], [true, false]);
  assert.match(tools.get("skylight_delete_meal")!.description ?? "", /confirm: true/);
  assert.match(tools.get("skylight_plan_meal")!.description ?? "", /grocery/i);
  await t.close();
});

// ---- Skylight's date_max is EXCLUSIVE (verified live 2026-10-12): an instance is returned only when date_min <= date < date_max.
const inWindow = (url: URL, dates: string[]): string[] => dates.filter((d) => d >= url.searchParams.get("date_min")! && d < url.searchParams.get("date_max")!);
type Sitting = { id: string; attributes: Record<string, unknown> } & Record<string, unknown>;
const exclusiveGet = (all: Sitting[]): MockRoute => ({
  method: "GET", path: `${MEALS}/sittings`,
  handler: ({ url }) => ({ json: { data: all.map((s) => ({ ...s, attributes: { ...s.attributes, instances: inWindow(url, s.attributes.instances as string[]) } })).filter((s) => (s.attributes.instances as string[]).length > 0) } }),
});
const baseSittings = (fixture("meal_sittings") as { data: Sitting[] }).data;
const on = (id: string, title: string, instances: string[], over: Record<string, unknown> = {}): Sitting => ({ ...created(id, { summary: title, instances, ...over }) } as Sitting);

test("date_max is exclusive: list meals sends the day after the inclusive end, so a one-day window returns that day", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, exclusiveGet(baseSittings)]);
  const r = await t.callTool("skylight_list_meals", { after: "2026-10-14", before: "2026-10-14" });
  const q = t.calls.find((c) => c.url.pathname === `${MEALS}/sittings`)!.url.searchParams;
  assert.deepEqual([q.get("date_min"), q.get("date_max")], ["2026-10-14", "2026-10-15"]);
  assert.deepEqual((r.data as Array<{ mealId: string; date: string }>).map((m) => [m.mealId, m.date]), [["1002", "2026-10-14"]]);
  await t.close();
});

test("date_max is exclusive: a window ending on the last day of the year sends January 1st", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, exclusiveGet([on("7", "New Year's Eve", ["2026-12-31"])])]);
  const r = await t.callTool("skylight_list_meals", { after: "2026-12-25", before: "2026-12-31" });
  assert.equal(t.calls.find((c) => c.url.pathname === `${MEALS}/sittings`)!.url.searchParams.get("date_max"), "2027-01-01");
  assert.deepEqual((r.data as Array<{ date: string }>).map((m) => m.date), ["2026-12-31"]);
  await t.close();
});

test("date_max is exclusive: plan meal asks for date..date+1 and so maps the created meal to one row, not none", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: `${MEALS}/sittings`, handler: ({ url, body }) => ({ json: { data: [on("5001", "Taco night", inWindow(url, [(body as { date: string }).date]))] } }) }]);
  const r = await t.callTool("skylight_plan_meal", { date: "2026-10-13", category: "dinner", title: "Taco night" });
  assert.equal(r.isError, false);
  const d = r.data as { created: number; meals: Array<{ mealId: string; date: string }>; warning?: string };
  assert.equal(d.created, 1);
  assert.deepEqual(d.meals.map((m) => [m.mealId, m.date]), [["5001", "2026-10-13"]]);
  assert.equal(d.warning, undefined);
  // across the year boundary
  const y = await t.callTool("skylight_plan_meal", { date: "2026-12-31", category: "dinner", title: "Taco night" });
  assert.equal(writes(t)[1]!.url.searchParams.get("date_max"), "2027-01-01");
  assert.deepEqual((y.data as { meals: Array<{ date: string }> }).meals.map((m) => m.date), ["2026-12-31"]);
  await t.close();
});

test("date_max is exclusive: update and delete find the meal with a date..date+1 lookup, and update re-reads the same way", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, exclusiveGet([on("9", "Eve", ["2026-12-31"])]), { method: "PATCH", path: /sittings/, json: {} }, { method: "DELETE", path: /sittings/, json: {} }]);
  const upd = await t.callTool("skylight_update_meal", { mealId: "9", date: "2026-12-31", note: "x" });
  assert.equal(upd.isError, false, upd.text);
  assert.deepEqual((upd.data as { meals: Array<{ mealId: string }> }).meals.map((m) => m.mealId), ["9"]);
  const patch = writes(t)[0]!;
  assert.deepEqual([patch.url.searchParams.get("date_min"), patch.url.searchParams.get("date_max")], ["2026-12-31", "2027-01-01"]);
  const sittingGets = t.calls.filter((c) => c.method === "GET" && c.url.pathname === `${MEALS}/sittings`);
  assert.equal(sittingGets.length, 2, "one lookup before the PATCH, one re-read after");
  for (const g of sittingGets) assert.deepEqual([g.url.searchParams.get("date_min"), g.url.searchParams.get("date_max")], ["2026-12-31", "2027-01-01"]);
  const preview = await t.callTool("skylight_delete_meal", { mealId: "9", date: "2026-12-31" });
  assert.equal((preview.data as { confirmed: boolean }).confirmed, false);
  const del = await t.callTool("skylight_delete_meal", { mealId: "9", date: "2026-12-31", confirm: true });
  assert.equal(del.isError, false, del.text);
  await t.close();
});
