import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRrule, hourFromRrule } from "../../src/skylight/rrule.js";
import { ValidationError } from "../../src/skylight/errors.js";

test("daily, weekly with weekdays, monthly with monthDay", () => {
  assert.equal(buildRrule({ frequency: "daily" }), "RRULE:FREQ=DAILY");
  assert.equal(buildRrule({ frequency: "daily", interval: 2 }), "RRULE:FREQ=DAILY;INTERVAL=2");
  assert.equal(buildRrule({ frequency: "weekly", weekdays: ["MO", "WE", "FR"] }), "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR");
  assert.equal(buildRrule({ frequency: "monthly", monthDay: 15, until: "2026-12-31" }), "RRULE:FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20261231");
});

test("rejects mismatched options", () => {
  assert.throws(() => buildRrule({ frequency: "daily", weekdays: ["MO"] }), ValidationError);
  assert.throws(() => buildRrule({ frequency: "weekly", monthDay: 3 }), ValidationError);
  assert.throws(() => buildRrule({ frequency: "weekly", weekdays: [] }), ValidationError);
  assert.throws(() => buildRrule({ frequency: "weekly", weekdays: ["MO", "MO"] }), ValidationError);
  assert.throws(() => buildRrule({ frequency: "daily", interval: 0 }), ValidationError);
  assert.throws(() => buildRrule({ frequency: "daily", interval: 53 }), ValidationError);
  assert.throws(() => buildRrule({ frequency: "monthly", monthDay: 32 }), ValidationError);
  assert.throws(() => buildRrule({ frequency: "daily", until: "2026-02-30" }), ValidationError);
});

test("BYHOUR is appended for routine hours only, before UNTIL", () => {
  assert.equal(buildRrule({ frequency: "daily", hour: 6 }), "RRULE:FREQ=DAILY;BYHOUR=6");
  assert.equal(buildRrule({ frequency: "weekly", weekdays: ["MO", "WE"], hour: 20, until: "2026-12-31" }), "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=20;UNTIL=20261231");
  assert.throws(() => buildRrule({ frequency: "daily", hour: 7 as never }), ValidationError);
  assert.equal(buildRrule({ frequency: "daily" }), "RRULE:FREQ=DAILY");
});

test("hourFromRrule reads BYHOUR from a server rule", () => {
  assert.equal(hourFromRrule("RRULE:FREQ=WEEKLY;INTERVAL=1;WKST=SU;BYHOUR=6;BYDAY=MO,TU"), 6);
  assert.equal(hourFromRrule("RRULE:FREQ=DAILY;BYHOUR=20"), 20);
  assert.equal(hourFromRrule("RRULE:FREQ=DAILY"), null);
  assert.equal(hourFromRrule(null), null);
});
