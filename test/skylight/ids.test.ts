import { test } from "node:test";
import assert from "node:assert/strict";
import { assertId, assertDate, parseEventId, parseChoreId, COMPOSITE_CHORE_ID, assertTime, cleanText, cleanParagraph, sameNumericId, assertEmail, assertEmails, assertEmoji, assertPoints } from "../../src/skylight/ids.js";
import { ValidationError } from "../../src/skylight/errors.js";

test("assertId accepts simple ids and numbers", () => {
  assert.equal(assertId("abc_123-X", "f"), "abc_123-X");
  assert.equal(assertId(42, "f"), "42");
});

test("assertId rejects dot segments and separators", () => {
  for (const bad of [".", "..", "../chores", "a/b", "a b", "", "a?b", "a#b", "é", "x".repeat(65)]) {
    assert.throws(() => assertId(bad, "choreId"), (e: unknown) => e instanceof ValidationError && (e as ValidationError).field === "choreId");
  }
});

test("assertDate accepts real dates only", () => {
  assert.equal(assertDate("2026-02-28", "d"), "2026-02-28");
  for (const bad of ["2026-02-30", "2026-13-01", "26-01-01", "2026/01/01", "2026-01-01T00:00"]) {
    assert.throws(() => assertDate(bad, "d"), ValidationError);
  }
});

test("assertTime accepts HH:mm", () => {
  assert.equal(assertTime("07:30", "t"), "07:30");
  for (const bad of ["7:30", "24:00", "07:60", "07:30:00"]) assert.throws(() => assertTime(bad, "t"), ValidationError);
});

test("cleanText trims, normalizes, bounds and rejects control chars", () => {
  assert.equal(cleanText("  Feed the dog ", "s", 500), "Feed the dog");
  assert.equal(cleanText("é", "s", 500), "é");
  assert.throws(() => cleanText("   ", "s", 500), ValidationError);
  assert.throws(() => cleanText("a\u0000b", "s", 500), ValidationError);
  assert.throws(() => cleanText("x".repeat(501), "s", 500), ValidationError);
});

test("assertEmoji allows 1..8 code points, no whitespace", () => {
  assert.equal(assertEmoji("🧹", "e"), "🧹");
  assert.equal(assertEmoji("👨‍👩‍👧", "e"), "👨‍👩‍👧");
  assert.throws(() => assertEmoji("", "e"), ValidationError);
  assert.throws(() => assertEmoji("🧹 🧹", "e"), ValidationError);
  assert.throws(() => assertEmoji("abcdefghi", "e"), ValidationError);
});

test("assertPoints bounds integers", () => {
  assert.equal(assertPoints(-5, "p"), -5);
  assert.throws(() => assertPoints(1.5, "p"), ValidationError);
  assert.throws(() => assertPoints(10001, "p"), ValidationError);
});

test("parseChoreId splits composite ids and passes plain ids through", () => {
  assert.deepEqual(parseChoreId("111881467", "choreId"), { seriesId: "111881467", instanceDate: null, instanceTime: null });
  assert.deepEqual(parseChoreId(111881467, "choreId"), { seriesId: "111881467", instanceDate: null, instanceTime: null });
  assert.deepEqual(parseChoreId("111881467-2026-10-13", "choreId"), { seriesId: "111881467", instanceDate: "2026-10-13", instanceTime: null });
  assert.deepEqual(parseChoreId("abc_1", "choreId"), { seriesId: "abc_1", instanceDate: null, instanceTime: null });
  assert.ok(COMPOSITE_CHORE_ID.test("1-2026-10-13"));
});

test("parseChoreId rejects invalid ids and impossible composite dates", () => {
  for (const bad of ["", "../x", "a/b", "5 6", "x".repeat(65)]) {
    assert.throws(() => parseChoreId(bad, "choreId"), (e: unknown) => e instanceof ValidationError && (e as ValidationError).field === "choreId");
  }
  assert.throws(() => parseChoreId("5-2026-02-30", "choreId"), (e: unknown) => e instanceof ValidationError && (e as ValidationError).field === "choreId");
});

test("parseChoreId reads the HHMM suffix of routine occurrence ids", () => {
  assert.deepEqual(parseChoreId("60913118-2026-10-12-0600", "choreId"), { seriesId: "60913118", instanceDate: "2026-10-12", instanceTime: "06:00" });
  assert.deepEqual(parseChoreId("5-2026-10-12-2000", "choreId"), { seriesId: "5", instanceDate: "2026-10-12", instanceTime: "20:00" });
  assert.ok(COMPOSITE_CHORE_ID.test("5-2026-10-12-1400"));
});

test("parseChoreId rejects impossible times and leaves malformed suffixes as plain ids", () => {
  assert.throws(() => parseChoreId("5-2026-10-12-2500", "choreId"), (e: unknown) => e instanceof ValidationError && e.field === "choreId");
  assert.throws(() => parseChoreId("5-2026-10-12-0660", "choreId"), ValidationError);
  assert.deepEqual(parseChoreId("5-2026-10-12-06", "choreId"), { seriesId: "5-2026-10-12-06", instanceDate: null, instanceTime: null });
});

test("parseEventId splits composite occurrence ids and passes master ids through", () => {
  assert.deepEqual(parseEventId("11019627806", "eventId"), { masterId: "11019627806", occurrence: null });
  assert.deepEqual(parseEventId(11019627806, "eventId"), { masterId: "11019627806", occurrence: null });
  assert.deepEqual(parseEventId("11019627806-1791803100", "eventId"), { masterId: "11019627806", occurrence: 1791803100 });
});

test("parseEventId rejects anything that is not <digits> or <digits>-<digits>", () => {
  for (const bad of ["", "abc", "12-", "-12", "12-34-56", "12-ab", "../1", "1/2", "12-2026-10-12"]) {
    assert.throws(() => parseEventId(bad, "eventId"), (e: unknown) => e instanceof ValidationError && e.field === "eventId", bad);
  }
});

test("cleanParagraph keeps newlines and tabs, normalizes CRLF, and still rejects other control characters", () => {
  assert.equal(cleanParagraph("  Ingredients:\r\n- a\n\nInstructions:\n1. x\n  ", "d", 500), "Ingredients:\n- a\n\nInstructions:\n1. x");
  assert.equal(cleanParagraph("a\tb", "d", 10), "a\tb");
  assert.throws(() => cleanParagraph("a\u0000b", "d", 10), ValidationError);
  assert.throws(() => cleanParagraph("a\u001bb", "d", 10), ValidationError);
  assert.throws(() => cleanParagraph("  \n ", "d", 10), ValidationError);
  assert.throws(() => cleanParagraph("x".repeat(11), "d", 10), ValidationError);
  assert.throws(() => cleanParagraph("\ud800", "d", 10), ValidationError);
});

test("assertEmail accepts ordinary addresses (lower-cased) and rejects the rest", () => {
  assert.equal(assertEmail("  Mom.Smith+skylight@Example.COM ", "email"), "mom.smith+skylight@example.com");
  for (const bad of ["", "plain", "a@b", "a@b.c", "a b@c.com", "a@@c.com", "@c.com", "a@c..com", "a\n@c.com", `${"x".repeat(250)}@c.com`, "a@c.com,b@c.com"]) {
    assert.throws(() => assertEmail(bad, "email"), (e: unknown) => e instanceof ValidationError && e.field === "email", bad);
  }
});

test("assertEmails dedupes case-insensitively, keeps order, bounds the count and names the bad entry", () => {
  assert.deepEqual(assertEmails(["B@x.com", "a@x.com", "b@X.com"], "invitedEmails", 20), ["b@x.com", "a@x.com"]);
  assert.deepEqual(assertEmails([], "invitedEmails", 20), []);
  assert.throws(() => assertEmails(Array.from({ length: 21 }, (_, i) => `u${i}@x.com`), "invitedEmails", 20), ValidationError);
  assert.throws(() => assertEmails(["a@x.com", "nope"], "invitedEmails", 20), (e: unknown) => e instanceof ValidationError && /invitedEmails/.test(e.message));
});

test("sameNumericId compares ids as integers, whatever their spelling, and never matches non-numbers", () => {
  assert.equal(sameNumericId("3001", "3001"), true);
  assert.equal(sameNumericId("03001", "3001"), true);
  assert.equal(sameNumericId(3001 as unknown as string, "3001"), true);
  assert.equal(sameNumericId("3001", "3002"), false);
  assert.equal(sameNumericId("abc", "abc"), false);
  assert.equal(sameNumericId("", ""), false);
  assert.equal(sameNumericId("1.5", "1.5"), false);
});
