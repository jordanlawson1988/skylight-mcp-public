import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, exclusiveDateMax, formatHuman, formatOffsetDateTime, offsetMinutesAt, parseInstant, todayIn, toOffsetDateTime } from "../../src/skylight/time.js";
import { ValidationError } from "../../src/skylight/errors.js";

const NY = "America/New_York";

test("offsetMinutesAt follows DST: EST in January, EDT in July, 0 for UTC, half hours for Kolkata", () => {
  assert.equal(offsetMinutesAt(Date.parse("2026-01-15T12:00:00Z"), NY), -300);
  assert.equal(offsetMinutesAt(Date.parse("2026-07-15T12:00:00Z"), NY), -240);
  assert.equal(offsetMinutesAt(Date.parse("2026-07-15T12:00:00Z"), "UTC"), 0);
  assert.equal(offsetMinutesAt(Date.parse("2026-07-15T12:00:00Z"), "Asia/Kolkata"), 330);
});

test("formatOffsetDateTime renders an instant in the zone with an explicit offset and no milliseconds", () => {
  assert.equal(formatOffsetDateTime("2026-10-12T22:30:00.000Z", NY), "2026-10-12T18:30:00-04:00");
  assert.equal(formatOffsetDateTime("2026-01-12T22:30:00Z", NY), "2026-01-12T17:30:00-05:00");
  assert.equal(formatOffsetDateTime("2026-10-12T18:30:00.000-04:00", NY), "2026-10-12T18:30:00-04:00");
  assert.equal(formatOffsetDateTime("2026-10-12T22:30:00Z", "Asia/Kolkata"), "2026-10-13T04:00:00+05:30");
  assert.equal(formatOffsetDateTime("2026-10-12T22:30:00Z", "UTC"), "2026-10-12T22:30:00+00:00");
});

test("formatOffsetDateTime leaves invalid input and bare dates unchanged", () => {
  for (const v of ["nope", "", "2026-10-12", "2026-13-40T10:00:00Z"]) assert.equal(formatOffsetDateTime(v, NY), v);
});

test("formatHuman: weekday, date, 12-hour time and zone abbreviation; all-day dates have no time", () => {
  assert.equal(formatHuman("2026-10-12T22:30:00.000Z", NY), "Mon Oct 12, 6:30 PM EDT");
  assert.equal(formatHuman("2026-01-12T22:30:00Z", NY), "Mon Jan 12, 5:30 PM EST");
  assert.equal(formatHuman("2026-10-12T00:05:00-04:00", NY), "Mon Oct 12, 12:05 AM EDT");
  assert.equal(formatHuman("2026-10-12", NY), "Mon Oct 12");
  assert.equal(formatHuman("garbage", NY), "garbage");
});

test("toOffsetDateTime reads a bare time as the zone's wall clock: EST in January, EDT in July", () => {
  assert.equal(toOffsetDateTime("2026-01-15T18:30", NY, "startsAt"), "2026-01-15T18:30:00-05:00");
  assert.equal(toOffsetDateTime("2026-07-15T18:30:00", NY, "startsAt"), "2026-07-15T18:30:00-04:00");
  assert.equal(toOffsetDateTime("2026-10-12T18:30", "Asia/Kolkata", "startsAt"), "2026-10-12T18:30:00+05:30");
});

test("toOffsetDateTime resolves bare times on both DST switch days", () => {
  // Spring forward 2026-03-08 at 02:00 local: before is EST, after is EDT.
  assert.equal(toOffsetDateTime("2026-03-08T01:00", NY, "f"), "2026-03-08T01:00:00-05:00");
  assert.equal(toOffsetDateTime("2026-03-08T03:30", NY, "f"), "2026-03-08T03:30:00-04:00");
  assert.equal(toOffsetDateTime("2026-03-08T12:00", NY, "f"), "2026-03-08T12:00:00-04:00");
  assert.equal(toOffsetDateTime("2026-03-07T23:59", NY, "f"), "2026-03-07T23:59:00-05:00");
  // Fall back 2026-11-01 at 02:00 local: 01:30 happens twice (first is EDT), 12:00 is EST.
  assert.equal(toOffsetDateTime("2026-11-01T00:30", NY, "f"), "2026-11-01T00:30:00-04:00");
  assert.equal(toOffsetDateTime("2026-11-01T01:30", NY, "f"), "2026-11-01T01:30:00-04:00");
  assert.equal(toOffsetDateTime("2026-11-01T12:00", NY, "f"), "2026-11-01T12:00:00-05:00");
});

test("toOffsetDateTime keeps an explicit offset or Z (normalized to seconds) and the same instant", () => {
  assert.equal(toOffsetDateTime("2026-10-12T18:30-04:00", NY, "f"), "2026-10-12T18:30:00-04:00");
  assert.equal(toOffsetDateTime("2026-10-12T22:30:00Z", NY, "f"), "2026-10-12T22:30:00Z");
  assert.equal(toOffsetDateTime("2026-10-12T22:30:00.000Z", NY, "f"), "2026-10-12T22:30:00.000Z");
  assert.equal(Date.parse(toOffsetDateTime("2026-10-12T22:30Z", NY, "f")), Date.parse("2026-10-12T18:30:00-04:00"));
  assert.equal(formatOffsetDateTime(toOffsetDateTime("2026-10-12T22:30:00Z", NY, "f"), NY), "2026-10-12T18:30:00-04:00");
});

test("toOffsetDateTime rejects other shapes and impossible values with the field name and guidance", () => {
  for (const bad of ["", "nope", "2026-10-12", "2026-10-12 18:30", "2026-02-30T10:00", "2026-10-12T24:00", "2026-10-12T10:60", "2026-10-12T10:00:60", "2026-10-12T10:00+25:00", "2026-10-12T10:00+04:60", "2026-10-12T10:00.5.5", "6:30 PM"]) {
    assert.throws(() => toOffsetDateTime(bad, NY, "startsAt"), (e: unknown) => e instanceof ValidationError && e.field === "startsAt" && e.message.includes("read as America/New_York time, or add an explicit offset"), bad);
  }
});

test("todayIn gives the calendar date in the zone, not in UTC or the process zone", () => {
  const instant = new Date("2026-10-12T23:30:00Z");
  assert.equal(todayIn("UTC", instant), "2026-10-12");
  assert.equal(todayIn(NY, instant), "2026-10-12");
  assert.equal(todayIn("Pacific/Auckland", instant), "2026-10-13");
  assert.equal(todayIn("Pacific/Honolulu", new Date("2026-10-12T05:00:00Z")), "2026-10-11");
  assert.equal(todayIn(NY, new Date("2026-01-01T04:59:00Z")), "2025-12-31");
  assert.equal(todayIn(NY, new Date("2026-01-01T05:00:00Z")), "2026-01-01");
});

test("addDays does calendar arithmetic on YYYY-MM-DD across month, year and DST boundaries", () => {
  assert.equal(addDays("2026-10-12", 7), "2026-10-19");
  assert.equal(addDays("2026-01-31", 1), "2026-02-01");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(addDays("2026-03-07", 2), "2026-03-09");
  assert.equal(addDays("2026-11-01", -365), "2025-11-01");
});

test("parseInstant reads a datetime with no zone suffix as UTC and leaves suffixed values alone", () => {
  assert.equal(parseInstant("2026-10-12T18:30:00"), Date.parse("2026-10-12T18:30:00Z"));
  assert.equal(parseInstant("2026-10-12T18:30"), Date.parse("2026-10-12T18:30:00Z"));
  assert.equal(parseInstant("2026-10-12T18:30:00-04:00"), Date.parse("2026-10-12T22:30:00Z"));
  assert.equal(parseInstant("2026-10-12T18:30:00.000Z"), Date.parse("2026-10-12T18:30:00Z"));
  assert.equal(parseInstant("2026-10-12"), Date.parse("2026-10-12T00:00:00Z"));
  assert.ok(Number.isNaN(parseInstant("nope")));
});

test("formatting never depends on the process time zone", () => {
  const was = process.env.TZ;
  const render = () => [formatOffsetDateTime("2026-10-12T22:30:00", NY), formatHuman("2026-10-12T22:30:00", NY), formatOffsetDateTime("2026-10-12T22:30:00Z", NY), todayIn(NY, new Date("2026-10-12T23:30:00Z"))];
  try {
    process.env.TZ = "UTC";
    const utc = render();
    process.env.TZ = "Asia/Tokyo";
    const tokyo = render();
    assert.deepEqual(tokyo, utc);
    assert.deepEqual(utc, ["2026-10-12T18:30:00-04:00", "Mon Oct 12, 6:30 PM EDT", "2026-10-12T18:30:00-04:00", "2026-10-12"]);
  } finally {
    if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
  }
});

test("toOffsetDateTime refuses a time that does not exist because clocks skip forward", () => {
  assert.throws(() => toOffsetDateTime("2026-03-08T02:30", NY, "startsAt"), (e: unknown) =>
    e instanceof ValidationError && e.field === "startsAt" && e.message === "startsAt: 02:30 does not exist on that date in America/New_York (clocks skip forward); pick another time");
  assert.throws(() => toOffsetDateTime("2026-03-08T02:00:00", NY, "f"), /does not exist/);
  assert.throws(() => toOffsetDateTime("2026-03-29T02:30", "Europe/Berlin", "f"), /02:30 does not exist on that date in Europe\/Berlin/);
  // the edges around the gap exist
  assert.equal(toOffsetDateTime("2026-03-08T01:59", NY, "f"), "2026-03-08T01:59:00-05:00");
  assert.equal(toOffsetDateTime("2026-03-08T03:00", NY, "f"), "2026-03-08T03:00:00-04:00");
  assert.equal(toOffsetDateTime("2026-03-29T01:59", "Europe/Berlin", "f"), "2026-03-29T01:59:00+01:00");
  assert.equal(toOffsetDateTime("2026-03-29T03:00", "Europe/Berlin", "f"), "2026-03-29T03:00:00+02:00");
  // an explicit offset is never checked against the zone
  assert.equal(toOffsetDateTime("2026-03-08T02:30-05:00", NY, "f"), "2026-03-08T02:30:00-05:00");
});

test("an ambiguous fall-back hour resolves to the first (daylight) occurrence, in zones west and east of UTC", () => {
  assert.equal(toOffsetDateTime("2026-11-01T01:30", NY, "f"), "2026-11-01T01:30:00-04:00");
  assert.equal(toOffsetDateTime("2026-10-25T02:30", "Europe/Berlin", "f"), "2026-10-25T02:30:00+02:00");
  assert.equal(toOffsetDateTime("2026-10-25T02:59", "Europe/Berlin", "f"), "2026-10-25T02:59:00+02:00");
  assert.equal(toOffsetDateTime("2026-10-25T03:00", "Europe/Berlin", "f"), "2026-10-25T03:00:00+01:00");
  assert.equal(toOffsetDateTime("2026-04-05T02:30", "Australia/Sydney", "f"), "2026-04-05T02:30:00+11:00");
});

test("exclusiveDateMax is the day after an inclusive end date, across month, year and leap-day boundaries", () => {
  assert.equal(exclusiveDateMax("2026-10-12"), "2026-10-13");
  assert.equal(exclusiveDateMax("2026-10-31"), "2026-11-01");
  assert.equal(exclusiveDateMax("2026-12-31"), "2027-01-01");
  assert.equal(exclusiveDateMax("2027-02-28"), "2027-03-01");
  assert.equal(exclusiveDateMax("2028-02-28"), "2028-02-29");
  assert.equal(exclusiveDateMax("2028-02-29"), "2028-03-01");
});
