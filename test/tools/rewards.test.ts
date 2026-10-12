import { test } from "node:test";
import assert from "node:assert/strict";
import { connectTestClient } from "../helpers/test-server.js";
import type { MockRoute } from "../helpers/mock-fetch.js";

const FRAMES: MockRoute = { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77" }] } };

test("get reward points maps balances", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/reward_points", json: { data: [{ id: "1", attributes: { category_id: 12, points: 40 } }] } }]);
  const r = await t.callTool("skylight_get_reward_points");
  assert.deepEqual(r.data, [{ profileId: "12", points: 40 }]);
  await t.close();
});

test("add reward points posts category_ids and points, rejects out-of-range", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/reward_points", json: { data: [{ id: "1", attributes: { category_id: 12, points: 45 } }] } }]);
  const r = await t.callTool("skylight_add_reward_points", { profileIds: ["12"], points: 5 });
  assert.equal(r.isError, false);
  assert.deepEqual(t.calls.at(-1)!.body, { category_ids: ["12"], points: 5 });
  const bad = await t.callTool("skylight_add_reward_points", { profileIds: ["12"], points: 99999 });
  assert.equal(bad.isError, true);
  await t.close();
});

test("add reward points rejects duplicate profile ids and sends no POST", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/reward_points", json: { data: [] } }]);
  const r = await t.callTool("skylight_add_reward_points", { profileIds: ["12", "12"], points: 5 });
  assert.equal(r.isError, true);
  assert.equal(t.calls.filter((c) => c.method === "POST").length, 0);
  await t.close();
});

test("list rewards maps", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/rewards", json: { data: [{ id: "5", attributes: { title: "Ice cream", reward_points: 50 } }] } }]);
  const r = await t.callTool("skylight_list_rewards");
  assert.equal((r.data as Array<{ title: string }>)[0]!.title, "Ice cream");
  await t.close();
});
