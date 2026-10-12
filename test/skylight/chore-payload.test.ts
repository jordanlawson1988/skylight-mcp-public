import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChoreCreateBody, buildChoreUpdateBody } from "../../src/skylight/chore-payload.js";
import { ValidationError } from "../../src/skylight/errors.js";

test("minimal chore body matches Skylight create_multiple shape", () => {
  assert.deepEqual(buildChoreCreateBody({ summary: " Feed dog ", start: "2026-10-13", profileIds: ["12"] }), {
    summary: "Feed dog", start: "2026-10-13", start_time: null, routine: false, up_for_grabs: false,
    recurrence_set: null, recurring_until: null, category_ids: ["12"], reward_points: null, emoji_icon: null,
    description: null, timer_seconds: null,
  });
});

test("full routine body: blank start_time and BYHOUR from timeOfDay", () => {
  const b = buildChoreCreateBody({
    summary: "Brush teeth", start: "2026-10-13", profileIds: ["12", "13"], timeOfDay: "morning",
    recurrence: { frequency: "weekly", weekdays: ["MO", "TU"], until: "2026-12-31" }, routine: true, rewardPoints: 5, emoji: "🪥",
  });
  assert.equal(b.start_time, null);
  assert.equal(b.routine, true);
  assert.deepEqual(b.recurrence_set, ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU;BYHOUR=6;UNTIL=20261231"]);
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

const routineBase = { summary: "Brush", start: "2026-10-13", profileIds: ["1"], routine: true };

test("routine slots map to BYHOUR 6/14/20 and recurrence defaults to daily", () => {
  for (const [slot, hour] of [["morning", 6], ["afternoon", 14], ["evening", 20]] as const) {
    const b = buildChoreCreateBody({ ...routineBase, timeOfDay: slot });
    assert.deepEqual(b.recurrence_set, [`RRULE:FREQ=DAILY;BYHOUR=${hour}`]);
    assert.equal(b.start_time, null);
    assert.equal(b.recurring_until, null);
  }
});

test("routine validation: timeOfDay required, startTime forbidden, timeOfDay only for routines", () => {
  assert.throws(() => buildChoreCreateBody({ ...routineBase }), (e: unknown) => e instanceof ValidationError && /routine steps need timeOfDay: morning, afternoon or evening/.test(e.message));
  assert.throws(() => buildChoreCreateBody({ ...routineBase, timeOfDay: "morning", startTime: "06:00" }), (e: unknown) => e instanceof ValidationError && e.field === "startTime" && /routines use timeOfDay, not startTime/.test(e.message));
  assert.throws(() => buildChoreCreateBody({ summary: "x", start: "2026-10-13", profileIds: ["1"], timeOfDay: "morning" }), /timeOfDay is only for routine steps/);
  assert.throws(() => buildChoreCreateBody({ summary: "x", start: "2026-10-13", profileIds: ["1"], routine: false, timeOfDay: "evening" }), /timeOfDay is only for routine steps/);
  assert.throws(() => buildChoreCreateBody({ ...routineBase, timeOfDay: "noon" as never }), ValidationError);
});

test("non-routine chores never carry BYHOUR", () => {
  assert.throws(() => buildChoreCreateBody({ summary: "x", start: "2026-10-13", profileIds: ["1"], recurrence: { frequency: "daily", hour: 6 } }), (e: unknown) => e instanceof ValidationError && e.field === "recurrence.hour");
  const b = buildChoreCreateBody({ summary: "x", start: "2026-10-13", profileIds: ["1"], startTime: "07:00", recurrence: { frequency: "daily" } });
  assert.deepEqual(b.recurrence_set, ["RRULE:FREQ=DAILY"]);
});

test("update applies the routine rules only to the fields passed", () => {
  assert.deepEqual(buildChoreUpdateBody({ routine: true, timeOfDay: "evening" }), { routine: true, recurrence_set: ["RRULE:FREQ=DAILY;BYHOUR=20"], recurring_until: null });
  assert.deepEqual(buildChoreUpdateBody({ timeOfDay: "afternoon", recurrence: { frequency: "weekly", weekdays: ["MO"] } }), { recurrence_set: ["RRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=14"], recurring_until: null });
  assert.throws(() => buildChoreUpdateBody({ routine: true }), /routine steps need timeOfDay/);
  assert.throws(() => buildChoreUpdateBody({ routine: true, timeOfDay: "morning", startTime: "06:00" }), /routines use timeOfDay, not startTime/);
  assert.throws(() => buildChoreUpdateBody({ routine: false, timeOfDay: "morning" }), /timeOfDay is only for routine steps/);
  assert.throws(() => buildChoreUpdateBody({ timeOfDay: "morning", startTime: "06:00" }), /routines use timeOfDay/);
  assert.throws(() => buildChoreUpdateBody({ timeOfDay: "morning" }), (e: unknown) => e instanceof ValidationError && e.field === "recurrence");
  assert.deepEqual(buildChoreUpdateBody({ startTime: "08:00" }), { start_time: "08:00" });
});

test("up-for-grabs chores may omit start and profileIds; others may not", () => {
  const b = buildChoreCreateBody({ summary: "Wash car", upForGrabs: true });
  assert.equal(b.start, null);
  assert.deepEqual(b.category_ids, []);
  assert.equal(b.up_for_grabs, true);
  const dated = buildChoreCreateBody({ summary: "Wash car", upForGrabs: true, start: "2026-10-13" });
  assert.equal(dated.start, "2026-10-13");
  assert.deepEqual(buildChoreCreateBody({ summary: "x", upForGrabs: true, profileIds: ["3"] }).category_ids, ["3"]);
  assert.throws(() => buildChoreCreateBody({ summary: "x", profileIds: ["1"] }), (e: unknown) => e instanceof ValidationError && e.field === "start");
  assert.throws(() => buildChoreCreateBody({ summary: "x", start: "2026-10-13" }), (e: unknown) => e instanceof ValidationError && e.field === "profileIds");
  assert.throws(() => buildChoreCreateBody({ summary: "x", start: "2026-10-13", upForGrabs: false }), (e: unknown) => e instanceof ValidationError && e.field === "profileIds");
});

test("description and timerSeconds are validated and sent on create and update", () => {
  const b = buildChoreCreateBody({ summary: "x", start: "2026-10-13", profileIds: ["1"], description: "  Use the blue sponge ", timerSeconds: 300 });
  assert.equal(b.description, "Use the blue sponge");
  assert.equal(b.timer_seconds, 300);
  assert.deepEqual(buildChoreUpdateBody({ description: "Hi", timerSeconds: 0 }), { description: "Hi", timer_seconds: 0 });
  for (const [patch, field] of [[{ description: "" }, "description"], [{ description: "x".repeat(501) }, "description"], [{ timerSeconds: -1 }, "timerSeconds"], [{ timerSeconds: 86401 }, "timerSeconds"], [{ timerSeconds: 1.5 }, "timerSeconds"]] as const) {
    assert.throws(() => buildChoreCreateBody({ summary: "x", start: "2026-10-13", profileIds: ["1"], ...patch }), (e: unknown) => e instanceof ValidationError && e.field === field);
  }
  assert.equal(buildChoreCreateBody({ summary: "x", start: "2026-10-13", profileIds: ["1"], timerSeconds: 86400 }).timer_seconds, 86400);
});

test("update null clears nullable fields", () => {
  assert.deepEqual(
    buildChoreUpdateBody({ startTime: null, emoji: null, rewardPoints: null, description: null, timerSeconds: null, recurrence: null }),
    { start_time: null, emoji_icon: null, reward_points: null, description: null, timer_seconds: null, recurrence_set: null, recurring_until: null },
  );
  assert.deepEqual(buildChoreUpdateBody({ rewardPoints: null }), { reward_points: null });
  assert.deepEqual(buildChoreUpdateBody({ rewardPoints: 0 }), { reward_points: 0 });
});

test("update null still respects routine rules", () => {
  assert.deepEqual(buildChoreUpdateBody({ routine: true, timeOfDay: "morning", startTime: null }), { start_time: null, routine: true, recurrence_set: ["RRULE:FREQ=DAILY;BYHOUR=6"], recurring_until: null });
  assert.throws(() => buildChoreUpdateBody({ routine: true, timeOfDay: "morning", recurrence: null }), (e: unknown) => e instanceof ValidationError && e.field === "recurrence");
  assert.throws(() => buildChoreUpdateBody({ timeOfDay: "morning", recurrence: null }), (e: unknown) => e instanceof ValidationError && e.field === "recurrence");
});
