import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APPLY_TO_VALUES, EXPOSED_APPLY_TO_VALUES, EXPOSED_UPDATE_APPLY_TO_VALUES, PROFILE_KINDS, DEFAULT_PROFILE_KIND, isPersonKind, kindFromLinked, linkedFromKind } from "../../src/skylight/vocab.js";

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
