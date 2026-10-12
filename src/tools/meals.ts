import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SkylightApiError, ValidationError } from "../skylight/errors.js";
import { assertDate, assertNumericId } from "../skylight/ids.js";
import { buildMealCategoryUpdateBody, MAX_MEAL_CATEGORY_NAME_LENGTH, MAX_MEAL_DESCRIPTION_LENGTH, MAX_MEAL_NOTE_LENGTH, MAX_MEAL_TITLE_LENGTH, prepareMealCreate, prepareMealUpdate, type MealPlanInput } from "../skylight/meal-payload.js";
import { explodeSittings, mapMealCategories, mapMealCategory, mapSitting, mapSittings, type MealCategory, type MealSitting } from "../skylight/types.js";
import { addDays, exclusiveDateMax, formatHuman, todayIn } from "../skylight/time.js";
import { EXPOSED_MEAL_APPLY_TO_VALUES, MEAL_SCOPE_TEXT, type MealScope } from "../skylight/vocab.js";
import type { ToolContext } from "./context.js";
import { recurrenceShape } from "./chores.js";
import { ANNOTATIONS, run } from "./result.js";

/** Longest window skylight_list_meals returns, in days between after and before. */
export const MAX_MEAL_SPAN_DAYS = 62;

export const MEALS_PATH = (frameId: string): string => `/api/frames/${frameId}/meals`;
const sittingsPath = (frameId: string) => `${MEALS_PATH(frameId)}/sittings`;
/** The include the app sends on every sitting request. */
const SITTING_INCLUDE = "meal_category,meal_recipe";
const dataOf = (json: unknown): unknown => (json as { data?: unknown } | null)?.data;

export async function listMealCategories(ctx: ToolContext, frameId: string): Promise<MealCategory[]> {
  return mapMealCategories(await ctx.client.request({ method: "GET", path: `${MEALS_PATH(frameId)}/categories` })).sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
}

/** A category by id, else by name ignoring case. Unknown values fail with the list of names. */
export async function resolveMealCategory(ctx: ToolContext, frameId: string, value: string, categories?: MealCategory[]): Promise<MealCategory> {
  const wanted = value.trim();
  const all = categories ?? (await listMealCategories(ctx, frameId));
  const hit = all.find((c) => c.id === wanted) ?? all.find((c) => c.name.toLowerCase() === wanted.toLowerCase());
  if (!hit) throw new ValidationError("category", `no meal category "${wanted}"; use one of: ${all.map((c) => c.name).join(", ") || "(none found)"}`);
  return hit;
}

/** Meal-plan rows (sittings) with at least one date in after..before, both inclusive (Skylight's own date_max is exclusive; exclusiveDateMax converts). */
export async function readSittings(ctx: ToolContext, frameId: string, after: string, before: string): Promise<MealSitting[]> {
  return mapSittings(await ctx.client.request({ method: "GET", path: sittingsPath(frameId), query: { date_min: after, date_max: exclusiveDateMax(before), include: SITTING_INCLUDE } }));
}

/** `{ data: [sitting...] }` or `{ data: sitting }`. */
function sittingsFrom(json: unknown): MealSitting[] {
  const many = mapSittings(json);
  if (many.length > 0) return many;
  const one = mapSitting(dataOf(json));
  return one ? [one] : [];
}

/** The meal-plan row `mealId` and the date it is planned on, or a ValidationError that says what to do. */
async function findMeal(ctx: ToolContext, frameId: string, mealId: string, date: string): Promise<MealSitting> {
  const sitting = (await readSittings(ctx, frameId, date, date)).find((s) => s.id === mealId);
  if (!sitting) throw new ValidationError("mealId", `no meal ${mealId} is planned on ${date}; use skylight_list_meals for the mealId and date of each planned meal`);
  if (!sitting.instances.includes(date)) throw new ValidationError("date", `meal ${mealId} is not planned on ${date}; its dates are ${sitting.instances.join(", ") || "(none)"}`);
  return sitting;
}

/** A repeating meal needs a scope; a one-time meal must not have one (Skylight answers 422 "must not provide apply_to"). */
function checkScope(sitting: MealSitting, applyTo: string | undefined): void {
  const choices = EXPOSED_MEAL_APPLY_TO_VALUES.join(", ");
  if (sitting.recurring && applyTo === undefined) throw new ValidationError("applyTo", `is required because this meal repeats: ${choices}`);
  if (!sitting.recurring && applyTo !== undefined) throw new ValidationError("applyTo", "must be omitted: this is a one-time meal");
}

/** Skylight's own 400/422 about apply_to (the plan changed under us, or its idea of "repeating" differs): say what to do instead of passing the raw text on. */
function mapScopeError(e: unknown): unknown {
  if (e instanceof SkylightApiError && (e.status === 400 || e.status === 422) && /apply_to/i.test(e.message)) {
    return new ValidationError("applyTo", "Skylight refused this scope for the meal (it repeats, or it does not); run skylight_list_meals again and use applyTo only for a meal with recurring: true");
  }
  return e;
}

const mealIdSchema = z.string().describe("Meal id (mealId) from skylight_list_meals.");
const dateSchema = z.string().describe("The date YYYY-MM-DD of that meal row, as listed by skylight_list_meals.");
const scopeSchema = z.enum(EXPOSED_MEAL_APPLY_TO_VALUES as [string, ...string[]]).optional()
  .describe("Needed only for a repeating meal (recurring: true): \"one\" = only this date, \"future\" = this date and all later ones, \"all\" = every date of the meal. Omit for a one-time meal.");

export function registerMealTools(server: McpServer, ctx: ToolContext): void {
  const tz = ctx.config.timezone;

  server.registerTool(
    "skylight_list_meal_categories",
    {
      title: "List meal categories",
      description: "List the meal slots of the meal plan (Breakfast, Lunch, Dinner, Snack) as { id, name, color, enabled, position }. Meals and recipes take a category by id or by name.",
      inputSchema: {},
      annotations: ANNOTATIONS.read,
    },
    () => run(async () => listMealCategories(ctx, await ctx.frames.resolve()))
  );

  server.registerTool(
    "skylight_update_meal_category",
    {
      title: "Update a meal category",
      description: "Rename a meal category, change its #RRGGBB color, or turn it off or on (enabled). Only the provided fields change.",
      inputSchema: {
        categoryId: z.string().describe("Category id from skylight_list_meal_categories."),
        name: z.string().optional().describe(`New name, up to ${MAX_MEAL_CATEGORY_NAME_LENGTH} characters.`),
        color: z.string().optional().describe("Hex color \"#RRGGBB\"."),
        enabled: z.boolean().optional().describe("false hides the category on the meal plan, true shows it."),
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const { categoryId, ...rest } = args;
      const id = assertNumericId(categoryId, "categoryId");
      const body = buildMealCategoryUpdateBody(rest);
      const frameId = await ctx.frames.resolve();
      const json = await ctx.client.request<unknown>({ method: "PATCH", path: `${MEALS_PATH(frameId)}/categories/${id}`, body });
      return mapMealCategory(dataOf(json)) ?? { id, updated: true };
    })
  );

  server.registerTool(
    "skylight_list_meals",
    {
      title: "List planned meals",
      description: `List the planned meals between two dates (default today through 7 days ahead, at most ${MAX_MEAL_SPAN_DAYS} days apart) as one row per date: { mealId, date, category: { id, name }, title, recipeId, note, recurring, recurrenceRule }, sorted by date and then meal slot. A repeating meal appears once for each of its dates with the same mealId; pass mealId and date to skylight_update_meal or skylight_delete_meal.`,
      inputSchema: {
        after: z.string().optional().describe("First day YYYY-MM-DD (inclusive). Default today."),
        before: z.string().optional().describe(`Last day YYYY-MM-DD (inclusive). Default 7 days after "after"; at most ${MAX_MEAL_SPAN_DAYS} days after it.`),
      },
      annotations: ANNOTATIONS.read,
    },
    (args) => run(async () => {
      const after = assertDate(args.after ?? todayIn(tz, ctx.now()), "after");
      const before = assertDate(args.before ?? addDays(after, 7), "before");
      if (after > before) throw new ValidationError("after", "must not be later than before");
      if (Date.parse(`${before}T00:00:00Z`) - Date.parse(`${after}T00:00:00Z`) > MAX_MEAL_SPAN_DAYS * 86_400_000) throw new ValidationError("before", `must be within ${MAX_MEAL_SPAN_DAYS} days of after`);
      const frameId = await ctx.frames.resolve();
      const sittings = await readSittings(ctx, frameId, after, before);
      return explodeSittings(sittings, await listMealCategories(ctx, frameId), { after, before });
    })
  );

  server.registerTool(
    "skylight_plan_meal",
    {
      title: "Plan a meal",
      description: "Put a meal on the meal plan for a date. Give exactly one of recipeId (from skylight_list_recipes; its title and description are used) or title (a free-text meal such as \"Leftovers\"). category is a meal slot by id or by name, ignoring case (see skylight_list_meal_categories). Add recurrence to repeat it. addToGroceryList: true (needs recipeId; default false) also adds the recipe's ingredients to the family's default grocery list. Not idempotent: repeating the call plans the meal again. Returns the created rows as { mealId, date, ... }.",
      inputSchema: {
        date: z.string().describe("First date YYYY-MM-DD."),
        category: z.string().describe("Meal slot: category id, or its name such as \"Dinner\" (case does not matter)."),
        recipeId: z.string().optional().describe("Recipe id from skylight_list_recipes. Give this or title."),
        title: z.string().optional().describe(`Free-text meal name, up to ${MAX_MEAL_TITLE_LENGTH} characters. Give this or recipeId.`),
        note: z.string().optional().describe(`A note shown with the meal, up to ${MAX_MEAL_NOTE_LENGTH} characters.`),
        description: z.string().optional().describe(`Longer details, up to ${MAX_MEAL_DESCRIPTION_LENGTH} characters.`),
        recurrence: recurrenceShape.optional().describe("Repeat schedule. Omit for a single date."),
        addToGroceryList: z.boolean().optional().describe("true adds the recipe's ingredients to the default grocery list (needs recipeId). Default false."),
      },
      annotations: ANNOTATIONS.create,
    },
    (args) => run(async () => {
      const { category, ...rest } = args;
      const finish = prepareMealCreate(rest as MealPlanInput);
      const frameId = await ctx.frames.resolve();
      const categories = await listMealCategories(ctx, frameId);
      const slot = await resolveMealCategory(ctx, frameId, category, categories);
      const body = finish(slot.id);
      const json = await ctx.client.request<unknown>({ method: "POST", path: sittingsPath(frameId), query: { date_min: body.date, date_max: exclusiveDateMax(body.date), include: SITTING_INCLUDE }, body });
      const meals = explodeSittings(sittingsFrom(json), categories);
      return { created: meals.length, meals, ...(meals.length === 0 ? { warning: "Skylight returned no meal; call skylight_list_meals to confirm before retrying." } : {}) };
    })
  );

  server.registerTool(
    "skylight_update_meal",
    {
      title: "Update a planned meal",
      description: "Change a planned meal on one of its dates: title, note, description, category (slot, by id or name) or recipeId. Only the provided fields change. A one-time meal takes no applyTo. A repeating meal (recurring: true in skylight_list_meals) needs applyTo: \"one\" changes only that date and splits it into its own meal with a NEW mealId (the series loses that date), \"future\" changes that date and all later ones, \"all\" changes every date. Returns the meals on that date after the change, which shows any new mealId.",
      inputSchema: {
        mealId: mealIdSchema,
        date: dateSchema,
        applyTo: scopeSchema,
        title: z.string().optional().describe(`New title, up to ${MAX_MEAL_TITLE_LENGTH} characters.`),
        note: z.string().optional().describe(`New note, up to ${MAX_MEAL_NOTE_LENGTH} characters.`),
        description: z.string().optional().describe(`New details, up to ${MAX_MEAL_DESCRIPTION_LENGTH} characters.`),
        category: z.string().optional().describe("Move to another meal slot: category id or name."),
        recipeId: z.string().optional().describe("Link a recipe from skylight_list_recipes."),
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const { mealId, date: rawDate, applyTo, category, ...fields } = args;
      const id = assertNumericId(mealId, "mealId");
      const date = assertDate(rawDate, "date");
      const finish = prepareMealUpdate(fields, category !== undefined);
      const frameId = await ctx.frames.resolve();
      checkScope(await findMeal(ctx, frameId, id, date), applyTo);
      const categories = await listMealCategories(ctx, frameId);
      const slot = category === undefined ? undefined : await resolveMealCategory(ctx, frameId, category, categories);
      const body = finish(slot?.id);
      try {
        await ctx.client.request({
          method: "PATCH", path: `${sittingsPath(frameId)}/${id}/instances/${date}`,
          query: { date_min: date, date_max: exclusiveDateMax(date), include: SITTING_INCLUDE, ...(applyTo !== undefined ? { apply_to: applyTo } : {}) }, body,
        });
      } catch (e) {
        throw mapScopeError(e);
      }
      try {
        return { updated: true, mealId: id, date, meals: explodeSittings(await readSittings(ctx, frameId, date, date), categories, { after: date, before: date }) };
      } catch (e) {
        if (!(e instanceof SkylightApiError)) throw e;
        return { updated: true, mealId: id, date, meals: null, warning: "The meal was changed, but the plan could not be re-read; call skylight_list_meals to see the result (a split-off date has a new mealId)." };
      }
    })
  );

  server.registerTool(
    "skylight_delete_meal",
    {
      title: "Delete a planned meal",
      description: "Delete a planned meal on one of its dates. A one-time meal takes no applyTo. A repeating meal needs applyTo: \"one\" removes only that date, \"future\" ends the series at that date (that date and later), \"all\" deletes every date of the meal. Without confirm: true this makes NO change and returns what would be deleted. Show that to the user and only call again with confirm: true after they agree.",
      inputSchema: {
        mealId: mealIdSchema,
        date: dateSchema,
        applyTo: scopeSchema,
        confirm: z.boolean().optional().describe("Must be true to actually delete. Ask the user first."),
      },
      annotations: ANNOTATIONS.destroy,
    },
    (args) => run(async () => {
      const id = assertNumericId(args.mealId, "mealId");
      const date = assertDate(args.date, "date");
      const frameId = await ctx.frames.resolve();
      const sitting = await findMeal(ctx, frameId, id, date);
      checkScope(sitting, args.applyTo);
      if (args.confirm !== true) {
        const scope = MEAL_SCOPE_TEXT[(args.applyTo as MealScope | undefined) ?? "none"];
        const title = sitting.title ?? "(untitled)";
        return {
          confirmed: false,
          wouldDelete: { mealId: id, date, title: sitting.title, applyTo: args.applyTo ?? null, recurring: sitting.recurring },
          message: `Nothing was deleted. This would delete ${scope}: "${title}" on ${formatHuman(date, tz)}. Ask the user to confirm, then call again with confirm: true.`,
        };
      }
      try {
        await ctx.client.request({ method: "DELETE", path: `${sittingsPath(frameId)}/${id}/instances/${date}`, query: args.applyTo === undefined ? {} : { apply_to: args.applyTo } });
      } catch (e) {
        throw mapScopeError(e);
      }
      return { deleted: true, mealId: id, date, applyTo: args.applyTo ?? null };
    })
  );
}
