import { test } from "node:test";
import assert from "node:assert/strict";
import { connectTestClient } from "../helpers/test-server.js";
import { ValidationError } from "../../src/skylight/errors.js";
import { TOOLSETS, type Toolset } from "../../src/skylight/vocab.js";

/** Every tool each toolset registers. A new tool must be added here, which keeps the groups honest. */
export const TOOLS_BY_TOOLSET: Record<Toolset, string[]> = {
  profiles: ["skylight_list_profiles", "skylight_create_profile", "skylight_update_profile", "skylight_delete_profile"],
  chores: ["skylight_list_chores", "skylight_create_chore", "skylight_bulk_create_chores", "skylight_update_chore", "skylight_delete_chore", "skylight_complete_chore", "skylight_move_routine_step"],
  rewards: ["skylight_get_reward_points", "skylight_add_reward_points", "skylight_list_rewards", "skylight_create_reward", "skylight_update_reward", "skylight_redeem_reward", "skylight_unredeem_reward", "skylight_delete_reward"],
  lists: ["skylight_list_lists", "skylight_list_items", "skylight_create_list", "skylight_update_list", "skylight_delete_list", "skylight_add_list_items", "skylight_update_list_item", "skylight_move_list_item", "skylight_delete_list_items"],
  calendar: ["skylight_list_events", "skylight_create_event", "skylight_update_event", "skylight_delete_event"],
  meals: ["skylight_list_meal_categories", "skylight_update_meal_category", "skylight_list_meals", "skylight_plan_meal", "skylight_update_meal", "skylight_delete_meal", "skylight_list_recipes", "skylight_get_recipe", "skylight_create_recipe", "skylight_update_recipe", "skylight_delete_recipe", "skylight_add_recipe_to_grocery_list"],
  photos: ["skylight_list_photos", "skylight_update_photo_caption", "skylight_delete_photos", "skylight_list_albums", "skylight_create_album", "skylight_rename_album", "skylight_delete_album", "skylight_add_photos_to_album", "skylight_remove_photos_from_album"],
  devices: ["skylight_list_devices", "skylight_update_device", "skylight_set_device_sleep", "skylight_reset_device", "skylight_remove_device"],
  frame: [],
  account: [],
};

const AUTH = "skylight_auth_status";

async function registered(env: Record<string, string>): Promise<string[]> {
  const t = await connectTestClient([], { env });
  try { return (await t.client.listTools()).tools.map((x) => x.name).sort(); } finally { await t.close(); }
}

test("by default every toolset is registered, plus skylight_auth_status", async () => {
  const expected = [AUTH, ...TOOLSETS.flatMap((s) => TOOLS_BY_TOOLSET[s])].sort();
  assert.deepEqual(await registered({}), expected);
});

test("SKYLIGHT_TOOLSETS registers only the named groups, and skylight_auth_status always", async () => {
  assert.deepEqual(await registered({ SKYLIGHT_TOOLSETS: "chores" }), [AUTH, ...TOOLS_BY_TOOLSET.chores].sort());
  assert.deepEqual(await registered({ SKYLIGHT_TOOLSETS: "lists, Calendar" }), [AUTH, ...TOOLS_BY_TOOLSET.lists, ...TOOLS_BY_TOOLSET.calendar].sort());
});

test("each toolset on its own registers exactly its tools", async () => {
  for (const toolset of TOOLSETS) {
    assert.deepEqual(await registered({ SKYLIGHT_TOOLSETS: toolset }), [AUTH, ...TOOLS_BY_TOOLSET[toolset]].sort(), toolset);
  }
});

test("the toolsets partition the tool list: no tool belongs to two groups", () => {
  const all = TOOLSETS.flatMap((s) => TOOLS_BY_TOOLSET[s]);
  assert.equal(new Set(all).size, all.length);
  assert.ok(!all.includes(AUTH));
});

test("an unknown toolset stops the server from starting, naming the toolset", async () => {
  await assert.rejects(() => connectTestClient([], { env: { SKYLIGHT_TOOLSETS: "chores,gizmos" } }), (e: unknown) => e instanceof ValidationError && e.field === "SKYLIGHT_TOOLSETS" && /"gizmos"/.test(e.message));
});
