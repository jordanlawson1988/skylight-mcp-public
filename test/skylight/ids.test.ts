import { test } from "node:test";
import assert from "node:assert/strict";
import { assertId, assertDate, parseChoreId, COMPOSITE_CHORE_ID, assertTime, cleanText, assertEmoji, assertPoints, localDateString } from "../../src/skylight/ids.js";
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

test("localDateString uses local calendar fields, zero-padded", () => {
  assert.equal(localDateString(new Date(2026, 0, 31, 23, 30)), "2026-01-31");
  assert.equal(localDateString(new Date(2026, 11, 1, 0, 5)), "2026-12-01");
});

test("parseChoreId splits composite ids and passes plain ids through", () => {
  assert.deepEqual(parseChoreId("111881467", "choreId"), { seriesId: "111881467", instanceDate: null });
  assert.deepEqual(parseChoreId(111881467, "choreId"), { seriesId: "111881467", instanceDate: null });
  assert.deepEqual(parseChoreId("111881467-2026-10-13", "choreId"), { seriesId: "111881467", instanceDate: "2026-10-13" });
  assert.deepEqual(parseChoreId("abc_1", "choreId"), { seriesId: "abc_1", instanceDate: null });
  assert.ok(COMPOSITE_CHORE_ID.test("1-2026-10-13"));
});

test("parseChoreId rejects invalid ids and impossible composite dates", () => {
  for (const bad of ["", "../x", "a/b", "5 6", "x".repeat(65)]) {
    assert.throws(() => parseChoreId(bad, "choreId"), (e: unknown) => e instanceof ValidationError && (e as ValidationError).field === "choreId");
  }
  assert.throws(() => parseChoreId("5-2026-02-30", "choreId"), (e: unknown) => e instanceof ValidationError && (e as ValidationError).field === "choreId");
});
