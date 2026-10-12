import { test } from "node:test";
import assert from "node:assert/strict";
import { connectTestClient } from "../helpers/test-server.js";
import type { MockRoute } from "../helpers/mock-fetch.js";

const FRAMES: MockRoute = { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77" }] } };
const CATEGORIES: MockRoute = { method: "GET", path: "/api/frames/77/categories", json: { data: [{ id: "12", attributes: { label: "Ellie" } }] } };

test("get reward points maps balances", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "GET", path: "/api/frames/77/reward_points", json: { data: [{ id: "1", attributes: { category_id: 12, points: 40 } }, { id: "2", attributes: { category_id: 99, points: 3 } }] } }]);
  const r = await t.callTool("skylight_get_reward_points");
  assert.deepEqual(r.data, [{ profileId: "12", name: "Ellie", points: 40 }, { profileId: "99", name: null, points: 3 }]);
  await t.close();
});

test("add reward points posts category_ids and points, then re-reads balances with names", async () => {
  const t = await connectTestClient([
    FRAMES, CATEGORIES,
    { method: "POST", path: "/api/frames/77/reward_points", json: { data: [{ id: "1", attributes: { category_id: 12, points: 1 } }] } },
    { method: "GET", path: "/api/frames/77/reward_points", json: { data: [{ id: "1", attributes: { category_id: 12, points: 45 } }] } },
  ]);
  const r = await t.callTool("skylight_add_reward_points", { profileIds: ["12"], points: 5 });
  assert.equal(r.isError, false);
  const rewardCalls = t.calls.filter((c) => c.url.pathname === "/api/frames/77/reward_points");
  assert.deepEqual(rewardCalls.map((c) => c.method), ["POST", "GET"]);
  assert.deepEqual(rewardCalls[0]!.body, { category_ids: ["12"], points: 5 });
  assert.deepEqual(r.data, [{ profileId: "12", name: "Ellie", points: 45 }]);
  const bad = await t.callTool("skylight_add_reward_points", { profileIds: ["12"], points: 99999 });
  assert.equal(bad.isError, true);
  assert.equal(t.calls.filter((c) => c.method === "POST").length, 1);
  await t.close();
});

test("add reward points is annotated non-idempotent; get is read-only", async () => {
  const t = await connectTestClient([FRAMES]);
  const tools = (await t.client.listTools()).tools;
  const add = tools.find((x) => x.name === "skylight_add_reward_points")!;
  assert.equal(add.annotations?.idempotentHint, false);
  assert.equal(add.annotations?.destructiveHint, true);
  assert.equal(tools.find((x) => x.name === "skylight_get_reward_points")!.annotations?.readOnlyHint, true);
  assert.match(add.description ?? "", /skylight_list_profiles/);
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
