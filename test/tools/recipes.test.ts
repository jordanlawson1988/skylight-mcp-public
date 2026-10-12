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
const NOW = () => new Date("2026-10-12T15:00:00Z");
const recipesJson = fixture("meal_recipes") as { data: Array<Record<string, unknown>>; included: unknown[] };
const recipe = (id: string, title: string, description: string | null, categoryId = "6859336") => ({ id, type: "meal_recipe", attributes: { summary: title, description, draft: false, image_url: null, source: null }, relationships: { meal_category: { data: { id: categoryId, type: "meal_category" } }, partner: { data: null } } });

test("list recipes returns { id, title, category, ingredientCount } sorted by title", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${MEALS}/recipes`, json: { data: [recipesJson.data[1], recipesJson.data[0]], included: recipesJson.included } }]);
  const r = await t.callTool("skylight_list_recipes");
  assert.deepEqual(r.data, [
    { id: "48148099", title: "Recipe 1", category: { id: "6859334", name: "Breakfast" }, ingredientCount: 2 },
    { id: "48148118", title: "Recipe 2", category: { id: "6859337", name: "Snack" }, ingredientCount: 2 },
  ]);
  assert.equal(t.calls.find((c) => c.url.pathname === `${MEALS}/recipes`)!.url.searchParams.get("include"), "meal_category");
  await t.close();
});

test("list recipes: ingredientCount is null when the description has no Ingredients: section", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${MEALS}/recipes`, json: { data: [recipe("1", "Free text", "Just boil it."), recipe("2", "Empty", null)] } }]);
  const r = await t.callTool("skylight_list_recipes");
  assert.deepEqual((r.data as Array<{ ingredientCount: number | null }>).map((x) => x.ingredientCount), [null, null]);
  await t.close();
});

test("get recipe parses ingredients and instructions from the convention", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: `${MEALS}/recipes/48148099`, json: { data: recipesJson.data[0], included: recipesJson.included } }]);
  const r = await t.callTool("skylight_get_recipe", { recipeId: "48148099" });
  assert.deepEqual(r.data, { id: "48148099", title: "Recipe 1", category: { id: "6859334", name: "Breakfast" }, description: "Ingredients:\n- Item A\n- Item B\n\nInstructions:\n1. Step one.\n", ingredients: ["Item A", "Item B"], instructions: ["Step one."], source: null });
  assert.equal(t.calls.find((c) => c.url.pathname === `${MEALS}/recipes/48148099`)!.url.searchParams.get("include"), "meal_category,partner");
  assert.equal((await t.callTool("skylight_get_recipe", { recipeId: "x/y" })).isError, true);
  await t.close();
});

test("create recipe builds the convention from ingredients and instructions and POSTs with include=meal_category", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: `${MEALS}/recipes`, json: { data: recipe("900", "Tacos", "Ingredients:\n- tortillas\n- cheese\n\nInstructions:\n1. Assemble.\n"), included: [(recipesJson.included as unknown[])[2]] } }]);
  const r = await t.callTool("skylight_create_recipe", { title: " Tacos ", category: "dinner", ingredients: ["tortillas", "cheese"], instructions: ["Assemble."] });
  assert.equal(r.isError, false);
  const [post] = writes(t);
  assert.equal(post!.url.pathname, `${MEALS}/recipes`);
  assert.equal(post!.url.searchParams.get("include"), "meal_category");
  assert.deepEqual(post!.body, { meal_category_id: "6859336", summary: "Tacos", description: "Ingredients:\n- tortillas\n- cheese\n\nInstructions:\n1. Assemble.\n" });
  assert.deepEqual(r.data, { id: "900", title: "Tacos", category: { id: "6859336", name: "Dinner" }, description: "Ingredients:\n- tortillas\n- cheese\n\nInstructions:\n1. Assemble.\n", ingredients: ["tortillas", "cheese"], instructions: ["Assemble."], source: null });
  await t.callTool("skylight_create_recipe", { title: "Soup", category: "6859335", description: "Boil.\nServe." });
  assert.deepEqual(writes(t)[1]!.body, { meal_category_id: "6859335", summary: "Soup", description: "Boil.\nServe." });
  await t.close();
});

test("create recipe validates before any request", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: `${MEALS}/recipes`, json: { data: recipe("1", "x", "d") } }]);
  const base = { title: "x", category: "Dinner" };
  for (const args of [{ ...base }, { ...base, description: "d", ingredients: ["a"] }, { ...base, instructions: ["a"] }, { ...base, ingredients: [] }, { ...base, ingredients: [" "] }, { title: " ", category: "Dinner", description: "d" }, { ...base, description: "d", category: "Brunch" }]) {
    assert.equal((await t.callTool("skylight_create_recipe", args)).isError, true, JSON.stringify(args));
  }
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("update recipe reads the recipe, merges, and PATCHes all three fields", async () => {
  const current = recipe("900", "Tacos", "Ingredients:\n- tortillas\n- cheese\n\nInstructions:\n1. Assemble.\n");
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "GET", path: `${MEALS}/recipes/900`, json: { data: current } }, { method: "PATCH", path: `${MEALS}/recipes/900`, json: { data: recipe("900", "Better tacos", "Ingredients:\n- beef\n\nInstructions:\n1. Assemble.\n") } }]);
  const r = await t.callTool("skylight_update_recipe", { recipeId: "900", title: "Better tacos", ingredients: ["beef"] });
  assert.equal(r.isError, false);
  const [patch] = writes(t);
  assert.equal(patch!.method, "PATCH");
  assert.equal(patch!.url.searchParams.get("include"), "meal_category");
  assert.deepEqual(patch!.body, { meal_category_id: "6859336", summary: "Better tacos", description: "Ingredients:\n- beef\n\nInstructions:\n1. Assemble.\n" });
  assert.equal((r.data as { title: string }).title, "Better tacos");
  // a category change by name is merged too
  await t.callTool("skylight_update_recipe", { recipeId: "900", category: "Snack" });
  assert.deepEqual(writes(t)[1]!.body, { meal_category_id: "6859337", summary: "Tacos", description: current.attributes.description });
  await t.close();
});

test("update recipe refuses to rebuild free text and an empty change, with no PATCH", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "GET", path: `${MEALS}/recipes/901`, json: { data: recipe("901", "Soup", "Just boil it.") } }, { method: "PATCH", path: `${MEALS}/recipes/901`, json: {} }]);
  assert.equal((await t.callTool("skylight_update_recipe", { recipeId: "901", ingredients: ["a"] })).isError, true);
  assert.equal((await t.callTool("skylight_update_recipe", { recipeId: "901" })).isError, true);
  assert.equal((await t.callTool("skylight_update_recipe", { recipeId: "901", description: "d", ingredients: ["a"] })).isError, true);
  assert.equal((await t.callTool("skylight_update_recipe", { recipeId: "bad id", title: "x" })).isError, true);
  assert.equal(writes(t).length, 0);
  const ok = await t.callTool("skylight_update_recipe", { recipeId: "901", description: "Boil it, then serve." });
  assert.equal(ok.isError, false);
  assert.deepEqual(writes(t)[0]!.body, { meal_category_id: "6859336", summary: "Soup", description: "Boil it, then serve." });
  await t.close();
});

const sitting = (id: string, recipeId: string | null, instances: string[]) => ({ id, type: "meal_sitting", attributes: { summary: "Meal", description: null, note: null, rrule: null, draft: false, recurring: instances.length > 1, instances }, relationships: { meal_category: { data: { id: "6859336" } }, meal_recipe: { data: recipeId ? { id: recipeId } : null }, profiles: { data: [] } } });
const DELETE_ROUTES: MockRoute[] = [
  FRAMES, CATEGORIES,
  { method: "GET", path: `${MEALS}/recipes/900`, json: { data: recipe("900", "Tacos", "Ingredients:\n- a\n") } },
  { method: "GET", path: `${MEALS}/sittings`, json: { data: [sitting("1", "900", ["2026-10-13"]), sitting("2", "900", ["2026-10-14", "2026-10-15"]), sitting("3", "777", ["2026-10-13"]), sitting("4", null, ["2026-10-13"])] } },
  { method: "DELETE", path: `${MEALS}/recipes/900`, json: { meta: { deleted_sitting_ids: [1, "2"] } } },
];

test("delete recipe previews the planned meals that use it (next 60 days) and writes nothing", async () => {
  const t = await connectTestClient(DELETE_ROUTES, { now: NOW });
  const keep = await t.callTool("skylight_delete_recipe", { recipeId: "900" });
  const d = keep.data as { confirmed: boolean; wouldDelete: Record<string, unknown>; message: string };
  assert.equal(d.confirmed, false);
  assert.deepEqual(d.wouldDelete, { id: "900", title: "Tacos", plannedMeals: 3, alsoDeletePlannedMeals: false });
  assert.match(d.message, /Nothing was deleted/);
  assert.match(d.message, /3 planned meals/);
  assert.match(d.message, /NOT be deleted/i);
  const q = t.calls.find((c) => c.url.pathname === `${MEALS}/sittings`)!.url.searchParams;
  assert.deepEqual([q.get("date_min"), q.get("date_max")], ["2026-10-12", "2026-12-11"]);
  const also = await t.callTool("skylight_delete_recipe", { recipeId: "900", alsoDeletePlannedMeals: true });
  assert.match((also.data as { message: string }).message, /ALSO be deleted/);
  assert.equal((also.data as { wouldDelete: { alsoDeletePlannedMeals: boolean } }).wouldDelete.alsoDeletePlannedMeals, true);
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("delete recipe with confirm: no query by default, apply_to_sittings=true on request, and the deleted meal ids come back", async () => {
  const t = await connectTestClient(DELETE_ROUTES, { now: NOW });
  const plain = await t.callTool("skylight_delete_recipe", { recipeId: "900", confirm: true });
  assert.deepEqual(plain.data, { deleted: true, id: "900", deletedMealIds: ["1", "2"] });
  const both = await t.callTool("skylight_delete_recipe", { recipeId: "900", alsoDeletePlannedMeals: true, confirm: true });
  assert.equal(both.isError, false);
  assert.deepEqual(writes(t).map((c) => [c.method, c.url.pathname, c.url.search]), [["DELETE", `${MEALS}/recipes/900`, ""], ["DELETE", `${MEALS}/recipes/900`, "?apply_to_sittings=true"]]);
  assert.equal((await t.callTool("skylight_delete_recipe", { recipeId: "a/b", confirm: true })).isError, true);
  await t.close();
});

test("delete recipe still deletes when the meal-plan lookup fails on the preview; the count is then unknown", async () => {
  const routes: MockRoute[] = DELETE_ROUTES.map((r) => (r.method === "GET" && r.path === `${MEALS}/sittings` ? { method: "GET", path: r.path, status: 500, text: "boom" } : r));
  const t = await connectTestClient(routes, { now: NOW });
  const r = await t.callTool("skylight_delete_recipe", { recipeId: "900" });
  assert.equal(r.isError, false);
  assert.equal((r.data as { wouldDelete: { plannedMeals: number | null } }).wouldDelete.plannedMeals, null);
  assert.match((r.data as { message: string }).message, /could not check/i);
  await t.close();
});

test("add recipe to grocery list POSTs { draft: false } and names the default grocery list", async () => {
  const lists = { data: [{ id: "1", attributes: { label: "Chores", default_grocery_list: false } }, { id: "2", attributes: { label: "Groceries", default_grocery_list: true } }] };
  const t = await connectTestClient([FRAMES, { method: "POST", path: `${MEALS}/recipes/900/add_to_grocery_list`, json: { data: recipe("900", "Tacos", null), meta: { auto_creation_intent_id: "abc" } } }, { method: "GET", path: "/api/frames/77/lists", json: lists }]);
  const r = await t.callTool("skylight_add_recipe_to_grocery_list", { recipeId: "900" });
  assert.equal(r.isError, false);
  assert.deepEqual(writes(t).map((c) => [c.method, c.url.pathname, c.body]), [["POST", `${MEALS}/recipes/900/add_to_grocery_list`, { draft: false }]]);
  const d = r.data as { queued: boolean; listName: string; note: string };
  assert.deepEqual([d.queued, d.listName], [true, "Groceries"]);
  assert.match(d.note, /few seconds/);
  await t.close();
});

test("add recipe to grocery list still reports queued when the list lookup fails", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: `${MEALS}/recipes/900/add_to_grocery_list`, json: { data: {}, meta: {} } }, { method: "GET", path: "/api/frames/77/lists", status: 500, text: "boom" }]);
  const r = await t.callTool("skylight_add_recipe_to_grocery_list", { recipeId: "900" });
  assert.equal(r.isError, false);
  assert.deepEqual([(r.data as { queued: boolean }).queued, (r.data as { listName: string | null }).listName], [true, null]);
  assert.equal((await t.callTool("skylight_add_recipe_to_grocery_list", { recipeId: "../1" })).isError, true);
  assert.equal(writes(t).length, 1);
  await t.close();
});

test("recipe tools are annotated: read, create, update, destroy, mutate (twice adds twice)", async () => {
  const t = await connectTestClient([FRAMES]);
  const tools = new Map((await t.client.listTools()).tools.map((x) => [x.name, x]));
  const a = (n: string) => tools.get(n)!.annotations!;
  assert.equal(a("skylight_list_recipes").readOnlyHint, true);
  assert.equal(a("skylight_get_recipe").readOnlyHint, true);
  assert.equal(a("skylight_create_recipe").idempotentHint, false);
  assert.equal(a("skylight_update_recipe").idempotentHint, true);
  assert.deepEqual([a("skylight_delete_recipe").destructiveHint, a("skylight_delete_recipe").idempotentHint], [true, false]);
  assert.match(tools.get("skylight_delete_recipe")!.description ?? "", /confirm: true/);
  assert.deepEqual([a("skylight_add_recipe_to_grocery_list").destructiveHint, a("skylight_add_recipe_to_grocery_list").idempotentHint], [true, false]);
  assert.match(tools.get("skylight_add_recipe_to_grocery_list")!.description ?? "", /twice/);
  await t.close();
});
