import { test } from "node:test";
import assert from "node:assert/strict";
import { addHoursKeepingOffset, buildEventCreateBody } from "../../src/skylight/event-payload.js";

test("addHoursKeepingOffset keeps the offset and any fractional seconds", () => {
  assert.equal(addHoursKeepingOffset("2026-10-12T18:30:00-04:00", 1), "2026-10-12T19:30:00-04:00");
  assert.equal(addHoursKeepingOffset("2026-10-12T18:30:00.000-04:00", 1), "2026-10-12T19:30:00.000-04:00");
  assert.equal(addHoursKeepingOffset("2026-10-12T23:30:00.5+05:30", 1), "2026-10-13T00:30:00.5+05:30");
  assert.equal(addHoursKeepingOffset("2026-10-12T22:30Z", 1), "2026-10-12T23:30:00Z");
});

test("a listed startsAt with milliseconds round-trips through create, with the end defaulting to +1h", () => {
  const body = buildEventCreateBody({ title: "x", profileIds: ["1"], startsAt: "2026-10-12T18:30:00.000-04:00", timezone: "America/New_York" }, "America/New_York");
  assert.deepEqual([body.starts_at, body.ends_at], ["2026-10-12T18:30:00.000-04:00", "2026-10-12T19:30:00.000-04:00"]);
});

test("a bare startsAt is read in the configured zone; the end defaults to +1h on the resulting offset", () => {
  const winter = buildEventCreateBody({ title: "x", profileIds: ["1"], startsAt: "2026-01-12T18:30" }, "America/New_York");
  assert.deepEqual([winter.starts_at, winter.ends_at, winter.timezone], ["2026-01-12T18:30:00-05:00", "2026-01-12T19:30:00-05:00", "America/New_York"]);
  const summer = buildEventCreateBody({ title: "x", profileIds: ["1"], startsAt: "2026-07-12T18:30", endsAt: "2026-07-12T20:00:00" }, "America/New_York");
  assert.deepEqual([summer.starts_at, summer.ends_at], ["2026-07-12T18:30:00-04:00", "2026-07-12T20:00:00-04:00"]);
  const london = buildEventCreateBody({ title: "x", profileIds: ["1"], startsAt: "2026-07-12T18:30" }, "Europe/London");
  assert.equal(london.starts_at, "2026-07-12T18:30:00+01:00");
});
