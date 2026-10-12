import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProfileCreateBody, buildProfileUpdateBody } from "../../src/skylight/profile-payload.js";
import { assertHexColor } from "../../src/skylight/ids.js";
import { ValidationError } from "../../src/skylight/errors.js";

const field = (f: string) => (e: unknown) => e instanceof ValidationError && e.field === f;

test("create body sets both flags from kind and upper-cases the color", () => {
  assert.deepEqual(buildProfileCreateBody({ name: "  Ellie ", color: "#cb434c", kind: "profile" }),
    { label: "Ellie", color: "#CB434C", linked_to_profile: true, selected_for_chore_chart: true });
  assert.deepEqual(buildProfileCreateBody({ name: "Birthdays", color: "#123456", kind: "label" }),
    { label: "Birthdays", color: "#123456", linked_to_profile: false, selected_for_chore_chart: false });
});

test("update body is partial; kind maps to both flags together", () => {
  assert.deepEqual(buildProfileUpdateBody({ name: "New" }), { label: "New" });
  assert.deepEqual(buildProfileUpdateBody({ color: "#abcdef" }), { color: "#ABCDEF" });
  assert.deepEqual(buildProfileUpdateBody({ kind: "label" }), { linked_to_profile: false, selected_for_chore_chart: false });
  assert.deepEqual(buildProfileUpdateBody({ kind: "profile", name: "X" }), { label: "X", linked_to_profile: true, selected_for_chore_chart: true });
});

test("empty update throws", () => {
  assert.throws(() => buildProfileUpdateBody({}), field("update"));
});

test("bad color, name and kind throw ValidationError", () => {
  for (const bad of ["red", "#FFF", "#12345", "#1234567", "123456", "#GGGGGG", ""]) {
    assert.throws(() => assertHexColor(bad, "color"), field("color"), bad);
    assert.throws(() => buildProfileCreateBody({ name: "A", color: bad, kind: "profile" }), field("color"));
  }
  assert.throws(() => buildProfileCreateBody({ name: "  ", color: "#123456", kind: "profile" }), field("name"));
  assert.throws(() => buildProfileCreateBody({ name: "x".repeat(101), color: "#123456", kind: "profile" }), field("name"));
  assert.throws(() => buildProfileCreateBody({ name: "A", color: "#123456", kind: "adult" as never }), field("kind"));
  assert.throws(() => buildProfileUpdateBody({ kind: "bogus" as never }), field("kind"));
});
