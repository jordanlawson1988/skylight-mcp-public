import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mapProfile, mapProfiles, mapChores, mapRewardPoints, mapRewards } from "../../src/skylight/types.js";

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
    { id: "7323341", title: "Reward 1", cost: 400, emoji: null, description: null, respawnOnRedemption: true, redeemedAt: null, profileIds: ["15057920"] },
    { id: "7323221", title: "Reward 2", cost: 250, emoji: null, description: null, respawnOnRedemption: true, redeemedAt: null, profileIds: ["15057970"] },
  ]);
  const one = mapRewards({ data: [{ id: "5", attributes: { name: "Ice cream", point_value: 0, emoji_icon: "🍦", description: "Treat", respawn_on_redemption: false, redeemed_at: "2026-10-01T10:00:00Z" } }] })[0]!;
  assert.equal(one.cost, 0);
  assert.equal(one.emoji, "🍦");
  assert.equal(one.respawnOnRedemption, false);
  assert.equal(one.redeemedAt, "2026-10-01T10:00:00Z");
  assert.equal(mapRewards({ data: [{ id: "6", attributes: { name: "No cost" } }] })[0]!.cost, null);
});
