import { test } from "node:test";
import assert from "node:assert/strict";
import { createFrameResolver } from "../../src/skylight/frame.js";
import type { SkylightClient } from "../../src/skylight/client.js";

function clientWith(frames: Array<{ id: string; attributes?: Record<string, unknown> }>, fallback404 = false): SkylightClient & { calls: string[] } {
  const c = {
    calls: [] as string[],
    async request<T>(o: { path: string }): Promise<T> {
      c.calls.push(o.path);
      if (o.path === "/api/frames/calendar" && fallback404) {
        const { SkylightApiError } = await import("../../src/skylight/errors.js");
        throw new SkylightApiError(404, "GET", o.path, "nf");
      }
      return { data: frames } as T;
    },
  };
  return c;
}

test("single frame resolves and is cached", async () => {
  const client = clientWith([{ id: "77", attributes: { household_name: "Lawsons" } }]);
  const r = createFrameResolver({ client, configuredFrameId: null });
  assert.equal(await r.resolve(), "77");
  assert.equal(await r.resolve(), "77");
  assert.equal(client.calls.length, 1);
  assert.deepEqual(await r.list(), [{ id: "77", name: "Lawsons" }]);
});

test("configured id must exist in list", async () => {
  const client = clientWith([{ id: "1" }, { id: "2" }]);
  assert.equal(await createFrameResolver({ client, configuredFrameId: "2" }).resolve(), "2");
  await assert.rejects(createFrameResolver({ client, configuredFrameId: "9" }).resolve(), /SKYLIGHT_FRAME_ID/);
});

test("multiple frames without config lists them in the error", async () => {
  const client = clientWith([{ id: "1", attributes: { name: "Kitchen" } }, { id: "2", attributes: { name: "Hall" } }]);
  await assert.rejects(createFrameResolver({ client, configuredFrameId: null }).resolve(), /Kitchen[\s\S]*Hall[\s\S]*SKYLIGHT_FRAME_ID/);
});

test("falls back to /api/frames on 404 and rejects bad ids", async () => {
  const client = clientWith([{ id: "5" }], true);
  assert.equal(await createFrameResolver({ client, configuredFrameId: null }).resolve(), "5");
  assert.deepEqual(client.calls, ["/api/frames/calendar", "/api/frames"]);
  const bad = clientWith([{ id: "../x" }]);
  await assert.rejects(createFrameResolver({ client: bad, configuredFrameId: null }).resolve(), /frame id/i);
});
