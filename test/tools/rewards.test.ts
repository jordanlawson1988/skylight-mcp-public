import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectTestClient } from "../helpers/test-server.js";
import type { MockRoute, RecordedCall } from "../helpers/mock-fetch.js";

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

// ---- Phase 2: reward management ----
const rewardRes = (id: string, over: Record<string, unknown> = {}, profile = "12") => ({
  id, type: "reward",
  attributes: { name: "Ice cream", emoji_icon: null, description: null, point_value: 4, respawn_on_redemption: false, redeemed_at: null, origin: "user", ...over },
  relationships: { category: { data: { id: profile, type: "category" } } },
});
const writes = (t: { calls: RecordedCall[] }) => t.calls.filter((c) => c.method !== "GET");

test("list rewards maps profileId, respawnOnRedemption and redeemed; no second request by default", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/rewards", json: fixture("rewards") }]);
  const r = await t.callTool("skylight_list_rewards");
  const d = r.data as Array<{ profileId: string; respawnOnRedemption: boolean; redeemed: boolean }>;
  assert.deepEqual(d.map((x) => [x.profileId, x.respawnOnRedemption, x.redeemed]), [["15057920", true, false], ["15057970", true, false]]);
  assert.equal(t.calls.filter((c) => c.url.pathname.endsWith("/rewards")).length, 1);
  assert.equal(t.calls.at(-1)!.url.searchParams.has("redeemed_at_min"), false);
  await t.close();
});

test("list rewards includeRedeemed makes a second request with redeemed_at_min and merges without duplicates", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/rewards", handler: ({ url }) => url.searchParams.has("redeemed_at_min")
    ? { json: { data: [rewardRes("2", { redeemed_at: "2026-10-01T10:00:00Z" }), rewardRes("1")] } }
    : { json: { data: [rewardRes("1"), rewardRes("3")] } } }]);
  const r = await t.callTool("skylight_list_rewards", { includeRedeemed: true });
  const d = r.data as Array<{ id: string; redeemed: boolean }>;
  assert.deepEqual(d.map((x) => [x.id, x.redeemed]), [["1", false], ["3", false], ["2", true]]);
  const gets = t.calls.filter((c) => c.url.pathname === "/api/frames/77/rewards");
  assert.equal(gets.length, 2);
  assert.equal(gets[1]!.url.searchParams.get("redeemed_at_min"), "1970-01-01T00:00:00Z");
  await t.close();
});

test("create reward posts the verified body once and returns every reward created", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: "/api/frames/77/rewards", json: { data: [rewardRes("9", { name: "Movie night", point_value: 50, respawn_on_redemption: true }, "12")] } }]);
  const r = await t.callTool("skylight_create_reward", { title: " Movie night ", cost: 50, profileIds: ["12"], emoji: "🎬", description: "Pick the film" });
  assert.equal(r.isError, false);
  const post = t.calls.filter((c) => c.method === "POST");
  assert.equal(post.length, 1);
  assert.equal(post[0]!.url.pathname, "/api/frames/77/rewards");
  assert.deepEqual(post[0]!.body, { name: "Movie night", point_value: 50, emoji_icon: "🎬", description: "Pick the film", respawn_on_redemption: true, category_ids: ["12"] });
  const d = r.data as { created: number; rewards: Array<{ id: string; profileId: string }> };
  assert.equal(d.created, 1);
  assert.deepEqual(d.rewards.map((x) => [x.id, x.profileId]), [["9", "12"]]);
  await t.close();
});

test("create reward sends null for omitted emoji and description and respects respawnOnRedemption false", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: "/api/frames/77/rewards", json: { data: [rewardRes("9")] } }]);
  await t.callTool("skylight_create_reward", { title: "Treat", cost: 4, profileIds: ["12"], respawnOnRedemption: false });
  assert.deepEqual(t.calls.find((c) => c.method === "POST")!.body, { name: "Treat", point_value: 4, emoji_icon: null, description: null, respawn_on_redemption: false, category_ids: ["12"] });
  await t.close();
});

test("create reward validates input and the label guard before any POST", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: "/api/frames/77/rewards", json: { data: [] } }]);
  for (const args of [
    { title: "  ", cost: 5, profileIds: ["12"] },
    { title: "x".repeat(101), cost: 5, profileIds: ["12"] },
    { title: "x", cost: 0, profileIds: ["12"] },
    { title: "x", cost: 100001, profileIds: ["12"] },
    { title: "x", cost: 1.5, profileIds: ["12"] },
    { title: "x", cost: 5, profileIds: [] },
    { title: "x", cost: 5, profileIds: ["12", "12"] },
    { title: "x", cost: 5, profileIds: ["12"], description: "d".repeat(501) },
    { title: "x", cost: 5, profileIds: ["12"], emoji: "two words" },
  ]) {
    assert.equal((await t.callTool("skylight_create_reward", args)).isError, true, JSON.stringify(args));
  }
  const label = await t.callTool("skylight_create_reward", { title: "x", cost: 5, profileIds: ["12", "14"] });
  assert.equal(label.isError, true);
  assert.match(label.text, /profileIds: 14 \(Birthdays\) is a label, not a person profile/);
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("create reward warns when Skylight returns no reward rows", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "POST", path: "/api/frames/77/rewards", json: { data: [] } }]);
  const r = await t.callTool("skylight_create_reward", { title: "x", cost: 5, profileIds: ["12"] });
  assert.equal(r.isError, false);
  const d = r.data as { created: number; warning?: string };
  assert.equal(d.created, 0);
  assert.match(d.warning ?? "", /skylight_list_rewards/);
  await t.close();
});

test("update reward PATCHes only the provided fields, with category_id singular", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "PATCH", path: "/api/frames/77/rewards/9", json: { data: rewardRes("9", { point_value: 3 }) } }]);
  const r = await t.callTool("skylight_update_reward", { rewardId: "9", cost: 3, title: "Sundae", profileId: "12", respawnOnRedemption: true, emoji: "🍨", description: "Two scoops" });
  assert.equal(r.isError, false);
  const patch = t.calls.find((c) => c.method === "PATCH")!;
  assert.deepEqual(patch.body, { name: "Sundae", point_value: 3, emoji_icon: "🍨", description: "Two scoops", respawn_on_redemption: true, category_id: "12" });
  assert.equal((r.data as { cost: number }).cost, 3);
  const only = await t.callTool("skylight_update_reward", { rewardId: "9", cost: 7 });
  assert.equal(only.isError, false);
  assert.deepEqual(t.calls.filter((c) => c.method === "PATCH").at(-1)!.body, { point_value: 7 });
  await t.close();
});

test("update reward: nothing to change, bad id, bad cost and label profile all fail before a PATCH", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES, { method: "PATCH", path: /\/rewards\//, json: { data: rewardRes("9") } }]);
  assert.equal((await t.callTool("skylight_update_reward", { rewardId: "9" })).isError, true);
  assert.equal((await t.callTool("skylight_update_reward", { rewardId: "../9", cost: 3 })).isError, true);
  assert.equal((await t.callTool("skylight_update_reward", { rewardId: "9", cost: 0 })).isError, true);
  const label = await t.callTool("skylight_update_reward", { rewardId: "9", profileId: "14" });
  assert.match(label.text, /profileId: 14 \(Birthdays\) is a label/);
  assert.equal(writes(t).length, 0);
  await t.close();
});

const REDEEM_ROUTES = (post: MockRoute): MockRoute[] => [
  FRAMES, CATEGORIES,
  { method: "GET", path: "/api/frames/77/rewards/9", json: { data: rewardRes("9", { point_value: 4 }) } },
  { method: "GET", path: "/api/frames/77/reward_points", json: [pts(12, 10)] },
  post,
];

test("redeem without confirm previews with balance and sends no POST", async () => {
  const t = await connectTestClient(REDEEM_ROUTES({ method: "POST", path: "/api/frames/77/rewards/9/redeem", json: {} }));
  const r = await t.callTool("skylight_redeem_reward", { rewardId: "9" });
  assert.equal(r.isError, false);
  const d = r.data as { confirmed: boolean; wouldRedeem: Record<string, unknown>; message: string };
  assert.equal(d.confirmed, false);
  assert.deepEqual(d.wouldRedeem, { id: "9", title: "Ice cream", cost: 4, profileId: "12", profileName: "Ellie", currentPoints: 10 });
  assert.match(d.message, /Nothing was redeemed/);
  assert.match(d.message, /covers/);
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("redeem preview says when the balance does not cover the cost", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES,
    { method: "GET", path: "/api/frames/77/rewards/9", json: { data: rewardRes("9", { point_value: 40 }) } },
    { method: "GET", path: "/api/frames/77/reward_points", json: [pts(12, 10)] }]);
  const r = await t.callTool("skylight_redeem_reward", { rewardId: "9" });
  assert.match((r.data as { message: string }).message, /not enough points: 10 available, 40 needed/i);
  await t.close();
});

test("redeem with confirm posts without a body and returns the reward and the re-read balance", async () => {
  let reads = 0;
  const t = await connectTestClient([
    FRAMES, CATEGORIES,
    { method: "GET", path: "/api/frames/77/rewards/9", json: { data: rewardRes("9", { point_value: 4 }) } },
    { method: "GET", path: "/api/frames/77/reward_points", handler: () => ({ json: [pts(12, ++reads === 1 ? 10 : 6)] }) },
    { method: "POST", path: "/api/frames/77/rewards/9/redeem", json: { data: rewardRes("9", { point_value: 4, redeemed_at: "2026-10-12T20:00:00Z" }) } },
  ]);
  const r = await t.callTool("skylight_redeem_reward", { rewardId: "9", confirm: true });
  assert.equal(r.isError, false);
  const post = t.calls.filter((c) => c.method === "POST");
  assert.equal(post.length, 1);
  assert.equal(post[0]!.body, null);
  const d = r.data as { redeemed: boolean; reward: { id: string; redeemed: boolean }; balance: { profileId: string; points: number } };
  assert.equal(d.redeemed, true);
  assert.deepEqual([d.reward.id, d.reward.redeemed], ["9", true]);
  assert.deepEqual([d.balance.profileId, d.balance.points], ["12", 6]);
  await t.close();
});

test("redeem maps the server's Not enough points 400 to a validation error with numbers", async () => {
  const t = await connectTestClient(REDEEM_ROUTES({ method: "POST", path: "/api/frames/77/rewards/9/redeem", status: 400, json: { errors: ["Not enough points to redeem reward."] } }));
  const r = await t.callTool("skylight_redeem_reward", { rewardId: "9", confirm: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /^Invalid input\. rewardId: not enough points: 10 available, 4 needed/);
  await t.close();
});

test("redeem: other server errors pass through, and a failed balance re-read is a warning not an error", async () => {
  let n = 0;
  const t2 = await connectTestClient([
    FRAMES, CATEGORIES,
    { method: "GET", path: "/api/frames/77/rewards/9", json: { data: rewardRes("9") } },
    { method: "GET", path: "/api/frames/77/reward_points", handler: () => (++n === 1 ? { json: [pts(12, 10)] } : { status: 500, text: "boom" }) },
    { method: "POST", path: "/api/frames/77/rewards/9/redeem", json: {} },
  ]);
  const r = await t2.callTool("skylight_redeem_reward", { rewardId: "9", confirm: true });
  assert.equal(r.isError, false);
  const d = r.data as { redeemed: boolean; balance: unknown; warning?: string };
  assert.equal(d.redeemed, true);
  assert.equal(d.balance, null);
  assert.match(d.warning ?? "", /Do not retry/);
  await t2.close();
  const t3 = await connectTestClient(REDEEM_ROUTES({ method: "POST", path: "/api/frames/77/rewards/9/redeem", status: 500, text: "boom" }));
  const bad = await t3.callTool("skylight_redeem_reward", { rewardId: "9", confirm: true });
  assert.equal(bad.isError, true);
  assert.doesNotMatch(bad.text, /not enough points/i);
  await t3.close();
});

test("redeem refuses an already-redeemed reward and bad ids before any POST", async () => {
  const t = await connectTestClient([FRAMES, CATEGORIES,
    { method: "GET", path: "/api/frames/77/rewards/9", json: { data: rewardRes("9", { redeemed_at: "2026-10-01T10:00:00Z" }) } },
    { method: "GET", path: "/api/frames/77/reward_points", json: [pts(12, 10)] },
    { method: "POST", path: "/api/frames/77/rewards/9/redeem", json: {} }]);
  const r = await t.callTool("skylight_redeem_reward", { rewardId: "9", confirm: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /already redeemed/);
  assert.equal((await t.callTool("skylight_redeem_reward", { rewardId: "a/b", confirm: true })).isError, true);
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("unredeem posts to /unredeem and returns the reward", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/rewards/9/unredeem", json: { data: rewardRes("9") } }]);
  const r = await t.callTool("skylight_unredeem_reward", { rewardId: "9" });
  assert.equal(r.isError, false);
  assert.equal(writes(t).length, 1);
  assert.equal(writes(t)[0]!.url.pathname, "/api/frames/77/rewards/9/unredeem");
  assert.deepEqual([(r.data as { id: string }).id, (r.data as { redeemed: boolean }).redeemed], ["9", false]);
  const empty = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/rewards/9/unredeem", json: {} }]);
  assert.deepEqual((await empty.callTool("skylight_unredeem_reward", { rewardId: "9" })).data, { id: "9", unredeemed: true });
  await empty.close();
  await t.close();
});

test("delete reward without confirm previews and sends no DELETE; with confirm deletes", async () => {
  const t = await connectTestClient([FRAMES,
    { method: "GET", path: "/api/frames/77/rewards/9", json: { data: rewardRes("9") } },
    { method: "DELETE", path: "/api/frames/77/rewards/9", json: {} }]);
  const r = await t.callTool("skylight_delete_reward", { rewardId: "9" });
  const d = r.data as { confirmed: boolean; wouldDelete: Record<string, unknown>; message: string };
  assert.equal(d.confirmed, false);
  assert.deepEqual(d.wouldDelete, { id: "9", title: "Ice cream", cost: 4, profileId: "12", redeemed: false });
  assert.match(d.message, /Nothing was deleted/);
  assert.equal(writes(t).length, 0);
  const done = await t.callTool("skylight_delete_reward", { rewardId: "9", confirm: true });
  assert.deepEqual(done.data, { deleted: true, id: "9" });
  assert.equal(writes(t).length, 1);
  assert.equal(writes(t)[0]!.method, "DELETE");
  assert.equal((await t.callTool("skylight_delete_reward", { rewardId: "../9", confirm: true })).isError, true);
  assert.equal(writes(t).length, 1);
  await t.close();
});

test("reward tools are annotated: create/update/unredeem/delete/redeem", async () => {
  const t = await connectTestClient([FRAMES]);
  const tools = new Map((await t.client.listTools()).tools.map((x) => [x.name, x]));
  const a = (n: string) => tools.get(n)!.annotations!;
  assert.equal(a("skylight_create_reward").destructiveHint, false);
  assert.equal(a("skylight_update_reward").idempotentHint, true);
  assert.equal(a("skylight_unredeem_reward").idempotentHint, true);
  assert.deepEqual([a("skylight_redeem_reward").destructiveHint, a("skylight_redeem_reward").idempotentHint], [true, false]);
  assert.deepEqual([a("skylight_delete_reward").destructiveHint, a("skylight_delete_reward").idempotentHint], [true, false]);
  assert.match(tools.get("skylight_delete_reward")!.description ?? "", /confirm: true/);
  assert.match(tools.get("skylight_redeem_reward")!.description ?? "", /confirm: true/);
  await t.close();
});
