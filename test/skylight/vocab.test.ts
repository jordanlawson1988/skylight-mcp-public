import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APPLY_TO_VALUES, EXPOSED_APPLY_TO_VALUES, EXPOSED_UPDATE_APPLY_TO_VALUES, PROFILE_KINDS, kindFromLinked, linkedFromKind } from "../../src/skylight/vocab.js";

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

test("PROFILE_KINDS is the only source of the profile/label strings in src/tools", () => {
  const dir = join(import.meta.dirname, "../../src/tools");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    const src = readFileSync(join(dir, f), "utf8");
    assert.ok(!/\[\s*"profile"\s*,\s*"label"\s*\]/.test(src), `${f} duplicates the profile kind enum`);
    assert.ok(!/\[\s*"label"\s*,\s*"profile"\s*\]/.test(src), `${f} duplicates the profile kind enum`);
  }
});
