import { ValidationError } from "./errors.js";
import { assertDate, assertHexColor, assertNumericId, cleanParagraph, cleanText } from "./ids.js";
import { buildRrule, stripRrulePrefix, type Recurrence } from "./rrule.js";
import { parseRecipeDescription } from "./types.js";
import { RECIPE_HEADINGS } from "./vocab.js";

export const MAX_MEAL_TITLE_LENGTH = 200;
export const MAX_MEAL_NOTE_LENGTH = 500;
export const MAX_MEAL_DESCRIPTION_LENGTH = 5000;
export const MAX_MEAL_CATEGORY_NAME_LENGTH = 40;
export const MAX_RECIPE_TITLE_LENGTH = 200;
export const MAX_INGREDIENTS = 100;
export const MAX_INGREDIENT_LENGTH = 200;
export const MAX_INSTRUCTIONS = 100;
export const MAX_INSTRUCTION_LENGTH = 1000;

// ---- Meal plan ("sittings")

export interface MealPlanInput {
  date: string;
  recipeId?: string | undefined;
  title?: string | undefined;
  note?: string | undefined;
  description?: string | undefined;
  recurrence?: Recurrence | undefined;
  addToGroceryList?: boolean | undefined;
}

export interface MealCreateBody {
  meal_category_id: string;
  meal_recipe_id?: string;
  add_to_grocery_list: boolean;
  summary?: string;
  date: string;
  note?: string;
  description?: string;
  rrule?: string;
}

/** The meal repeat rule: buildRrule without an hour, then without its RRULE: prefix (the verified stored form). */
function mealRrule(recurrence: Recurrence): string {
  if (recurrence.hour !== undefined) throw new ValidationError("recurrence.hour", "is only for routine steps");
  return stripRrulePrefix(buildRrule(recurrence));
}

/**
 * Validates everything except the category (which usually needs a lookup by name) and returns a function that adds it.
 * Invalid input throws here, before any request.
 */
export function prepareMealCreate(input: MealPlanInput): (categoryId: string) => MealCreateBody {
  const date = assertDate(input.date, "date");
  if (input.recipeId !== undefined && input.title !== undefined) throw new ValidationError("title", "give either recipeId or title, not both");
  if (input.recipeId === undefined && input.title === undefined) throw new ValidationError("title", "is required when no recipeId is given");
  const recipeId = input.recipeId === undefined ? undefined : assertNumericId(input.recipeId, "recipeId");
  const summary = input.title === undefined ? undefined : cleanText(input.title, "title", MAX_MEAL_TITLE_LENGTH);
  if (input.addToGroceryList === true && recipeId === undefined) throw new ValidationError("addToGroceryList", "needs a recipeId: it adds the recipe's ingredients");
  const note = input.note === undefined ? undefined : cleanParagraph(input.note, "note", MAX_MEAL_NOTE_LENGTH);
  const description = input.description === undefined ? undefined : cleanParagraph(input.description, "description", MAX_MEAL_DESCRIPTION_LENGTH);
  const rrule = input.recurrence === undefined ? undefined : mealRrule(input.recurrence);
  const addToGroceryList = input.addToGroceryList ?? false;
  return (categoryId) => ({
    meal_category_id: assertNumericId(categoryId, "category"),
    ...(recipeId !== undefined ? { meal_recipe_id: recipeId } : {}),
    add_to_grocery_list: addToGroceryList,
    ...(summary !== undefined ? { summary } : {}),
    date,
    ...(note !== undefined ? { note } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(rrule !== undefined ? { rrule } : {}),
  });
}

export function buildMealCreateBody(input: MealPlanInput, categoryId: string): MealCreateBody {
  return prepareMealCreate(input)(categoryId);
}

export interface MealUpdateInput { title?: string | undefined; note?: string | undefined; description?: string | undefined; recipeId?: string | undefined }
export interface MealUpdateBody { summary?: string; note?: string; description?: string; meal_category_id?: string; meal_recipe_id?: string }

/** Only the provided fields; the category (if any) is resolved by the caller and passed in. */
export function buildMealUpdateBody(input: MealUpdateInput, categoryId?: string): MealUpdateBody {
  const out: MealUpdateBody = {};
  if (input.title !== undefined) out.summary = cleanText(input.title, "title", MAX_MEAL_TITLE_LENGTH);
  if (input.note !== undefined) out.note = cleanParagraph(input.note, "note", MAX_MEAL_NOTE_LENGTH);
  if (input.description !== undefined) out.description = cleanParagraph(input.description, "description", MAX_MEAL_DESCRIPTION_LENGTH);
  if (categoryId !== undefined) out.meal_category_id = assertNumericId(categoryId, "category");
  if (input.recipeId !== undefined) out.meal_recipe_id = assertNumericId(input.recipeId, "recipeId");
  if (Object.keys(out).length === 0) throw new ValidationError("update", "provide at least one of title, note, description, category or recipeId");
  return out;
}

export interface MealCategoryUpdateInput { name?: string | undefined; color?: string | undefined; enabled?: boolean | undefined }
export interface MealCategoryUpdateBody { label?: string; color?: string; enabled?: boolean }

export function buildMealCategoryUpdateBody(input: MealCategoryUpdateInput): MealCategoryUpdateBody {
  const out: MealCategoryUpdateBody = {};
  if (input.name !== undefined) out.label = cleanText(input.name, "name", MAX_MEAL_CATEGORY_NAME_LENGTH);
  if (input.color !== undefined) out.color = assertHexColor(input.color, "color");
  if (input.enabled !== undefined) out.enabled = input.enabled;
  if (Object.keys(out).length === 0) throw new ValidationError("update", "provide at least one of name, color or enabled");
  return out;
}

// ---- Recipes

export interface RecipeBody { meal_category_id: string; summary: string; description: string | null }

function cleanLines(values: readonly string[], field: string, maxCount: number, maxLength: number): string[] {
  if (!Array.isArray(values) || values.length > maxCount) throw new ValidationError(field, `must list at most ${maxCount} lines`);
  return values.map((v) => cleanText(v, field, maxLength));
}

/** The app's description layout: "Ingredients:\n- a\n- b\n\nInstructions:\n1. x\n2. y\n". A null list leaves its section out. */
export function buildRecipeDescription(ingredients: readonly string[] | null, instructions: readonly string[] | null): string {
  const sections: string[] = [];
  if (ingredients !== null) sections.push(`${RECIPE_HEADINGS.ingredients}\n${ingredients.map((i) => `- ${i}\n`).join("")}`);
  if (instructions !== null && instructions.length > 0) sections.push(`${RECIPE_HEADINGS.instructions}\n${instructions.map((s, i) => `${i + 1}. ${s}\n`).join("")}`);
  return sections.join("\n");
}

export interface RecipeCreateInput {
  title: string;
  description?: string | undefined;
  ingredients?: string[] | undefined;
  instructions?: string[] | undefined;
}

function requireIngredients(ingredients: string[]): string[] {
  if (ingredients.length === 0) throw new ValidationError("ingredients", "must list at least one ingredient");
  return cleanLines(ingredients, "ingredients", MAX_INGREDIENTS, MAX_INGREDIENT_LENGTH);
}

/** Validates the recipe and returns a function that adds the (resolved) category. */
export function prepareRecipeCreate(input: RecipeCreateInput): (categoryId: string) => RecipeBody {
  const summary = cleanText(input.title, "title", MAX_RECIPE_TITLE_LENGTH);
  let description: string;
  if (input.description !== undefined) {
    if (input.ingredients !== undefined || input.instructions !== undefined) throw new ValidationError("description", "cannot be combined with ingredients or instructions");
    description = cleanParagraph(input.description, "description", MAX_MEAL_DESCRIPTION_LENGTH);
  } else if (input.ingredients !== undefined) {
    const ingredients = requireIngredients(input.ingredients);
    const instructions = input.instructions === undefined ? null : cleanLines(input.instructions, "instructions", MAX_INSTRUCTIONS, MAX_INSTRUCTION_LENGTH);
    description = buildRecipeDescription(ingredients, instructions);
  } else if (input.instructions !== undefined) {
    throw new ValidationError("ingredients", "is required together with instructions");
  } else {
    throw new ValidationError("description", "give a description, or ingredients (with optional instructions)");
  }
  return (categoryId) => ({ meal_category_id: assertNumericId(categoryId, "category"), summary, description });
}

export interface RecipeUpdateInput {
  title?: string | undefined;
  description?: string | undefined;
  ingredients?: string[] | undefined;
  instructions?: string[] | undefined;
}

/**
 * Skylight's PATCH wants title, category and description every time, so the recipe as it is now (`existing`) is merged with the changes.
 * New ingredients keep the existing instructions and the other way round; a description that is free text (no Ingredients:/Instructions:
 * sections) is never rebuilt, because that would silently drop it.
 */
export function buildRecipeUpdateBody(existing: { title: string; categoryId: string | null; description: string | null }, input: RecipeUpdateInput, categoryId?: string): RecipeBody {
  const lists = input.ingredients !== undefined || input.instructions !== undefined;
  if (input.description !== undefined && lists) throw new ValidationError("description", "cannot be combined with ingredients or instructions");
  if (input.title === undefined && input.description === undefined && !lists && categoryId === undefined) throw new ValidationError("update", "provide at least one of title, category, description, ingredients or instructions");
  const category = categoryId ?? existing.categoryId;
  if (category === null) throw new ValidationError("category", "the recipe has no category yet; pass category");
  let description: string | null = existing.description;
  if (input.description !== undefined) {
    description = cleanParagraph(input.description, "description", MAX_MEAL_DESCRIPTION_LENGTH);
  } else if (lists) {
    const current = parseRecipeDescription(existing.description);
    if (existing.description !== null && existing.description.trim() !== "" && current.ingredients === null && current.instructions === null) {
      throw new ValidationError("ingredients", "the recipe's description is free text, not an Ingredients:/Instructions: layout; pass description to replace it");
    }
    const ingredients = input.ingredients !== undefined ? requireIngredients(input.ingredients) : current.ingredients;
    const instructions = input.instructions !== undefined ? cleanLines(input.instructions, "instructions", MAX_INSTRUCTIONS, MAX_INSTRUCTION_LENGTH) : current.instructions;
    if (ingredients === null) throw new ValidationError("ingredients", "the recipe has no ingredients list yet; pass ingredients together with instructions");
    description = buildRecipeDescription(ingredients, instructions);
  }
  return {
    meal_category_id: assertNumericId(category, "category"),
    summary: input.title === undefined ? cleanText(existing.title, "title", MAX_RECIPE_TITLE_LENGTH) : cleanText(input.title, "title", MAX_RECIPE_TITLE_LENGTH),
    description,
  };
}
