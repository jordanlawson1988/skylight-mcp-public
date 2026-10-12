import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMealCategoryUpdateBody, buildMealCreateBody, buildMealUpdateBody, buildRecipeDescription, buildRecipeUpdateBody, prepareMealCreate, prepareRecipeCreate } from "../../src/skylight/meal-payload.js";
import { parseRecipeDescription } from "../../src/skylight/types.js";
import { ValidationError } from "../../src/skylight/errors.js";

const bad = (fn: () => unknown, field: string) => assert.throws(fn, (e: unknown) => e instanceof ValidationError && e.field === field, field);

test("buildMealCreateBody: a titled one-time meal sends exactly the verified fields", () => {
  assert.deepEqual(buildMealCreateBody({ date: "2026-10-13", title: "  Taco night " }, "6859336"), { meal_category_id: "6859336", add_to_grocery_list: false, summary: "Taco night", date: "2026-10-13" });
});

test("buildMealCreateBody: a recipe meal sends meal_recipe_id and no summary; note and description pass through", () => {
  assert.deepEqual(buildMealCreateBody({ date: "2026-10-13", recipeId: "48148099", note: "Use the big pot", description: "Ingredients:\r\n- a", addToGroceryList: true }, "6859336"), {
    meal_category_id: "6859336", meal_recipe_id: "48148099", add_to_grocery_list: true, date: "2026-10-13", note: "Use the big pot", description: "Ingredients:\n- a",
  });
});

test("buildMealCreateBody: recurrence goes through buildRrule and loses its RRULE: prefix", () => {
  assert.equal(buildMealCreateBody({ date: "2026-10-13", title: "x", recurrence: { frequency: "daily" } }, "1").rrule, "FREQ=DAILY");
  assert.equal(buildMealCreateBody({ date: "2026-10-13", title: "x", recurrence: { frequency: "weekly", weekdays: ["MO", "WE"], interval: 2, until: "2026-12-31" } }, "1").rrule, "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231");
  bad(() => buildMealCreateBody({ date: "2026-10-13", title: "x", recurrence: { frequency: "daily", hour: 6 } }, "1"), "recurrence.hour");
  bad(() => buildMealCreateBody({ date: "2026-10-13", title: "x", recurrence: { frequency: "daily", weekdays: ["MO"] } }, "1"), "recurrence.weekdays");
});

test("buildMealCreateBody: exactly one of recipeId and title; dates, ids and text are validated", () => {
  bad(() => buildMealCreateBody({ date: "2026-10-13" }, "1"), "title");
  bad(() => buildMealCreateBody({ date: "2026-10-13", title: "x", recipeId: "5" }, "title"), "title");
  bad(() => buildMealCreateBody({ date: "2026-02-30", title: "x" }, "1"), "date");
  bad(() => buildMealCreateBody({ date: "2026-10-13", title: "   " }, "1"), "title");
  bad(() => buildMealCreateBody({ date: "2026-10-13", title: "x".repeat(201) }, "1"), "title");
  bad(() => buildMealCreateBody({ date: "2026-10-13", recipeId: "../5" }, "1"), "recipeId");
  bad(() => buildMealCreateBody({ date: "2026-10-13", title: "x", note: "x".repeat(501) }, "1"), "note");
  bad(() => buildMealCreateBody({ date: "2026-10-13", title: "x", description: "x".repeat(5001) }, "1"), "description");
  bad(() => buildMealCreateBody({ date: "2026-10-13", title: "x", addToGroceryList: true }, "1"), "addToGroceryList");
});

test("prepareMealCreate validates up front and finishes once the category is known", () => {
  assert.throws(() => prepareMealCreate({ date: "nope", title: "x" }), ValidationError);
  const finish = prepareMealCreate({ date: "2026-10-13", title: "x" });
  assert.equal(finish("10").meal_category_id, "10");
  assert.equal(finish("11").meal_category_id, "11");
  bad(() => finish("../1"), "category");
});

test("buildMealUpdateBody sends only the provided fields", () => {
  assert.deepEqual(buildMealUpdateBody({ title: " New " }), { summary: "New" });
  assert.deepEqual(buildMealUpdateBody({ note: "n", description: "d", recipeId: "5" }, "6859336"), { note: "n", description: "d", meal_recipe_id: "5", meal_category_id: "6859336" });
  assert.deepEqual(buildMealUpdateBody({}, "6859336"), { meal_category_id: "6859336" });
  bad(() => buildMealUpdateBody({}), "update");
  bad(() => buildMealUpdateBody({ title: "" }), "title");
  bad(() => buildMealUpdateBody({ recipeId: "x y" }), "recipeId");
});

test("buildMealCategoryUpdateBody maps name to label, upper-cases the color and needs a change", () => {
  assert.deepEqual(buildMealCategoryUpdateBody({ name: " Brunch ", color: "#a8d4d3", enabled: false }), { label: "Brunch", color: "#A8D4D3", enabled: false });
  assert.deepEqual(buildMealCategoryUpdateBody({ enabled: true }), { enabled: true });
  bad(() => buildMealCategoryUpdateBody({}), "update");
  bad(() => buildMealCategoryUpdateBody({ color: "red" }), "color");
  bad(() => buildMealCategoryUpdateBody({ name: "" }), "name");
});

test("buildRecipeDescription writes the app's convention and parses back to the same lists", () => {
  assert.equal(buildRecipeDescription(["a", "b"], ["x", "y"]), "Ingredients:\n- a\n- b\n\nInstructions:\n1. x\n2. y\n");
  assert.equal(buildRecipeDescription(["a"], null), "Ingredients:\n- a\n");
  assert.equal(buildRecipeDescription(["zzsmoke a", "zzsmoke b"], []), "Ingredients:\n- zzsmoke a\n- zzsmoke b\n");
  const text = buildRecipeDescription(["2 eggs", "1 cup flour"], ["Mix", "Bake"]);
  assert.deepEqual(parseRecipeDescription(text), { ingredients: ["2 eggs", "1 cup flour"], instructions: ["Mix", "Bake"] });
});

test("prepareRecipeCreate: ingredients and instructions build the convention; a raw description is kept", () => {
  assert.deepEqual(prepareRecipeCreate({ title: " Tacos ", ingredients: [" tortillas ", "cheese"], instructions: ["Assemble."] })("6859336"), {
    meal_category_id: "6859336", summary: "Tacos", description: "Ingredients:\n- tortillas\n- cheese\n\nInstructions:\n1. Assemble.\n",
  });
  assert.deepEqual(prepareRecipeCreate({ title: "Soup", description: "Boil it.\nServe." })("1"), { meal_category_id: "1", summary: "Soup", description: "Boil it.\nServe." });
});

test("prepareRecipeCreate validation: a description or ingredients, not both; instructions need ingredients; bounds", () => {
  bad(() => prepareRecipeCreate({ title: "x" }), "description");
  bad(() => prepareRecipeCreate({ title: "x", description: "d", ingredients: ["a"] }), "description");
  bad(() => prepareRecipeCreate({ title: "x", description: "d", instructions: ["a"] }), "description");
  bad(() => prepareRecipeCreate({ title: "x", instructions: ["a"] }), "ingredients");
  bad(() => prepareRecipeCreate({ title: "x", ingredients: [] }), "ingredients");
  bad(() => prepareRecipeCreate({ title: "x", ingredients: ["a", " "] }), "ingredients");
  bad(() => prepareRecipeCreate({ title: "x", ingredients: ["a\nb"] }), "ingredients");
  bad(() => prepareRecipeCreate({ title: "x", ingredients: Array.from({ length: 101 }, () => "a") }), "ingredients");
  bad(() => prepareRecipeCreate({ title: "x", ingredients: ["a"], instructions: ["a".repeat(1001)] }), "instructions");
  bad(() => prepareRecipeCreate({ title: " " , description: "d" }), "title");
});

test("buildRecipeUpdateBody merges the recipe as it is now: all three fields are always sent", () => {
  const existing = { title: "Tacos", categoryId: "6859336", description: "Ingredients:\n- tortillas\n- cheese\n\nInstructions:\n1. Assemble.\n" };
  assert.deepEqual(buildRecipeUpdateBody(existing, { title: "Better tacos" }), { meal_category_id: "6859336", summary: "Better tacos", description: existing.description });
  assert.deepEqual(buildRecipeUpdateBody(existing, {}, "6859337"), { meal_category_id: "6859337", summary: "Tacos", description: existing.description });
  // new ingredients keep the existing instructions, and vice versa
  assert.equal(buildRecipeUpdateBody(existing, { ingredients: ["beef"] }).description, "Ingredients:\n- beef\n\nInstructions:\n1. Assemble.\n");
  assert.equal(buildRecipeUpdateBody(existing, { instructions: ["Fry.", "Serve."] }).description, "Ingredients:\n- tortillas\n- cheese\n\nInstructions:\n1. Fry.\n2. Serve.\n");
  assert.equal(buildRecipeUpdateBody(existing, { description: "Free text" }).description, "Free text");
});

test("buildRecipeUpdateBody refuses edits that would destroy free text, or change nothing", () => {
  const free = { title: "Soup", categoryId: "1", description: "Just boil it." };
  bad(() => buildRecipeUpdateBody(free, { ingredients: ["a"] }), "ingredients");
  assert.equal(buildRecipeUpdateBody(free, { title: "Soup 2" }).description, "Just boil it.");
  assert.equal(buildRecipeUpdateBody(free, { description: "Ingredients:\n- a" }).description, "Ingredients:\n- a");
  const blank = { title: "Soup", categoryId: "1", description: null };
  assert.equal(buildRecipeUpdateBody(blank, { ingredients: ["a"] }).description, "Ingredients:\n- a\n");
  bad(() => buildRecipeUpdateBody(blank, { instructions: ["x"] }), "ingredients");
  assert.equal(buildRecipeUpdateBody(blank, { title: "S" }).description, null);
  bad(() => buildRecipeUpdateBody({ title: "Soup", categoryId: null, description: "d" }, { title: "S" }), "category");
  bad(() => buildRecipeUpdateBody(free, {}), "update");
  bad(() => buildRecipeUpdateBody(free, { description: "d", ingredients: ["a"] }), "description");
});
