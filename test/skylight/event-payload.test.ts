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
  const body = buildEventCreateBody({ title: "x", profileIds: ["1"], startsAt: "2026-10-12T18:30:00.000-04:00", timezone: "America/New_York" });
  assert.deepEqual([body.starts_at, body.ends_at], ["2026-10-12T18:30:00.000-04:00", "2026-10-12T19:30:00.000-04:00"]);
});
