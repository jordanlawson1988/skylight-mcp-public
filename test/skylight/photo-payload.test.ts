import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAlbumTitle, assertPhotoIds, buildAlbumMembershipBody, buildCaptionBody, buildDestroyPhotosBody } from "../../src/skylight/photo-payload.js";
import { ValidationError } from "../../src/skylight/errors.js";

const bad = (fn: () => unknown, field: string) => assert.throws(fn, (e: unknown) => e instanceof ValidationError && e.field === field, field);

test("buildCaptionBody trims, allows the empty caption to clear, and bounds at 200", () => {
  assert.deepEqual(buildCaptionBody("  Beach day "), { caption: "Beach day" });
  assert.deepEqual(buildCaptionBody(""), { caption: "" });
  assert.deepEqual(buildCaptionBody("   "), { caption: "" });
  assert.deepEqual(buildCaptionBody("x".repeat(200)), { caption: "x".repeat(200) });
  bad(() => buildCaptionBody("x".repeat(201)), "caption");
  bad(() => buildCaptionBody("a\u0000b"), "caption");
});

test("assertAlbumTitle trims and bounds", () => {
  assert.equal(assertAlbumTitle("  Summer 2026 "), "Summer 2026");
  bad(() => assertAlbumTitle("  "), "title");
  bad(() => assertAlbumTitle("x".repeat(101)), "title");
});

test("assertPhotoIds: numeric ids, no repeats, 1..max", () => {
  assert.deepEqual(assertPhotoIds(["1794275894", "5"], "photoIds", 50), ["1794275894", "5"]);
  bad(() => assertPhotoIds([], "photoIds", 50), "photoIds");
  bad(() => assertPhotoIds(["1", "1"], "photoIds", 50), "photoIds");
  bad(() => assertPhotoIds(["1", "../2"], "photoIds", 50), "photoIds");
  bad(() => assertPhotoIds(["abc"], "photoIds", 50), "photoIds");
  bad(() => assertPhotoIds(Array.from({ length: 51 }, (_, i) => String(i + 1)), "photoIds", 50), "photoIds");
});

test("album membership and destroy bodies carry numbers, as the API expects", () => {
  assert.deepEqual(buildAlbumMembershipBody("3001", ["1794275894", "5"]), { album_ids: [3001], message_ids: [1794275894, 5] });
  assert.deepEqual(buildDestroyPhotosBody(["7", "8"]), { message_ids: [7, 8] });
  bad(() => buildAlbumMembershipBody("summer", ["1"]), "albumId");
});
