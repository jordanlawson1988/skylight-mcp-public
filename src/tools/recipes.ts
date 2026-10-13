import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SkylightApiError, ValidationError } from "../skylight/errors.js";
import { assertNumericId } from "../skylight/ids.js";
import { buildRecipeUpdateBody, MAX_INGREDIENT_LENGTH, MAX_INGREDIENTS, MAX_INSTRUCTION_LENGTH, MAX_INSTRUCTIONS, MAX_MEAL_DESCRIPTION_LENGTH, MAX_RECIPE_TITLE_LENGTH, prepareRecipeCreate } from "../skylight/meal-payload.js";
import { explodeSittings, mapDefaultGroceryList, mapRecipeResponse, mapRecipes, type MealCategory, type Recipe } from "../skylight/types.js";
import { addDays, todayIn } from "../skylight/time.js";
import type { ToolContext } from "./context.js";
import { listMealCategories, MEALS_PATH, readSittings, resolveMealCategory } from "./meals.js";
import { ANNOTATIONS, run } from "./result.js";

/** How far ahead the recipe delete preview counts planned meals that use the recipe. */
export const RECIPE_LOOKAHEAD_DAYS = 60;

const recipesPath = (frameId: string) => `${MEALS_PATH(frameId)}/recipes`;
const LIST_INCLUDE = "meal_category";
const GET_INCLUDE = "meal_category,partner";

const category = (r: Recipe, categories?: readonly MealCategory[]): { id: string; name: string | null } | null =>
  r.categoryId === null ? null : { id: r.categoryId, name: r.categoryName ?? categories?.find((c) => c.id === r.categoryId)?.name ?? null };

/** A recipe for display: the parsed lists, no internal fields. */
function present(r: Recipe, categories?: readonly MealCategory[]) {
  return { id: r.id, title: r.title, category: category(r, categories), description: r.description, ingredients: r.ingredients, instructions: r.instructions, source: r.source };
}

async function getRecipe(ctx: ToolContext, frameId: string, id: string): Promise<Recipe> {
  const recipe = mapRecipeResponse(await ctx.client.request({ method: "GET", path: `${recipesPath(frameId)}/${id}`, query: { include: GET_INCLUDE } }));
  if (!recipe) throw new ValidationError("recipeId", "Skylight returned no recipe with that id");
  return recipe;
}

const recipeIdSchema = z.string().describe("Recipe id from skylight_list_recipes.");
const categorySchema = z.string().describe("Meal slot for the recipe: category id, or its name such as \"Dinner\" (case does not matter).");
const textShape = {
  description: z.string().optional().describe(`The full recipe text, up to ${MAX_MEAL_DESCRIPTION_LENGTH} characters. The Skylight app uses "Ingredients:" then "- item" lines, a blank line, "Instructions:" then "1. step" lines. Use this OR ingredients/instructions.`),
  ingredients: z.array(z.string()).min(1).max(MAX_INGREDIENTS).optional().describe(`Ingredient lines, up to ${MAX_INGREDIENT_LENGTH} characters each; written in the app's layout for you.`),
  instructions: z.array(z.string()).min(1).max(MAX_INSTRUCTIONS).optional().describe(`Steps in order, up to ${MAX_INSTRUCTION_LENGTH} characters each (needs ingredients); numbered for you.`),
};

export function registerRecipeTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "skylight_list_recipes",
    {
      title: "List recipes",
      description: "List the family's recipes as { id, title, category: { id, name }, ingredientCount }, sorted by title. ingredientCount counts the \"- \" lines under \"Ingredients:\" and is null when the description has no such section. Use skylight_get_recipe for the full recipe.",
      inputSchema: {},
      annotations: ANNOTATIONS.read,
    },
    () => run(async () => {
      const frameId = await ctx.frames.resolve();
      const recipes = mapRecipes(await ctx.client.request({ method: "GET", path: recipesPath(frameId), query: { include: LIST_INCLUDE } }));
      const key = (r: Recipe) => r.title.toLowerCase();
      return recipes.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
        .map((r) => ({ id: r.id, title: r.title, category: category(r), ingredientCount: r.ingredients === null ? null : r.ingredients.length }));
    })
  );

  server.registerTool(
    "skylight_get_recipe",
    {
      title: "Get a recipe",
      description: "One recipe as { id, title, category, description, ingredients, instructions, source }. ingredients and instructions are parsed from the app's layout (\"Ingredients:\" / \"Instructions:\" sections) and are null when the description has no such section.",
      inputSchema: { recipeId: recipeIdSchema },
      annotations: ANNOTATIONS.read,
    },
    (args) => run(async () => {
      const id = assertNumericId(args.recipeId, "recipeId");
      return present(await getRecipe(ctx, await ctx.frames.resolve(), id));
    })
  );

  server.registerTool(
    "skylight_create_recipe",
    {
      title: "Create a recipe",
      description: "Create a recipe in a meal slot. Give either description (free text) or ingredients (with optional instructions), which are written in the layout the Skylight app uses so the app can add the ingredients to a grocery list. Not idempotent: repeating the call creates a second recipe.",
      inputSchema: { title: z.string().describe(`Recipe name, up to ${MAX_RECIPE_TITLE_LENGTH} characters.`), category: categorySchema, ...textShape },
      annotations: ANNOTATIONS.create,
    },
    (args) => run(async () => {
      const { category: wanted, ...rest } = args;
      const finish = prepareRecipeCreate(rest);
      const frameId = await ctx.frames.resolve();
      const categories = await listMealCategories(ctx, frameId);
      const slot = await resolveMealCategory(ctx, frameId, wanted, categories);
      const json = await ctx.client.request<unknown>({ method: "POST", path: recipesPath(frameId), query: { include: LIST_INCLUDE }, body: finish(slot.id) });
      const created = mapRecipeResponse(json);
      return created ? present(created, categories) : { created: true, warning: "Skylight returned no recipe id; call skylight_list_recipes to confirm." };
    })
  );

  server.registerTool(
    "skylight_update_recipe",
    {
      title: "Update a recipe",
      description: "Change a recipe's title, category, description, ingredients or instructions. Only the provided fields change: the recipe is read first and merged, because Skylight needs title, category and description every time. New ingredients keep the existing instructions and the other way round. A recipe whose description is free text (no Ingredients:/Instructions: layout) cannot be edited through ingredients or instructions; pass description to replace it.",
      inputSchema: {
        recipeId: recipeIdSchema,
        title: z.string().optional().describe(`New name, up to ${MAX_RECIPE_TITLE_LENGTH} characters.`),
        category: categorySchema.optional(),
        ...textShape,
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const { recipeId, category: wanted, ...changes } = args;
      const id = assertNumericId(recipeId, "recipeId");
      const frameId = await ctx.frames.resolve();
      const existing = await getRecipe(ctx, frameId, id);
      const categories = await listMealCategories(ctx, frameId);
      const slot = wanted === undefined ? undefined : await resolveMealCategory(ctx, frameId, wanted, categories);
      const body = buildRecipeUpdateBody(existing, changes, slot?.id);
      const json = await ctx.client.request<unknown>({ method: "PATCH", path: `${recipesPath(frameId)}/${id}`, query: { include: LIST_INCLUDE }, body });
      const updated = mapRecipeResponse(json);
      return updated ? present(updated, categories) : { id, updated: true };
    })
  );

  server.registerTool(
    "skylight_delete_recipe",
    {
      title: "Delete a recipe",
      description: `Delete a recipe. Meals already planned with it stay on the meal plan unless alsoDeletePlannedMeals: true, which deletes them too (default false). Without confirm: true this makes NO change and returns the recipe's title and how many planned meals in the next ${RECIPE_LOOKAHEAD_DAYS} days use it. Show that to the user and only call again with confirm: true after they agree.`,
      inputSchema: {
        recipeId: recipeIdSchema,
        alsoDeletePlannedMeals: z.boolean().optional().describe("true also deletes every planned meal that uses this recipe. Default false."),
        confirm: z.boolean().optional().describe("Must be true to actually delete. Ask the user first."),
      },
      annotations: ANNOTATIONS.destroy,
    },
    (args) => run(async () => {
      const id = assertNumericId(args.recipeId, "recipeId");
      const also = args.alsoDeletePlannedMeals === true;
      const frameId = await ctx.frames.resolve();
      if (args.confirm !== true) {
        const recipe = await getRecipe(ctx, frameId, id);
        const after = todayIn(ctx.config.timezone, ctx.now());
        const before = addDays(after, RECIPE_LOOKAHEAD_DAYS);
        let uses: { meals: number; dates: number } | null = null;
        try {
          const rows = explodeSittings(await readSittings(ctx, frameId, after, before), [], { after, before }).filter((r) => r.recipeId === id);
          uses = { meals: new Set(rows.map((r) => r.mealId)).size, dates: rows.length };
        } catch (e) { if (!(e instanceof SkylightApiError)) throw e; }
        const further = " The count covers only the next " + RECIPE_LOOKAHEAD_DAYS + " days: meals planned further out with this recipe would ALSO be deleted.";
        let meals: string;
        if (uses === null) {
          meals = `Could not check which planned meals use it${also ? `, and they would ALSO be deleted, including any planned more than ${RECIPE_LOOKAHEAD_DAYS} days out` : ""}.`;
        } else {
          const one = uses.meals === 1;
          meals = `${uses.meals} meal${one ? "" : "s"} (${uses.dates} date${uses.dates === 1 ? "" : "s"}) planned in the next ${RECIPE_LOOKAHEAD_DAYS} days ${one ? "uses" : "use"} it, and ${one ? "it" : "they"} would ${also ? "ALSO" : "NOT"} be deleted.${also ? further : ""}`;
        }
        return {
          confirmed: false,
          wouldDelete: { id, title: recipe.title, plannedMeals: uses?.meals ?? null, plannedDates: uses?.dates ?? null, alsoDeletePlannedMeals: also },
          message: `Nothing was deleted. This would delete the recipe "${recipe.title}". ${meals} Ask the user to confirm, then call again with confirm: true.`,
        };
      }
      const json = await ctx.client.request<{ meta?: { deleted_sitting_ids?: unknown } } | null>({ method: "DELETE", path: `${recipesPath(frameId)}/${id}`, query: also ? { apply_to_sittings: true } : {} });
      const ids = json?.meta?.deleted_sitting_ids;
      return { deleted: true, id, deletedMealIds: Array.isArray(ids) ? ids.map(String) : [] };
    })
  );

  server.registerTool(
    "skylight_add_recipe_to_grocery_list",
    {
      title: "Add a recipe's ingredients to the grocery list",
      description: "Ask Skylight to add the recipe's ingredients to the family's default grocery list. Skylight reads the ingredients out of the recipe and adds them a few seconds later, so the items are not there yet when this returns. Not idempotent: calling it twice adds the ingredients twice.",
      inputSchema: { recipeId: recipeIdSchema },
      annotations: ANNOTATIONS.mutate,
    },
    (args) => run(async () => {
      const id = assertNumericId(args.recipeId, "recipeId");
      const frameId = await ctx.frames.resolve();
      await ctx.client.request({ method: "POST", path: `${recipesPath(frameId)}/${id}/add_to_grocery_list`, body: { draft: false } });
      let listName: string | null = null;
      try { listName = mapDefaultGroceryList(await ctx.client.request({ method: "GET", path: `/api/frames/${frameId}/lists` }))?.title ?? null; }
      catch (e) { if (!(e instanceof SkylightApiError)) throw e; }
      return { queued: true, recipeId: id, listName, note: "Skylight adds the ingredients within a few seconds. Calling this again adds them again." };
    })
  );
}
