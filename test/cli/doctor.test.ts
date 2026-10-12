import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { doctor, stableNodePath } from "../../src/cli/doctor.js";
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
  assert.ok(out.includes(`"command": ${JSON.stringify(stableNodePath())}`));
  assert.match(process.execPath, /node(\.exe)?$/);
  assert.match(out, /Frames:\s+77 \(L\)/);
  assert.match(out, /\/abs\/dist\/server\.js/);
  assert.match(out, /Timezone:\s+America\/New_York \(set SKYLIGHT_TIMEZONE to change\)/);
  assert.match(out, /token valid until \w{3} \w{3} \d{1,2}, \d{1,2}:\d{2} [AP]M E[SD]T\)/);
  assert.ok(!out.includes("SKYLIGHT_TIMEZONE\":"), "the default zone is not written into the config block");
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

test("doctor says the session expired when the refresh is rejected", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { runner } = createFakeKeychain();
  const { fetch } = createMockFetch([{ method: "POST", path: "/oauth/token", status: 400, text: '{"error":"invalid_grant"}' }]);
  const rt = createRuntime({ env: { SKYLIGHT_CREDENTIALS_DIR: dir }, fetch, runner });
  await rt.store.write({ version: 1, accessToken: "AT", refreshToken: "RT", fingerprint: "f", expiresAt: Date.now() - 1000 });
  const out = await doctor(rt, { serverPath: "/abs/dist/server.js" });
  assert.match(out, /session expired or revoked\. Run: skylight-mcp login/);
  assert.doesNotMatch(out, /Logged in/);
  await cleanup();
});

test("stableNodePath prefers a candidate symlink that resolves to the running node", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const cellar = path.join(dir, "Cellar", "node", "25.0.0", "bin");
  await mkdir(cellar, { recursive: true });
  const real = path.join(cellar, "node");
  await writeFile(real, "");
  await mkdir(path.join(dir, "bin"));
  const other = path.join(dir, "bin", "other-node");
  await writeFile(other, "");
  const stable = path.join(dir, "bin", "node");
  await symlink(real, stable);
  const missing = path.join(dir, "nope", "node");
  assert.equal(stableNodePath({ execPath: real, candidates: [missing, other, stable] }), stable);
  // execPath itself may already be the symlink
  assert.equal(stableNodePath({ execPath: stable, candidates: [stable] }), stable);
  await cleanup();
});

test("stableNodePath falls back to execPath when no candidate matches", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const real = path.join(dir, "node");
  const other = path.join(dir, "other");
  await writeFile(real, "");
  await writeFile(other, "");
  assert.equal(stableNodePath({ execPath: real, candidates: [other, path.join(dir, "missing")] }), real);
  assert.equal(stableNodePath({ execPath: path.join(dir, "gone"), candidates: [real] }), path.join(dir, "gone"));
  await cleanup();
});

test("doctor puts SKYLIGHT_TIMEZONE in the Claude Desktop config only when it was set", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { runner } = createFakeKeychain();
  const { fetch } = createMockFetch([]);
  const rt = createRuntime({ env: { SKYLIGHT_CREDENTIALS_DIR: dir, SKYLIGHT_TIMEZONE: "America/Chicago" }, fetch, runner });
  const out = await doctor(rt, { serverPath: "/abs/dist/server.js" });
  assert.match(out, /Timezone:\s+America\/Chicago/);
  assert.match(out, /"SKYLIGHT_TIMEZONE": "America\/Chicago"/);
  await cleanup();
});
