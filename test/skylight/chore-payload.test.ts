import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChoreCreateBody, buildChoreUpdateBody } from "../../src/skylight/chore-payload.js";
import { ValidationError } from "../../src/skylight/errors.js";

test("minimal chore body matches Skylight create_multiple shape", () => {
  assert.deepEqual(buildChoreCreateBody({ summary: " Feed dog ", start: "2026-10-13", profileIds: ["12"] }), {
    summary: "Feed dog", start: "2026-10-13", start_time: null, routine: false, up_for_grabs: false,
    recurrence_set: null, recurring_until: null, category_ids: ["12"], reward_points: null, emoji_icon: null,
  });
});

test("full routine body", () => {
  const b = buildChoreCreateBody({
    summary: "Brush teeth", start: "2026-10-13", profileIds: ["12", "13"], startTime: "07:15",
    recurrence: { frequency: "weekly", weekdays: ["MO", "TU"], until: "2026-12-31" }, routine: true, rewardPoints: 5, emoji: "🪥",
  });
  assert.equal(b.start_time, "07:15");
  assert.equal(b.routine, true);
  assert.deepEqual(b.recurrence_set, ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU;UNTIL=20261231"]);
  assert.equal(b.recurring_until, "2026-12-31");
  assert.deepEqual(b.category_ids, ["12", "13"]);
  assert.equal(b.reward_points, 5);
  assert.equal(b.emoji_icon, "🪥");
});

test("validation failures name the field", () => {
  const base = { summary: "x", start: "2026-10-13", profileIds: ["1"] };
  for (const [patch, field] of [
    [{ profileIds: [] }, "profileIds"], [{ profileIds: ["1", "1"] }, "profileIds"], [{ profileIds: ["../"] }, "profileIds"],
    [{ start: "2026-13-01" }, "start"], [{ startTime: "7:00" }, "startTime"], [{ rewardPoints: 1.5 }, "rewardPoints"],
    [{ emoji: "ab cd" }, "emoji"], [{ summary: "" }, "summary"],
  ] as const) {
    assert.throws(() => buildChoreCreateBody({ ...base, ...patch } as never), (e: unknown) => e instanceof ValidationError && e.field === field);
  }
});

test("update body contains only provided keys and rejects empty", () => {
  assert.deepEqual(buildChoreUpdateBody({ summary: "New", rewardPoints: 3 }), { summary: "New", reward_points: 3 });
  assert.deepEqual(buildChoreUpdateBody({ recurrence: { frequency: "daily" } }), { recurrence_set: ["RRULE:FREQ=DAILY"], recurring_until: null });
  assert.throws(() => buildChoreUpdateBody({}), ValidationError);
});
