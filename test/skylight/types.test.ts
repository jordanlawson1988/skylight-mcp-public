import { test } from "node:test";
import assert from "node:assert/strict";
import { mapProfiles, mapChores, mapRewardPoints, mapRewards } from "../../src/skylight/types.js";

test("mapProfiles reads JSON:API categories", () => {
  const out = mapProfiles({ data: [
    { id: "12", type: "category", attributes: { label: "Ellie", color: "#ff0000", profile_type: "child" } },
    { id: 13, type: "category", attributes: { name: "Jordan", color: null, adult: true } },
  ] });
  assert.deepEqual(out, [
    { id: "12", name: "Ellie", color: "#ff0000", isAdult: false },
    { id: "13", name: "Jordan", color: null, isAdult: true },
  ]);
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
  assert.deepEqual(out[0], { id: "900", summary: "Dishes", start: "2026-10-13", startTime: "18:00", status: "pending", routine: false, recurring: true, recurrenceRule: "RRULE:FREQ=DAILY", rewardPoints: 2, emoji: "🍽️", profileIds: ["12"], seriesId: "900", instanceDate: "2026-10-13" });
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

test("mappers tolerate missing data and skip malformed items", () => {
  assert.deepEqual(mapChores({}), []);
  assert.deepEqual(mapProfiles({ data: [{ attributes: {} }] }), []);
});

test("mapRewardPoints and mapRewards", () => {
  assert.deepEqual(mapRewardPoints({ data: [{ id: "1", attributes: { category_id: 12, points: 40 } }, { id: "2", attributes: { category_id: "13", points: "7" } }] }),
    [{ profileId: "12", points: 40 }, { profileId: "13", points: 7 }]);
  assert.deepEqual(mapRewards({ data: [{ id: "5", attributes: { title: "Ice cream", reward_points: 50, emoji_icon: "🍦", redeemed_at: null }, relationships: { categories: { data: [{ id: "12" }] } } }] }),
    [{ id: "5", title: "Ice cream", cost: 50, emoji: "🍦", redeemedAt: null, profileIds: ["12"] }]);
});
