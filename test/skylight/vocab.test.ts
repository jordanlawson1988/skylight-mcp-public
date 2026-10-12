import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIST_KINDS, DEFAULT_LIST_KIND, LIST_ITEM_STATUS, EVENT_KIND, OWN_EVENT_SOURCE, APPLY_TO_VALUES, EXPOSED_APPLY_TO_VALUES, EXPOSED_UPDATE_APPLY_TO_VALUES, PROFILE_KINDS, DEFAULT_PROFILE_KIND, ROUTINE_SLOTS, ROUTINE_SLOT_NAMES, slotFromHour, slotFromStartTime, isPersonKind, kindFromLinked, linkedFromKind } from "../../src/skylight/vocab.js";

test("every exposed apply_to value is a known server value", () => {
  for (const v of [...EXPOSED_APPLY_TO_VALUES, ...EXPOSED_UPDATE_APPLY_TO_VALUES]) assert.ok(APPLY_TO_VALUES.includes(v), v);
  assert.deepEqual([...EXPOSED_APPLY_TO_VALUES].sort(), ["all", "future", "one"]);
  assert.deepEqual([...EXPOSED_UPDATE_APPLY_TO_VALUES], ["all"]);
});

test("profile kind round-trips through the linked flag", () => {
  assert.deepEqual([...PROFILE_KINDS], ["profile", "label"]);
  for (const k of PROFILE_KINDS) assert.equal(kindFromLinked(linkedFromKind(k)), k);
  assert.equal(kindFromLinked(true), "profile");
  assert.equal(kindFromLinked(false), "label");
  assert.equal(kindFromLinked(null), null);
});

test("DEFAULT_PROFILE_KIND and isPersonKind come from vocab", () => {
  assert.equal(DEFAULT_PROFILE_KIND, "profile");
  assert.ok(PROFILE_KINDS.includes(DEFAULT_PROFILE_KIND));
  assert.equal(isPersonKind("profile"), true);
  assert.equal(isPersonKind("label"), false);
  assert.equal(isPersonKind(null), false);
});

test("routine slots map to the only BYHOUR values the server accepts", () => {
  assert.deepEqual({ ...ROUTINE_SLOTS }, { morning: 6, afternoon: 14, evening: 20 });
  assert.deepEqual([...ROUTINE_SLOT_NAMES], ["morning", "afternoon", "evening"]);
  for (const slot of ROUTINE_SLOT_NAMES) {
    assert.equal(slotFromHour(ROUTINE_SLOTS[slot]), slot);
    assert.equal(slotFromStartTime(`${String(ROUTINE_SLOTS[slot]).padStart(2, "0")}:00`), slot);
  }
  for (const bad of [null, "07:00", "06:30", "6:00", "garbage"]) assert.equal(slotFromStartTime(bad), null);
  assert.equal(slotFromHour(7), null);
  assert.equal(slotFromHour(null), null);
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []);
}

test("the profile kind strings are quoted only in vocab.ts (descriptions excepted)", () => {
  const root = join(import.meta.dirname, "../../src");
  for (const f of sourceFiles(root).filter((n) => !n.endsWith(join("skylight", "vocab.ts")))) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (line.includes("describe(") || line.includes("description:") || line.includes("instructions:")) return;
      assert.ok(!/["'`](profile|label)["'`]/.test(line), `${f}:${i + 1} quotes a profile kind literal; import it from vocab.ts`);
    });
  }
});

test("the routine slot names are quoted only in vocab.ts (descriptions excepted)", () => {
  const root = join(import.meta.dirname, "../../src");
  for (const f of sourceFiles(root).filter((n) => !n.endsWith(join("skylight", "vocab.ts")))) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (line.includes("describe(") || line.includes("description:") || line.includes("instructions:")) return;
      assert.ok(!/["'`](morning|afternoon|evening)["'`]/.test(line), `${f}:${i + 1} quotes a routine slot literal; import it from vocab.ts`);
    });
  }
});

test("list vocab matches the verified server values", () => {
  assert.deepEqual([...LIST_KINDS], ["to_do", "shopping", "other"]);
  assert.ok(LIST_KINDS.includes(DEFAULT_LIST_KIND));
  assert.equal(DEFAULT_LIST_KIND, "to_do");
  assert.deepEqual({ ...LIST_ITEM_STATUS }, { done: "completed", notDone: "pending" });
});

test("event vocab: own-calendar source and kind, and the scopes the event tools expose are server scopes", () => {
  assert.equal(OWN_EVENT_SOURCE, "skylight");
  assert.equal(EVENT_KIND, "standard");
  for (const v of [...EXPOSED_APPLY_TO_VALUES, ...EXPOSED_UPDATE_APPLY_TO_VALUES]) assert.ok(APPLY_TO_VALUES.includes(v), v);
});

test("the list kind and item status strings are quoted only in vocab.ts (descriptions excepted)", () => {
  const root = join(import.meta.dirname, "../../src");
  for (const f of sourceFiles(root).filter((n) => !n.endsWith(join("skylight", "vocab.ts")))) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (line.includes("describe(") || line.includes("description:") || line.includes("instructions:")) return;
      assert.ok(!/["'`](to_do|shopping|completed)["'`]/.test(line), `${f}:${i + 1} quotes a list vocab literal; import it from vocab.ts`);
    });
  }
});

test("the event source and kind strings are quoted only in vocab.ts (descriptions excepted)", () => {
  const root = join(import.meta.dirname, "../../src");
  for (const f of sourceFiles(root).filter((n) => !n.endsWith(join("skylight", "vocab.ts")))) {
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (line.includes("describe(") || line.includes("description:") || line.includes("instructions:")) return;
      assert.ok(!/["'`](skylight|standard)["'`]/.test(line), `${f}:${i + 1} quotes an event vocab literal; import it from vocab.ts`);
    });
  }
});
