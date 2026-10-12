import { test } from "node:test";
import assert from "node:assert/strict";
import { APPLY_TO_VALUES, EXPOSED_APPLY_TO_VALUES, EXPOSED_UPDATE_APPLY_TO_VALUES } from "../../src/skylight/vocab.js";

test("every exposed apply_to value is a known server value", () => {
  for (const v of [...EXPOSED_APPLY_TO_VALUES, ...EXPOSED_UPDATE_APPLY_TO_VALUES]) assert.ok(APPLY_TO_VALUES.includes(v), v);
  assert.deepEqual([...EXPOSED_APPLY_TO_VALUES].sort(), ["all", "future", "one"]);
  assert.deepEqual([...EXPOSED_UPDATE_APPLY_TO_VALUES], ["all"]);
});
