import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapProfile, mapProfiles, mapChores, mapRewardPoints, mapRewards, mapReward, mapRewardResponse, mapLists, mapList, mapListItems, mapEvents, mapEvent, mapMealCategories, mapRecipes, mapRecipeResponse, parseRecipeDescription, mapSittings, explodeSittings, mapAlbums, mapPhotoPage, mapPhoto, photosCarryOwner, mapDevices, mapDevice, mapFrame, mapFrameUsers, mapAccount, mapPlusSubscriptions, mapDefaultGroceryList } from "../../src/skylight/types.js";

const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));

test("mapProfiles reads JSON:API categories", () => {
  const out = mapProfiles({ data: [
    { id: "12", type: "category", attributes: { label: "Ellie", color: "#ff0000", linked_to_profile: true, selected_for_chore_chart: true } },
    { id: 13, type: "category", attributes: { name: "Birthdays", color: null, linked_to_profile: false } },
  ] });
  assert.deepEqual(out, [
    { id: "12", name: "Ellie", color: "#ff0000", kind: "profile", onChoreChart: true },
    { id: "13", name: "Birthdays", color: null, kind: "label", onChoreChart: null },
  ]);
});

test("mapProfile maps one resource and kind reflects linked_to_profile true/false/missing", () => {
  assert.equal(mapProfile({ id: "1", attributes: { label: "A", linked_to_profile: true } })!.kind, "profile");
  assert.equal(mapProfile({ id: "1", attributes: { label: "A", linked_to_profile: false } })!.kind, "label");
  assert.equal(mapProfile({ id: "1", attributes: { label: "A" } })!.kind, null);
  assert.equal(mapProfile({ attributes: { label: "A" } }), null);
  assert.equal(mapProfile(null), null);
});

test("mapChores flattens attributes and category relationships", () => {
  const out = mapChores({ data: [{
    id: "900", type: "chore",
    attributes: { summary: "Dishes", start: "2026-10-13", start_time: "18:00", status: "pending", routine: false, recurring: true, recurrence_set: ["RRULE:FREQ=DAILY"], reward_points: 2, emoji_icon: "🍽️" },
    relationships: { category: { data: { id: "12", type: "category" } } },
  }, {
    id: "901", type: "chore", attributes: { summary: "Bed", recurrence_set: "RRULE:FREQ=WEEKLY" },
    relationships: { categories: { data: [{ id: "12" }, { id: "13" }] } },
  }] });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: "900", summary: "Dishes", start: "2026-10-13", startTime: "18:00", status: "pending", routine: false, recurring: true, recurrenceRule: "RRULE:FREQ=DAILY", rewardPoints: 2, emoji: "🍽️", profileIds: ["12"], seriesId: "900", instanceDate: "2026-10-13", instanceTime: null, timeOfDay: null, upForGrabs: false, completedByProfileId: null, description: null, timerSeconds: null, position: null, completedAt: null });
  assert.deepEqual(out[1]!.profileIds, ["12", "13"]);
  assert.equal(out[1]!.recurrenceRule, "RRULE:FREQ=WEEKLY");
  assert.equal(out[1]!.routine, false);
});

test("mapChores derives seriesId and instanceDate from composite ids and the series attribute", () => {
  const out = mapChores({ data: [
    { id: "111881467", attributes: { summary: "A", series: 111881467, start: "2026-10-12", recurring: true } },
    { id: "111881467-2026-10-13", attributes: { summary: "A", series: "111881467", start: "2026-10-12" } },
    { id: "777-2026-10-14", attributes: { summary: "B" } },
    { id: "888", attributes: { summary: "C" } },
    { id: "999-2026-10-15", attributes: { summary: "D", series: "not valid!" } },
    { id: "555-2026-02-30", attributes: { summary: "E" } },
    { id: "444", attributes: { summary: "F", start: "2026-10-12", recurring: false } },
    { id: "445", attributes: { summary: "G", start: "2026-10-12", recurrence_set: ["RRULE:FREQ=DAILY"] } },
  ] });
  assert.deepEqual(out.map((c) => [c.id, c.seriesId, c.instanceDate]), [
    ["111881467", "111881467", "2026-10-12"],
    ["111881467-2026-10-13", "111881467", "2026-10-13"],
    ["777-2026-10-14", "777", "2026-10-14"],
    ["888", "888", null],
    ["999-2026-10-15", "999", "2026-10-15"],
    ["555-2026-02-30", "555-2026-02-30", null],
    ["444", "444", null],
    ["445", "445", "2026-10-12"],
  ]);
});

test("mapChores maps time-suffixed routine occurrence ids from the live fixture", () => {
  const out = mapChores(fixture("chores"));
  assert.equal(out.length, 3);
  const routine = out[0]!;
  assert.equal(routine.id, "60913118-2026-10-12-0600");
  assert.equal(routine.seriesId, "60913118");
  assert.equal(routine.instanceDate, "2026-10-12");
  assert.equal(routine.instanceTime, "06:00");
  assert.equal(routine.timeOfDay, "morning");
  assert.equal(out[1]!.timeOfDay, null);
  assert.equal(routine.routine, true);
  assert.equal(out[1]!.instanceTime, null);
  assert.equal(out[1]!.instanceDate, "2026-05-19");
});

test("mapChores exposes the richer fields and up-for-grabs state from the live fixture", () => {
  const [routine, , grabs] = mapChores(fixture("chores"));
  assert.deepEqual([routine!.upForGrabs, routine!.position, routine!.description, routine!.timerSeconds, routine!.completedAt, routine!.completedByProfileId, routine!.profileIds], [false, 5, null, null, null, null, ["15057970"]]);
  assert.equal(grabs!.id, "93308731");
  assert.equal(grabs!.upForGrabs, true);
  assert.deepEqual(grabs!.profileIds, []);
  assert.equal(grabs!.completedByProfileId, "15057970");
  assert.equal(grabs!.description, "Details");
  assert.equal(grabs!.completedAt, "2026-08-27T16:00:00.000Z");
  assert.equal(grabs!.position, 15);
  assert.equal(grabs!.start, null);
  assert.equal(grabs!.status, "complete");
  assert.equal(grabs!.rewardPoints, 1);
  assert.equal(grabs!.instanceDate, null);
});

test("instanceTime falls back to start_time for routine steps only", () => {
  const out = mapChores({ data: [
    { id: "7", attributes: { summary: "R", routine: true, start_time: "14:00", recurring: true, start: "2026-10-12" } },
    { id: "8", attributes: { summary: "N", routine: false, start_time: "14:00" } },
  ] });
  assert.deepEqual(out.map((c) => c.instanceTime), ["14:00", null]);
});

test("timeOfDay comes from start_time, else BYHOUR, for routine steps only", () => {
  const out = mapChores({ data: [
    { id: "1", attributes: { summary: "A", routine: true, start_time: "14:00" } },
    { id: "2", attributes: { summary: "B", routine: true, recurrence_set: ["RRULE:FREQ=DAILY;BYHOUR=20"] } },
    { id: "3", attributes: { summary: "C", routine: false, start_time: "06:00" } },
  ] });
  assert.deepEqual(out.map((c) => c.timeOfDay), ["afternoon", "evening", null]);
});

test("mappers tolerate missing data and skip malformed items", () => {
  assert.deepEqual(mapChores({}), []);
  assert.deepEqual(mapProfiles({ data: [{ attributes: {} }] }), []);
});

test("mapRewardPoints parses the live plain-array shape", () => {
  const out = mapRewardPoints(fixture("reward_points"));
  assert.equal(out.length, 7);
  assert.deepEqual(out[1], { profileId: "15057970", points: 16, lifetimePoints: 56 });
  assert.deepEqual(out[0], { profileId: "16758450", points: 0, lifetimePoints: 0 });
});

test("mapRewardPoints accepts string ids, a data wrapper, missing lifetime, and skips junk", () => {
  assert.deepEqual(mapRewardPoints([{ category_id: "13", current_point_balance: 7 }]), [{ profileId: "13", points: 7, lifetimePoints: null }]);
  assert.deepEqual(mapRewardPoints({ data: [{ category_id: 12, current_point_balance: 4, lifetime_points_earned: 9 }] }), [{ profileId: "12", points: 4, lifetimePoints: 9 }]);
  assert.deepEqual(mapRewardPoints([{ category_id: 12 }, { current_point_balance: 3 }, null, "x"]), []);
  assert.deepEqual(mapRewardPoints(null), []);
  assert.deepEqual(mapRewardPoints({}), []);
});

test("mapRewards reads name, point_value and the other live attributes", () => {
  const out = mapRewards(fixture("rewards"));
  assert.deepEqual(out, [
    { id: "7323341", title: "Reward 1", cost: 400, emoji: null, description: null, respawnOnRedemption: true, redeemedAt: null, profileId: "15057920", redeemed: false },
    { id: "7323221", title: "Reward 2", cost: 250, emoji: null, description: null, respawnOnRedemption: true, redeemedAt: null, profileId: "15057970", redeemed: false },
  ]);
  const one = mapRewards({ data: [{ id: "5", attributes: { name: "Ice cream", point_value: 0, emoji_icon: "🍦", description: "Treat", respawn_on_redemption: false, redeemed_at: "2026-10-01T10:00:00Z" } }] })[0]!;
  assert.equal(one.cost, 0);
  assert.equal(one.emoji, "🍦");
  assert.equal(one.respawnOnRedemption, false);
  assert.equal(one.redeemedAt, "2026-10-01T10:00:00Z");
  assert.equal(mapRewards({ data: [{ id: "6", attributes: { name: "No cost" } }] })[0]!.cost, null);
});

test("mapReward derives redeemed from redeemed_at and tolerates a missing category", () => {
  const r = mapReward({ id: "5", attributes: { name: "Ice cream", point_value: 4, redeemed_at: "2026-10-01T10:00:00Z" }, relationships: { category: { data: { id: "12" } } } })!;
  assert.deepEqual([r.redeemed, r.redeemedAt, r.profileId], [true, "2026-10-01T10:00:00Z", "12"]);
  assert.equal(mapReward({ id: "6", attributes: { name: "x" } })!.profileId, null);
  assert.equal(mapReward({ id: "6", attributes: {} }), null);
  assert.equal(mapReward(null), null);
});

test("mapRewardResponse accepts a data array (create), a single resource (get/update/redeem) or nothing", () => {
  const raw = fixture("rewards") as { data: unknown[] };
  assert.equal(mapRewardResponse(raw).length, 2);
  assert.deepEqual(mapRewardResponse({ data: raw.data[0] }).map((r) => r.id), ["7323341"]);
  assert.deepEqual(mapRewardResponse(null), []);
  assert.deepEqual(mapRewardResponse({}), []);
});

test("mapLists reads the live list fixture: kind, color, hide_on_device and the item count", () => {
  const out = mapLists(fixture("lists"));
  assert.deepEqual(out, [
    { id: "4771333", title: "List 1", kind: "shopping", color: "#42D792", hiddenOnDevice: false, itemCount: 2 },
    { id: "4771334", title: "List 2", kind: "to_do", color: "#A8D4D3", hiddenOnDevice: false, itemCount: 2 },
  ]);
});

test("mapList tolerates a missing relationship and unknown kinds, and rejects resources without a label", () => {
  assert.deepEqual(mapList({ id: "9", attributes: { label: "Misc", kind: "weird", hide_on_device: true } }), { id: "9", title: "Misc", kind: null, color: null, hiddenOnDevice: true, itemCount: null });
  assert.equal(mapList({ id: "9", attributes: {} }), null);
  assert.equal(mapList({ id: "9", attributes: { label: "x" }, relationships: { list_items: { data: [] } } })!.itemCount, 0);
  assert.deepEqual(mapLists(null), []);
});

test("mapListItems maps status to done, keeps section and position", () => {
  const out = mapListItems(fixture("list_items"));
  assert.ok(out.length >= 1);
  assert.deepEqual(out[0], { id: "112792712", title: "Item 1", done: true, section: null, position: 8 });
  const mixed = mapListItems({ data: [
    { id: "1", attributes: { label: "A", status: "pending", section: "Dairy", position: 2 } },
    { id: "2", attributes: { label: "B", status: "completed", section: null, position: 1 } },
    { id: "3", attributes: { status: "pending" } },
  ] });
  assert.deepEqual(mixed, [{ id: "1", title: "A", done: false, section: "Dairy", position: 2 }, { id: "2", title: "B", done: true, section: null, position: 1 }]);
});

test("mapEvents reads the live fixture: composite ids, source, rrule, category, offsets kept as returned", () => {
  const out = mapEvents(fixture("calendar_events"));
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { id: "11019657225", masterId: "11019657225", title: "Event 1", startsAt: "2026-10-08T00:00:00.000Z", endsAt: "2026-10-13T00:00:00.000Z", allDay: true, timezone: null, recurring: false, recurrenceRule: null, location: null, description: null, emoji: null, profileIds: ["14515614"], source: "google", editable: true });
  assert.equal(out[1]!.description, "Details");
  const recurring = out[2]!;
  assert.equal(recurring.id, "11019627806-1791803100");
  assert.equal(recurring.masterId, "11019627806");
  assert.equal(recurring.recurring, true);
  assert.equal(recurring.recurrenceRule, "RRULE:FREQ=WEEKLY;WKST=SU;INTERVAL=1;BYDAY=MO,FR");
  assert.equal(recurring.timezone, "America/New_York");
  assert.deepEqual(recurring.profileIds, ["15057920"]);
});

test("mapEvent skips resources without an id or title and defaults editable/allDay", () => {
  assert.equal(mapEvent({ attributes: { summary: "x" } }), null);
  assert.equal(mapEvent({ id: "1", attributes: {} }), null);
  const e = mapEvent({ id: "1", attributes: { summary: "x", starts_at: "2026-10-12T10:00:00.000-04:00", source: "skylight" } })!;
  assert.deepEqual([e.allDay, e.editable, e.recurrenceRule, e.profileIds, e.source], [false, false, null, [], "skylight"]);
  assert.deepEqual(mapEvents(null), []);
});

test("mapMealCategories maps the live fixture and drops the icon", () => {
  const out = mapMealCategories(fixture("meal_categories"));
  assert.deepEqual(out.map((c) => [c.id, c.name, c.color, c.enabled, c.position]), [
    ["6859334", "Breakfast", "#A8D4D3", true, 0], ["6859335", "Lunch", "#F66951", true, 1], ["6859336", "Dinner", "#915EA1", true, 2], ["6859337", "Snack", "#FDC36D", true, 3],
  ]);
  assert.deepEqual(Object.keys(out[0]!).sort(), ["color", "enabled", "id", "name", "position"]);
  assert.deepEqual(mapMealCategories({ data: [{ id: "1", attributes: {} }, { attributes: { label: "x" } }] }), []);
});

test("parseRecipeDescription reads the Ingredients:/Instructions: convention", () => {
  assert.deepEqual(parseRecipeDescription("Ingredients:\n- Item A\n- Item B\n\nInstructions:\n1. Step one.\n2. Step two.\n"), { ingredients: ["Item A", "Item B"], instructions: ["Step one.", "Step two."] });
  assert.deepEqual(parseRecipeDescription(null), { ingredients: null, instructions: null });
  assert.deepEqual(parseRecipeDescription(""), { ingredients: null, instructions: null });
  assert.deepEqual(parseRecipeDescription("Just grill it until done."), { ingredients: null, instructions: null });
  assert.deepEqual(parseRecipeDescription("Ingredients:\n- a\n"), { ingredients: ["a"], instructions: null });
  assert.deepEqual(parseRecipeDescription("Instructions:\n1. x\n"), { ingredients: null, instructions: ["x"] });
  assert.deepEqual(parseRecipeDescription("Ingredients:\n\nInstructions:\n1. x"), { ingredients: [], instructions: ["x"] });
});

test("parseRecipeDescription tolerates case, indentation, CRLF, other headings, odd numbering and non-dash lines", () => {
  const text = "  ingredients:  \r\n  - 2 eggs\r\n- 1 cup flour - sifted\r\nsome stray line\r\n-notabullet\r\n\r\nNotes:\r\n- not an ingredient\r\n\r\nINSTRUCTIONS:\r\n10. Mix\r\n11) Bake\r\nServe warm\r\n";
  assert.deepEqual(parseRecipeDescription(text), { ingredients: ["2 eggs", "1 cup flour - sifted"], instructions: ["Mix", "Bake", "Serve warm"] });
});

test("mapRecipes reads the live fixture, resolving category names from `included`", () => {
  const out = mapRecipes(fixture("meal_recipes"));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { id: "48148099", title: "Recipe 1", categoryId: "6859334", categoryName: "Breakfast", description: "Ingredients:\n- Item A\n- Item B\n\nInstructions:\n1. Step one.\n", source: null, ingredients: ["Item A", "Item B"], instructions: ["Step one."] });
  assert.deepEqual([out[1]!.categoryId, out[1]!.categoryName], ["6859337", "Snack"]);
});

test("mapRecipeResponse reads a single { data: recipe }; a missing include leaves the name null", () => {
  const one = mapRecipeResponse({ data: { id: "5", attributes: { summary: "Soup", description: null, source: "grandma" }, relationships: { meal_category: { data: { id: "6859336" } } } } });
  assert.deepEqual(one, { id: "5", title: "Soup", categoryId: "6859336", categoryName: null, description: null, source: "grandma", ingredients: null, instructions: null });
  assert.equal(mapRecipeResponse({ data: null }), null);
  assert.equal(mapRecipeResponse({ data: { id: "5", attributes: {} } }), null);
});

test("mapSittings reads the live fixture", () => {
  const out = mapSittings(fixture("meal_sittings"));
  assert.deepEqual(out[0], { id: "1001", title: "Pasta night", description: "Ingredients:\n- Noodles\n- Sauce\n", note: "Use the big pot", recurring: false, recurrenceRule: null, instances: ["2026-10-13"], categoryId: "6859336", recipeId: "2001" });
  assert.deepEqual(out[1], { id: "1002", title: "Cereal", description: null, note: null, recurring: true, recurrenceRule: "FREQ=DAILY", instances: ["2026-10-13", "2026-10-14", "2026-10-15"], categoryId: "6859334", recipeId: null });
});

test("explodeSittings makes one row per date, sorted by date then category position, and honours a date window", () => {
  const categories = mapMealCategories(fixture("meal_categories"));
  const rows = explodeSittings(mapSittings(fixture("meal_sittings")), categories);
  assert.deepEqual(rows.map((r) => [r.date, r.mealId, r.title, r.category?.name]), [
    ["2026-10-13", "1002", "Cereal", "Breakfast"], ["2026-10-13", "1001", "Pasta night", "Dinner"], ["2026-10-14", "1002", "Cereal", "Breakfast"], ["2026-10-15", "1002", "Cereal", "Breakfast"],
  ]);
  assert.deepEqual(rows[1], { mealId: "1001", date: "2026-10-13", category: { id: "6859336", name: "Dinner" }, title: "Pasta night", recipeId: "2001", note: "Use the big pot", recurring: false, recurrenceRule: null });
  assert.deepEqual(rows[0]!.recurrenceRule, "FREQ=DAILY");
  assert.deepEqual(explodeSittings(mapSittings(fixture("meal_sittings")), categories, { after: "2026-10-14", before: "2026-10-14" }).map((r) => r.date), ["2026-10-14"]);
  // an unknown category sorts last and has a null name
  const odd = explodeSittings([{ id: "9", title: "X", description: null, note: null, recurring: false, recurrenceRule: null, instances: ["2026-10-13"], categoryId: "777", recipeId: null }], categories);
  assert.deepEqual(odd[0]!.category, { id: "777", name: null });
});

test("mapAlbums reads the live fixture", () => {
  assert.deepEqual(mapAlbums(fixture("albums")), [{ id: "3001", title: "Summer", photoCount: 1, videoCount: 0, editable: true }]);
  assert.deepEqual(mapAlbums({ data: [{ id: "4", attributes: { title: "New" } }] }), [{ id: "4", title: "New", photoCount: null, videoCount: null, editable: null }]);
});

test("mapPhotoPage maps messages without any URL, key, bucket or owner id", () => {
  const page = mapPhotoPage(fixture("messages"), 1);
  assert.equal(page.page, 1);
  assert.equal(page.pages, 2);
  assert.deepEqual(page.photos[1], { id: "1794275814", type: "photo", createdAt: "2026-07-10T18:27:03.501Z", caption: "Beach day", from: "user@example.invalid", commentsCount: 0 });
  const text = JSON.stringify(page);
  for (const secret of ["example.invalid/asset", "asset_url", "thumbnail", "example-bucket", "asset-0.jpg", "12311021", "frame_owner"]) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(mapPhotoPage({ data: [] }, 3), { page: 3, pages: 1, photos: [] });
  assert.equal(mapPhoto({ id: "1", attributes: { asset_type: "video", caption: null, comments_count: "2" } })!.commentsCount, 2);
  assert.equal(mapPhoto({ attributes: {} }), null);
});

test("mapDevices reads the live fixture; -1 becomes \"all\" and unrelated fields are dropped", () => {
  const out = mapDevices(fixture("devices"));
  assert.deepEqual(out, [{ id: "88", name: "Family Calendar", timezone: "America/New_York", brightness: 255, sleepsAt: "21:00", wakesAt: "06:00", sleeping: false, sleepModeOn: false, showCaption: true, showHeart: false, blurEffect: true, slideshowSpeed: 10, slideshowStyle: 0, startSound: false, currentAlbumId: "all" }]);
  assert.equal(mapDevice({ id: "5", attributes: { name: "d", current_album_id: 3001 } })!.currentAlbumId, "3001");
  assert.equal(mapDevice({ id: "5", attributes: { name: "d" } })!.currentAlbumId, null);
  assert.equal(mapDevice({ id: "5", attributes: {} }), null);
});

test("mapFrame reads the live fixture and carries none of the secrets", () => {
  const frame = mapFrame((fixture("frame") as { data: unknown }).data)!;
  assert.equal(frame.id, "77");
  assert.deepEqual([frame.name, frame.timezone, frame.householdName, frame.locale, frame.photosOpenToPublic, frame.photoViewability, frame.plus], ["familyframe", "America/New_York", null, "en", false, "only_viewable_to_owner", true]);
  assert.equal(frame.features.chores, true);
  assert.equal(frame.features.lists, true);
  assert.equal(frame.features.dinner_plans, false);
  assert.equal(frame.features.meals, true);
  assert.ok(!("meal_planning" in frame.features));
  assert.ok(!("bundle_name" in frame.features) && !("bundle_names" in frame.features));
  const text = JSON.stringify(frame);
  for (const secret of ["share_token", "notification_email", "owner_birthday", "owner_name", "hardware", "user_created_at", "gift"]) assert.ok(!text.includes(secret), secret);
  assert.equal(mapFrame({ id: "1" })!.photosOpenToPublic, null);
  assert.equal(mapFrame(null), null);
});

test("mapFrameUsers pairs each frame_user with its user's email", () => {
  const out = mapFrameUsers(fixture("frame_users"));
  assert.equal(out.length, 4);
  assert.deepEqual(out[3], { userId: "12311021", email: "user@example.invalid", status: "approved", owner: true });
  assert.deepEqual(out.map((u) => u.owner), [false, false, false, true]);
  assert.deepEqual(mapFrameUsers({ data: [{ id: "1", attributes: { status: "rejected", is_owner: false }, relationships: { user: { data: { id: "9" } } } }] }), [{ userId: "9", email: null, status: "rejected", owner: false }]);
  assert.deepEqual(mapFrameUsers({ data: [{ id: "1", attributes: {} }] }), []);
});

test("mapAccount keeps only the plan and the marketing flag; mapPlusSubscriptions reads plus_access", () => {
  const user = { data: { id: "1", attributes: { subscription_status: "plus", agreed_to_marketing: true, email: "me@example.com", phone: "555", birthday: "1990-01-01", profile: { name: "Me" }, notification_preference: null } } };
  assert.deepEqual(mapAccount(user), { plan: "plus", marketingEmails: true });
  assert.deepEqual(mapAccount({ data: { attributes: {} } }), { plan: null, marketingEmails: null });
  assert.deepEqual(mapAccount(null), { plan: null, marketingEmails: null });
  const plus = { data: { shares: [{ type: "share", attributes: { plus_type: "cal_plus", status: "active" } }], subscriptions: [{ id: "9", type: "subscription", attributes: { plus_type: "cal_plus", status: "active", cadence: "yearly", store_token: "secret" } }, { type: "subscription", attributes: { plus_type: "assistant", status: "canceled" } }], bundle_entitlement: { available: true } } };
  assert.deepEqual(mapPlusSubscriptions(plus), [{ status: "active", cadence: "yearly", type: "cal_plus" }, { status: "canceled", cadence: null, type: "assistant" }]);
  assert.deepEqual(mapPlusSubscriptions({ data: { subscriptions: [] } }), []);
  assert.deepEqual(mapPlusSubscriptions(null), []);
});

test("mapDefaultGroceryList finds the list flagged default_grocery_list", () => {
  const lists = { data: [{ id: "1", attributes: { label: "Chores", default_grocery_list: false } }, { id: "2", attributes: { label: "Groceries", default_grocery_list: true } }] };
  assert.deepEqual(mapDefaultGroceryList(lists), { id: "2", title: "Groceries" });
  assert.equal(mapDefaultGroceryList({ data: [{ id: "1", attributes: { label: "x" } }] }), null);
  assert.equal(mapDefaultGroceryList(null), null);
});

const message = (attributes: Record<string, unknown>) => ({ id: "9", type: "message_asset", attributes: { asset_type: "photo", created_at: "2026-07-10T18:27:09.554Z", caption: "", comments_count: 0, ...attributes } });

test("mapPhoto shows \"you\" for a photo the frame owner sent, never the owner's email, and the email of anyone else", () => {
  const mine = mapPhoto(message({ from_email: "owner@example.invalid", sender_id: 12311021, frame_owner_id: 12311021 }));
  assert.equal(mine!.from, "you");
  assert.ok(!JSON.stringify(mine).includes("owner@example.invalid"));
  assert.equal(mapPhoto(message({ from_email: "aunt@example.invalid", sender_id: 13293082, frame_owner_id: 12311021 }))!.from, "aunt@example.invalid");
  // numeric and string ids compare equal
  assert.equal(mapPhoto(message({ from_email: "owner@example.invalid", sender_id: "12311021", frame_owner_id: 12311021 }))!.from, "you");
});

test("mapPhoto falls back to the owner id it is given when the message has no frame_owner_id, and withholds the sender when the owner cannot be told", () => {
  const raw = message({ from_email: "owner@example.invalid", sender_id: 12311021 });
  assert.equal(mapPhoto(raw, "12311021")!.from, "you");
  assert.equal(mapPhoto(message({ from_email: "aunt@example.invalid", sender_id: 13293082 }), "12311021")!.from, "aunt@example.invalid");
  assert.equal(mapPhoto(raw)!.from, null, "owner unknown: the email is withheld rather than risk returning the owner's");
  assert.equal(mapPhoto(raw, null)!.from, null);
  assert.equal(mapPhoto(message({ from_email: "owner@example.invalid", frame_owner_id: 12311021 }))!.from, null, "no sender_id: cannot tell who sent it");
  assert.equal(mapPhoto(message({ sender_id: 1, frame_owner_id: 2 }))!.from, null, "no email at all");
  // the message's own frame_owner_id wins over the fallback
  assert.equal(mapPhoto(message({ from_email: "owner@example.invalid", sender_id: 12311021, frame_owner_id: 12311021 }), "999")!.from, "you");
});

test("photosCarryOwner says whether every message names the frame owner", () => {
  assert.equal(photosCarryOwner(fixture("messages")), true);
  assert.equal(photosCarryOwner({ data: [message({ frame_owner_id: 1 }), message({})] }), false);
  assert.equal(photosCarryOwner({ data: [] }), true);
  assert.equal(photosCarryOwner(null), true);
});

test("mapPhotoPage threads the fallback owner id through every photo", () => {
  const json = { data: [message({ from_email: "owner@example.invalid", sender_id: 7 }), message({ from_email: "aunt@example.invalid", sender_id: 8 })], meta: { current_page: 1, num_pages: 1 } };
  assert.deepEqual(mapPhotoPage(json, 1, "7").photos.map((p) => p.from), ["you", "aunt@example.invalid"]);
});
