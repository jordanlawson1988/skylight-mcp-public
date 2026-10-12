import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectTestClient } from "../helpers/test-server.js";
import type { MockRoute } from "../helpers/mock-fetch.js";

const FRAMES: MockRoute = { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77" }] } };
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
const CATEGORIES: MockRoute = { method: "GET", path: "/api/frames/77/categories", json: { data: [{ id: "12", attributes: { label: "Ellie", linked_to_profile: true } }, { id: "14", attributes: { label: "Birthdays", linked_to_profile: false } }] } };
const pts = (id: number | string, balance: number, lifetime = balance) => ({ category_id: id, current_point_balance: balance, lifetime_points_earned: lifetime });

test("get reward points maps balances", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "GET", path: "/api/frames/77/reward_points", json: [pts(12, 40, 100), pts(14, 0), pts(99, 3)] }]);
  const r = await t.callTool("skylight_get_reward_points");
  assert.deepEqual(r.data, [
    { profileId: "12", name: "Ellie", kind: "profile", points: 40, lifetimePoints: 100 },
    { profileId: "14", name: "Birthdays", kind: "label", points: 0, lifetimePoints: 0 },
    { profileId: "99", name: null, kind: null, points: 3, lifetimePoints: 3 },
  ]);
  await t.close();
});

test("get reward points against the live fixtures returns every category with names and kinds", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/categories", json: fixture("categories") }, { method: "GET", path: "/api/frames/77/reward_points", json: fixture("reward_points") }]);
  const r = await t.callTool("skylight_get_reward_points");
  const d = r.data as Array<{ profileId: string; name: string; kind: string; points: number; lifetimePoints: number }>;
  assert.equal(d.length, 7);
  assert.deepEqual(d.find((x) => x.profileId === "15057970"), { profileId: "15057970", name: "Kid C", kind: "profile", points: 16, lifetimePoints: 56 });
  assert.equal(d.find((x) => x.name === "Birthdays")!.kind, "label");
  await t.close();
});

test("add reward points posts category_ids and points, then re-reads balances with names", async () => {
  const t = await connectTestClient([
    FRAMES, CATEGORIES,
    { method: "POST", path: "/api/frames/77/reward_points", json: { data: [] } },
    { method: "GET", path: "/api/frames/77/reward_points", json: [pts(12, 45, 45)] },
  ]);
  const r = await t.callTool("skylight_add_reward_points", { profileIds: ["12"], points: 5 });
  assert.equal(r.isError, false);
  const rewardCalls = t.calls.filter((c) => c.url.pathname === "/api/frames/77/reward_points");
  assert.deepEqual(rewardCalls.map((c) => c.method), ["POST", "GET"]);
  assert.deepEqual(rewardCalls[0]!.body, { category_ids: ["12"], points: 5 });
  assert.deepEqual(r.data, { added: { profileIds: ["12"], points: 5 }, balances: [{ profileId: "12", name: "Ellie", kind: "profile", points: 45, lifetimePoints: 45 }] });
  const bad = await t.callTool("skylight_add_reward_points", { profileIds: ["12"], points: 99999 });
  assert.equal(bad.isError, true);
  assert.equal(t.calls.filter((c) => c.method === "POST").length, 1);
  await t.close();
});

test("add reward points: failed re-read after a successful POST is not an error and says not to retry", async () => {
  const t = await connectTestClient([
    FRAMES, CATEGORIES,
    { method: "POST", path: "/api/frames/77/reward_points", json: { data: [] } },
    { method: "GET", path: "/api/frames/77/reward_points", status: 500, text: "boom" },
  ]);
  const r = await t.callTool("skylight_add_reward_points", { profileIds: ["12"], points: 5 });
  assert.equal(r.isError, false);
  const d = r.data as { added: unknown; balances: unknown; warning?: string };
  assert.deepEqual(d.added, { profileIds: ["12"], points: 5 });
  assert.equal(d.balances, null);
  assert.match(d.warning ?? "", /Do not retry the add/);
  assert.equal(t.calls.filter((c) => c.method === "POST").length, 1);
  await t.close();
});

test("balances fall back to null names when the profile lookup fails", async () => {
  const t = await connectTestClient([
    FRAMES,
    { method: "GET", path: "/api/frames/77/categories", status: 500, text: "boom" },
    { method: "GET", path: "/api/frames/77/reward_points", json: [pts(12, 40)] },
  ]);
  const r = await t.callTool("skylight_get_reward_points");
  assert.equal(r.isError, false);
  assert.deepEqual(r.data, [{ profileId: "12", name: null, kind: null, points: 40, lifetimePoints: 40 }]);
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
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/rewards", json: fixture("rewards") }]);
  const r = await t.callTool("skylight_list_rewards");
  const d = r.data as Array<{ title: string; cost: number | null; respawnOnRedemption: boolean }>;
  assert.deepEqual(d.map((x) => [x.title, x.cost, x.respawnOnRedemption]), [["Reward 1", 400, true], ["Reward 2", 250, true]]);
  await t.close();
});

test("add reward points refuses a label (Birthdays) and sends no POST", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: "/api/frames/77/reward_points", json: { data: [] } }]);
  const r = await t.callTool("skylight_add_reward_points", { profileIds: ["12", "14"], points: 5 });
  assert.equal(r.isError, true);
  assert.match(r.text, /profileIds: 14 \(Birthdays\) is a label, not a person profile/);
  const unknown = await t.callTool("skylight_add_reward_points", { profileIds: ["999"], points: 5 });
  assert.match(unknown.text, /999 is not a profile on this frame/);
  assert.equal(t.calls.filter((c) => c.method === "POST").length, 0);
  await t.close();
});

test("add reward points still posts when the categories lookup fails", async () => {
  const t = await connectTestClient([
    FRAMES,
    { method: "GET", path: "/api/frames/77/categories", status: 500, text: "boom" },
    { method: "POST", path: "/api/frames/77/reward_points", json: { data: [] } },
    { method: "GET", path: "/api/frames/77/reward_points", json: [pts(12, 5)] },
  ]);
  const r = await t.callTool("skylight_add_reward_points", { profileIds: ["12"], points: 5 });
  assert.equal(r.isError, false);
  assert.equal(t.calls.filter((c) => c.method === "POST").length, 1);
  await t.close();
});

test("add reward points still posts when the categories response has no profiles", async () => {
  for (const json of [{ data: [] }, {}]) {
    const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/categories", json }, { method: "POST", path: "/api/frames/77/reward_points", json: { data: [] } }, { method: "GET", path: "/api/frames/77/reward_points", json: [pts(12, 5)] }]);
    const r = await t.callTool("skylight_add_reward_points", { profileIds: ["12"], points: 5 });
    assert.equal(r.isError, false);
    assert.equal(t.calls.filter((c) => c.method === "POST").length, 1);
    await t.close();
  }
});
