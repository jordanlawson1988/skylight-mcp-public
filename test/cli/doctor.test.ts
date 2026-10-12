import { test } from "node:test";
import assert from "node:assert/strict";
import { doctor } from "../../src/cli/doctor.js";
import { createRuntime } from "../../src/runtime.js";
import { createFakeKeychain } from "../helpers/fake-keychain.js";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { makeTmpDir } from "../helpers/tmp-dir.js";

test("doctor prints status, profiles and a Claude Desktop config block", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { runner } = createFakeKeychain();
  const { fetch } = createMockFetch([
    { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77", attributes: { household_name: "L" } }] } },
    { method: "GET", path: "/api/frames/77/categories", json: { data: [{ id: "12", attributes: { label: "Ellie" } }] } },
  ]);
  const rt = createRuntime({ env: { SKYLIGHT_CREDENTIALS_DIR: dir }, fetch, runner });
  let out = await doctor(rt, { serverPath: "/abs/dist/server.js" });
  assert.match(out, /not logged in/i);
  await rt.store.write({ version: 1, accessToken: "AT", refreshToken: "RT", fingerprint: "f", expiresAt: Date.now() + 10_000_000 });
  out = await doctor(rt, { serverPath: "/abs/dist/server.js" });
  assert.match(out, /Logged in/);
  assert.match(out, /Ellie \(12\)/);
  assert.ok(out.includes(`"command": ${JSON.stringify(process.execPath)}`));
  assert.match(process.execPath, /node(\.exe)?$/);
  assert.match(out, /Frames:\s+77 \(L\)/);
  assert.match(out, /\/abs\/dist\/server\.js/);
  assert.ok(!out.includes("AT"));
  await cleanup();
});

test("doctor reports a credential problem instead of plain not logged in", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { runner, items } = createFakeKeychain();
  const { fetch } = createMockFetch([]);
  const rt = createRuntime({ env: { SKYLIGHT_CREDENTIALS_DIR: dir }, fetch, runner });
  await rt.store.write({ version: 1, accessToken: "AT", refreshToken: "RT", fingerprint: "f", expiresAt: Date.now() + 10_000_000 });
  for (const k of items.keys()) items.set(k, Buffer.alloc(32, 7).toString("base64"));
  const out = await doctor(rt, { serverPath: "/abs/dist/server.js" });
  assert.match(out, /credential problem/);
  assert.doesNotMatch(out, /not logged in/i);
  await cleanup();
});
