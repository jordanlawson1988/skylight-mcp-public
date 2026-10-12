import { test } from "node:test";
import assert from "node:assert/strict";
import { connectTestClient } from "../helpers/test-server.js";

const FRAMES = { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77", attributes: { household_name: "L" } }] } } as const;

test("tool list contains only expected tools with full annotations", async () => {
  const t = await connectTestClient([FRAMES]);
  const { tools } = await t.client.listTools();
  const names = tools.map((x) => x.name).sort();
  assert.ok(names.includes("skylight_auth_status"));
  assert.ok(names.includes("skylight_list_profiles"));
  for (const bad of ["delete_account", "user_delete", "photo", "device", "invite", "frame_transfer"]) {
    assert.ok(!names.some((n) => n.includes(bad)), `unexpected tool matching ${bad}`);
  }
  for (const tool of tools) {
    const a = tool.annotations ?? {};
    for (const k of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) assert.equal(typeof (a as Record<string, unknown>)[k], "boolean", `${tool.name}.${k}`);
    assert.equal((a as Record<string, unknown>).openWorldHint, false);
  }
  await t.close();
});

test("skylight_auth_status never leaks tokens", async () => {
  const t = await connectTestClient([FRAMES]);
  const r = await t.callTool("skylight_auth_status");
  assert.equal(r.isError, false);
  assert.equal((r.data as { loggedIn: boolean }).loggedIn, true);
  assert.equal((r.data as { frameId: string }).frameId, "77");
  assert.ok(!r.text.includes("AT") && !r.text.includes("RT"));
  await t.close();
});

test("skylight_list_profiles maps categories", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/categories", json: { data: [{ id: "12", attributes: { label: "Ellie", color: "#f00", profile_type: "child" } }] } }]);
  const r = await t.callTool("skylight_list_profiles");
  assert.equal(r.isError, false);
  assert.deepEqual(r.data, [{ id: "12", name: "Ellie", color: "#f00", isAdult: false }]);
  await t.close();
});

test("logged-out call returns a tool error pointing at login, not a crash", async () => {
  const t = await connectTestClient([FRAMES], { loggedIn: false });
  const r = await t.callTool("skylight_list_profiles");
  assert.equal(r.isError, true);
  assert.match(r.text, /skylight-mcp login/);
  await t.close();
});
