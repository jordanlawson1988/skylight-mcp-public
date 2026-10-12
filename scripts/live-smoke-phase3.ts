// Phase 3 live write checks: meals and recipes, albums and captions, device settings and the frame. Called from live-smoke.ts after phase 2
// when SKYLIGHT_LIVE_WRITE=1. Everything runs through the real MCP tools (in-memory client) where that is the behavior under test, and through raw requests for
// read-backs and cleanup. Every created object carries the PREFIX (grocery items come from the recipe's `zzsmoke` ingredients); cleanup happens in
// `finally`, followed by leftover checks. It NEVER calls reset/remove device, delete photos, invite, block, or the marketing write.
import type { Runtime } from "../src/runtime.js";
import { addDays, exclusiveDateMax } from "../src/skylight/time.js";
import { mapAlbums, mapDefaultGroceryList, mapListItems, mapRecipes, mapSittings } from "../src/skylight/types.js";
import { connectTools, ok, PREFIX } from "./live-smoke-phase2.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const SMOKE_INGREDIENTS = ["zzsmoke a", "zzsmoke b"];
const isSmokeItem = (title: string): boolean => title.toLowerCase().includes("zzsmoke");

interface MealRow { mealId: string; date: string; title: string | null; recipeId: string | null; recurring: boolean }
interface AlbumRow { id: string; title: string; photoCount: number | null; videoCount: number | null }
interface PhotoRow { id: string; type: string | null; caption: string | null }
interface DeviceRow { id: string; showHeart: boolean | null; brightness: number | null }

export async function phase3Smoke(rt: Runtime, frameId: string, today: string): Promise<void> {
  const stamp = new Date().toISOString();
  const frame = `/api/frames/${frameId}`;
  const steps: string[] = [];
  const step = (name: string) => { steps.push(name); console.log("ok:", name); };
  const writes: string[] = [];
  const tools = await connectTools(writes);
  const { call } = tools;
  const day = (n: number): string => addDays(today, n);
  const tomorrow = day(1);

  const get = <T = unknown>(path: string, query?: Record<string, string | number | boolean>) => rt.client.request<T>({ method: "GET", path: `${frame}${path}`, ...(query ? { query } : {}) });
  const meals = async (after: string, before: string) => ok(await call("skylight_list_meals", { after, before }), "list meals") as MealRow[];
  const albums = async () => ok(await call("skylight_list_albums"), "list albums") as AlbumRow[];
  const newestPhoto = async () => (ok(await call("skylight_list_photos", { page: 1 }), "list photos") as { photos: PhotoRow[] }).photos[0] ?? null;
  const devices = async () => ok(await call("skylight_list_devices"), "list devices") as DeviceRow[];

  // State that cleanup needs, recorded the moment something exists.
  const recipeIds = new Set<string>();
  const albumIds = new Set<string>();
  const groceryItems: Array<{ listId: string; itemId: string }> = [];
  let captionRestore: { photoId: string; caption: string } | null = null;
  let heartRestore: { deviceId: string; showHeart: boolean } | null = null;
  const leftovers = { recipes: 0, meals: 0, albums: 0, groceryItems: 0, unrestored: 0 };

  const smokeMeals = async (): Promise<MealRow[]> => (await meals(today, day(12))).filter((m) => (m.title ?? "").startsWith(PREFIX) || (m.recipeId !== null && recipeIds.has(m.recipeId)));
  const smokeRecipes = async () => mapRecipes(await get("/meals/recipes", { include: "meal_category" })).filter((r) => r.title.startsWith(PREFIX));
  const smokeAlbums = async () => mapAlbums(await get("/albums")).filter((a) => a.title.startsWith(PREFIX));
  const groceryList = async () => mapDefaultGroceryList(await get("/lists"));
  const smokeGroceryItems = async (): Promise<Array<{ listId: string; itemId: string; title: string }>> => {
    const list = await groceryList();
    if (!list) return [];
    return mapListItems(await get(`/lists/${list.id}/list_items`)).filter((i) => isSmokeItem(i.title)).map((i) => ({ listId: list.id, itemId: i.id, title: i.title }));
  };

  try {
    // ---- Meals and recipes.
    const categories = ok(await call("skylight_list_meal_categories"), "list meal categories") as Array<{ id: string; name: string; enabled: boolean }>;
    const category = categories.find((c) => c.name.toLowerCase() === "dinner") ?? categories.find((c) => c.enabled);
    if (!category) throw new Error(`no usable meal category: ${JSON.stringify(categories)}`);
    step(`meal categories listed (${categories.map((c) => c.name).join(", ")})`);

    const made = ok(await call("skylight_create_recipe", { title: `${PREFIX} recipe ${stamp}`, category: category.name, ingredients: SMOKE_INGREDIENTS, instructions: ["Smoke step."] }), "create recipe") as { id: string };
    recipeIds.add(made.id);
    const got = ok(await call("skylight_get_recipe", { recipeId: made.id }), "get recipe") as { ingredients: string[] | null; instructions: string[] | null };
    if (JSON.stringify(got.ingredients) !== JSON.stringify(SMOKE_INGREDIENTS) || JSON.stringify(got.instructions) !== JSON.stringify(["Smoke step."])) throw new Error(`recipe did not parse back: ${JSON.stringify(got)}`);
    step(`recipe ${made.id} created and parsed back to ${got.ingredients?.length ?? 0} ingredients`);

    const once = ok(await call("skylight_plan_meal", { date: tomorrow, category: category.name, recipeId: made.id }), "plan one-time meal") as { meals: MealRow[] };
    const onceId = once.meals[0]?.mealId;
    if (!onceId) throw new Error(`plan meal (recipe) returned no meal: ${JSON.stringify(once)}`);
    const dailyTitle = `${PREFIX} daily ${stamp}`;
    const daily = ok(await call("skylight_plan_meal", { date: tomorrow, category: category.name, title: dailyTitle, recurrence: { frequency: "daily" } }), "plan daily meal") as { meals: MealRow[] };
    const seriesId = daily.meals[0]?.mealId;
    if (!seriesId) throw new Error(`plan meal (daily) returned no meal: ${JSON.stringify(daily)}`);
    const rows = await meals(tomorrow, tomorrow);
    if (!rows.some((m) => m.mealId === onceId && m.recipeId === made.id) || !rows.some((m) => m.mealId === seriesId && m.recurring && m.title === dailyTitle)) throw new Error(`planned meals not listed as expected: ${JSON.stringify(rows)}`);
    step(`one-time meal ${onceId} and daily meal ${seriesId} planned for ${tomorrow}`);

    const splitDate = day(2);
    const splitTitle = `${PREFIX} daily one ${stamp}`;
    ok(await call("skylight_update_meal", { mealId: seriesId, date: splitDate, applyTo: "one", title: splitTitle }), "update one date of the daily meal");
    const week = await meals(tomorrow, day(6));
    const split = week.find((m) => m.date === splitDate && m.title === splitTitle);
    if (!split || split.mealId === seriesId) throw new Error(`applyTo one did not give ${splitDate} a new mealId: ${JSON.stringify(week.filter((m) => m.date === splitDate))}`);
    if (week.some((m) => m.mealId === seriesId && m.date === splitDate)) throw new Error(`the series still has ${splitDate} after it was split off`);
    step(`applyTo one split ${splitDate} into meal ${split.mealId}`);

    const writesBefore = writes.length;
    const preview = ok(await call("skylight_delete_meal", { mealId: seriesId, date: day(3), applyTo: "one" }), "delete one date preview") as { confirmed: boolean; message: string };
    if (preview.confirmed !== false || !/only this date/.test(preview.message) || writes.length !== writesBefore) throw new Error(`delete meal preview unexpected or wrote: ${JSON.stringify(preview)}`);
    ok(await call("skylight_delete_meal", { mealId: seriesId, date: day(3), applyTo: "one", confirm: true }), "delete one date");
    ok(await call("skylight_delete_meal", { mealId: seriesId, date: day(4), applyTo: "future", confirm: true }), "delete from +4");
    const remaining = (await meals(tomorrow, day(8))).filter((m) => m.mealId === seriesId).map((m) => m.date);
    if (remaining.length !== 1 || remaining[0] !== tomorrow) throw new Error(`series dates after deleting +3 (one) and +4 onward (future): ${remaining.join(", ") || "(none)"}`);
    step("daily meal lost +3 (one) and +4 onward (future); only tomorrow remains");

    ok(await call("skylight_delete_meal", { mealId: split.mealId, date: splitDate, ...(split.recurring ? { applyTo: "all" } : {}), confirm: true }), "delete the split-off meal");
    // A truncated series may now report itself as one-time; use the scope its row asks for.
    const current = (await meals(tomorrow, tomorrow)).find((m) => m.mealId === seriesId);
    if (current) ok(await call("skylight_delete_meal", { mealId: seriesId, date: tomorrow, ...(current.recurring ? { applyTo: "all" } : {}), confirm: true }), "delete the daily series");
    const stillPlanned = (await smokeMeals()).filter((m) => m.mealId !== onceId);
    if (stillPlanned.length > 0) throw new Error(`smoke meals still planned after deleting the series: ${JSON.stringify(stillPlanned)}`);
    step("split meal and daily series deleted");

    const grocery = await groceryList();
    if (!grocery) {
      console.log("note: no default grocery list on this frame; the grocery step is skipped");
    } else {
      const queued = ok(await call("skylight_add_recipe_to_grocery_list", { recipeId: made.id }), "add recipe to grocery list") as { queued: boolean; listName: string | null };
      if (!queued.queued || queued.listName !== grocery.title) throw new Error(`add to grocery list answered ${JSON.stringify(queued)}, expected the list "${grocery.title}"`);
      const deadline = Date.now() + 15_000;
      let found = await smokeGroceryItems();
      for (;;) {
        for (const i of found) if (!groceryItems.some((g) => g.itemId === i.itemId)) groceryItems.push({ listId: i.listId, itemId: i.itemId });
        if (found.length >= SMOKE_INGREDIENTS.length || Date.now() >= deadline) break;
        await sleep(1000);
        found = await smokeGroceryItems();
      }
      if (found.length !== SMOKE_INGREDIENTS.length) throw new Error(`expected ${SMOKE_INGREDIENTS.length} zzsmoke items on the grocery list within 15 s, saw ${found.length}: ${found.map((i) => i.title).join(", ")}`);
      step(`Skylight added ${found.length} zzsmoke items to "${grocery.title}"`);
      for (const g of [...groceryItems]) {
        await rt.client.request({ method: "DELETE", path: `${frame}/lists/${g.listId}/list_items/${g.itemId}` });
        groceryItems.splice(groceryItems.indexOf(g), 1);
      }
      if ((await smokeGroceryItems()).length !== 0) throw new Error("zzsmoke grocery items still present after deleting them");
      step("zzsmoke grocery items deleted");
    }

    const recipePreview = ok(await call("skylight_delete_recipe", { recipeId: made.id, alsoDeletePlannedMeals: true }), "delete recipe preview") as { confirmed: boolean; wouldDelete: { plannedMeals: number | null } };
    if (recipePreview.confirmed !== false || (recipePreview.wouldDelete.plannedMeals ?? 0) < 1) throw new Error(`recipe delete preview unexpected: ${JSON.stringify(recipePreview)}`);
    const recipeGone = ok(await call("skylight_delete_recipe", { recipeId: made.id, alsoDeletePlannedMeals: true, confirm: true }), "delete recipe") as { deletedMealIds: string[] };
    if ((await meals(tomorrow, tomorrow)).some((m) => m.mealId === onceId)) throw new Error(`meal ${onceId} is still planned after deleting its recipe with alsoDeletePlannedMeals`);
    if ((await smokeRecipes()).some((r) => r.id === made.id)) throw new Error("recipe still listed after delete");
    step(`recipe deleted with its planned meal (Skylight reported ${recipeGone.deletedMealIds.length} deleted meal ids)`);

    // ---- Albums and captions.
    const albumTitle = `${PREFIX} album ${stamp}`;
    const album = ok(await call("skylight_create_album", { title: albumTitle }), "create album") as { id: string };
    albumIds.add(album.id);
    const renamed = `${albumTitle} renamed`;
    ok(await call("skylight_rename_album", { albumId: album.id, title: renamed }), "rename album");
    if (!(await albums()).some((a) => a.id === album.id && a.title === renamed)) throw new Error("album rename not reflected in the album list");
    step(`album ${album.id} created and renamed`);

    const photo = await newestPhoto();
    const count = async (): Promise<number> => {
      const hit = (await albums()).find((a) => a.id === album.id);
      if (!hit) throw new Error("smoke album missing from the album list");
      return (hit.photoCount ?? 0) + (hit.videoCount ?? 0);
    };
    if (!photo) {
      console.log("note: the frame has no photos; album membership and caption steps are skipped");
    } else {
      ok(await call("skylight_add_photos_to_album", { albumId: album.id, photoIds: [photo.id] }), "add photo to album");
      if ((await count()) !== 1) throw new Error(`album count after adding the newest photo is ${await count()}, expected 1`);
      step(`newest photo ${photo.id} added to the album (count 1)`);
      ok(await call("skylight_remove_photos_from_album", { albumId: album.id, photoIds: [photo.id] }), "remove photo from album");
      if ((await count()) !== 0) throw new Error(`album count after removing the photo is ${await count()}, expected 0`);
      step("photo removed from the album (count 0)");

      captionRestore = { photoId: photo.id, caption: photo.caption ?? "" };
      const smokeCaption = `${PREFIX} caption ${stamp}`.slice(0, 200);
      ok(await call("skylight_update_photo_caption", { photoId: photo.id, caption: smokeCaption }), "set caption");
      const after = ((ok(await call("skylight_list_photos", { page: 1 }), "list photos") as { photos: PhotoRow[] }).photos).find((p) => p.id === photo.id);
      if (after?.caption !== smokeCaption) throw new Error(`caption after update is ${JSON.stringify(after?.caption)}`);
      ok(await call("skylight_update_photo_caption", { photoId: photo.id, caption: captionRestore.caption }), "restore caption");
      const restored = ((ok(await call("skylight_list_photos", { page: 1 }), "list photos") as { photos: PhotoRow[] }).photos).find((p) => p.id === photo.id);
      if ((restored?.caption ?? "") !== captionRestore.caption) throw new Error(`caption after restore is ${JSON.stringify(restored?.caption)}, expected ${JSON.stringify(captionRestore.caption)}`);
      captionRestore = null;
      step("caption set and restored");
    }

    const albumPreview = ok(await call("skylight_delete_album", { albumId: album.id }), "delete album preview") as { confirmed: boolean; message: string };
    if (albumPreview.confirmed !== false || !/stay on the frame/i.test(albumPreview.message) || !(await albums()).some((a) => a.id === album.id)) throw new Error(`album delete preview unexpected or deleted it: ${JSON.stringify(albumPreview)}`);
    ok(await call("skylight_delete_album", { albumId: album.id, confirm: true }), "delete album");
    if ((await albums()).some((a) => a.id === album.id)) throw new Error("album still listed after delete");
    albumIds.delete(album.id);
    step("album deleted");

    // ---- Device: flip showHeart, check nothing else moved, restore.
    const before = (await devices())[0];
    if (!before || before.showHeart === null) {
      console.log("note: no device with a showHeart setting; the device step is skipped");
    } else {
      heartRestore = { deviceId: before.id, showHeart: before.showHeart };
      ok(await call("skylight_update_device", { deviceId: before.id, showHeart: !before.showHeart }), "flip showHeart");
      const flipped = (await devices()).find((d) => d.id === before.id);
      if (flipped?.showHeart !== !before.showHeart || flipped.brightness !== before.brightness) throw new Error(`device after flipping showHeart: ${JSON.stringify(flipped)} (before ${JSON.stringify(before)})`);
      ok(await call("skylight_update_device", { deviceId: before.id, showHeart: before.showHeart }), "restore showHeart");
      const back = (await devices()).find((d) => d.id === before.id);
      if (back?.showHeart !== before.showHeart || back.brightness !== before.brightness) throw new Error(`device after restoring showHeart: ${JSON.stringify(back)}`);
      heartRestore = null;
      step("device showHeart flipped (brightness untouched) and restored");
    }

    // ---- Frame: set the time zone to what it already is.
    const gotFrame = await call("skylight_get_frame");
    const info = ok(gotFrame, "get frame") as { timezone: string | null };
    if (/share_token|notification_email|owner_birthday/.test(gotFrame.text)) throw new Error("get frame leaked a secret field name");
    if (info.timezone) {
      ok(await call("skylight_update_frame", { timezone: info.timezone }), "no-op frame update");
      const again = ok(await call("skylight_get_frame"), "get frame again") as { timezone: string | null };
      if (again.timezone !== info.timezone) throw new Error(`frame timezone changed from ${info.timezone} to ${String(again.timezone)}`);
      step(`frame timezone updated to its current value (${info.timezone}) and unchanged`);
    }
  } finally {
    // Cleanup in dependency order: grocery items, planned meals, recipes, albums, then the setting restores.
    try {
      for (const g of await smokeGroceryItems()) {
        try { await rt.client.request({ method: "DELETE", path: `${frame}/lists/${g.listId}/list_items/${g.itemId}` }); console.log("cleanup deleted grocery item", g.itemId); }
        catch (err) { console.error("cleanup FAILED for grocery item", g.itemId, err instanceof Error ? err.message : err); }
      }
      leftovers.groceryItems = (await smokeGroceryItems()).length;
    } catch (e) { console.error("grocery cleanup failed:", e instanceof Error ? e.message : e); leftovers.groceryItems = -1; }
    try {
      const sittings = mapSittings(await get("/meals/sittings", { date_min: today, date_max: exclusiveDateMax(day(12)), include: "meal_category,meal_recipe" }))
        .filter((s) => (s.title ?? "").startsWith(PREFIX) || (s.recipeId !== null && recipeIds.has(s.recipeId)));
      for (const s of sittings) {
        const date = s.instances[0];
        if (!date) continue;
        try { await rt.client.request({ method: "DELETE", path: `${frame}/meals/sittings/${s.id}/instances/${date}`, query: s.recurring ? { apply_to: "all" } : {} }); console.log("cleanup deleted meal", s.id); }
        catch (err) { console.error("cleanup FAILED for meal", s.id, err instanceof Error ? err.message : err); }
      }
      leftovers.meals = (await smokeMeals()).length;
    } catch (e) { console.error("meal cleanup failed:", e instanceof Error ? e.message : e); leftovers.meals = -1; }
    try {
      for (const r of await smokeRecipes()) {
        try { await rt.client.request({ method: "DELETE", path: `${frame}/meals/recipes/${r.id}`, query: { apply_to_sittings: true } }); console.log("cleanup deleted recipe", r.id); }
        catch (err) { console.error("cleanup FAILED for recipe", r.id, err instanceof Error ? err.message : err); }
      }
      leftovers.recipes = (await smokeRecipes()).length;
    } catch (e) { console.error("recipe cleanup failed:", e instanceof Error ? e.message : e); leftovers.recipes = -1; }
    try {
      for (const a of await smokeAlbums()) {
        try { await rt.client.request({ method: "DELETE", path: `${frame}/albums/${a.id}` }); console.log("cleanup deleted album", a.id); }
        catch (err) { console.error("cleanup FAILED for album", a.id, err instanceof Error ? err.message : err); }
      }
      leftovers.albums = (await smokeAlbums()).length;
    } catch (e) { console.error("album cleanup failed:", e instanceof Error ? e.message : e); leftovers.albums = -1; }
    if (captionRestore !== null) {
      try { await rt.client.request({ method: "PUT", path: `${frame}/messages/${captionRestore.photoId}/caption`, body: { caption: captionRestore.caption } }); console.log("cleanup restored the caption of photo", captionRestore.photoId); }
      catch (e) { console.error("cleanup FAILED to restore the caption of photo", captionRestore.photoId, e instanceof Error ? e.message : e); leftovers.unrestored++; }
    }
    if (heartRestore !== null) {
      try { await rt.client.request({ method: "PUT", path: `${frame}/devices/${heartRestore.deviceId}`, body: { show_heart: heartRestore.showHeart } }); console.log("cleanup restored showHeart on device", heartRestore.deviceId); }
      catch (e) { console.error("cleanup FAILED to restore showHeart on device", heartRestore.deviceId, e instanceof Error ? e.message : e); leftovers.unrestored++; }
    }
    await tools.close();
    console.log(`phase 3 leftovers: recipes ${leftovers.recipes}, meals ${leftovers.meals}, albums ${leftovers.albums}, grocery items ${leftovers.groceryItems}, unrestored settings ${leftovers.unrestored}`);
  }
  if (Object.values(leftovers).some((n) => n !== 0)) {
    throw new Error(`phase 3 smoke left things behind or unrestored (${JSON.stringify(leftovers)}; -1 means the check itself failed). Delete the "${PREFIX}" recipes, meals and albums and any zzsmoke grocery items in the Skylight app, and check the newest photo's caption and the device's heart setting.`);
  }
  console.log(`phase 3 write smoke OK (${steps.join("; ")})`);
}
