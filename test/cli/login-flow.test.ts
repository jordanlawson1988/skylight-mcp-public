import { test } from "node:test";
import assert from "node:assert/strict";
import { startLogin } from "../../src/cli/commands.js";
import { FIRST_PROMPT, RETRY_NOTICE, RETRY_PROMPT, runLoginPrompt, type LoginFlowIo } from "../../src/cli/login-flow.js";
import { createRuntime } from "../../src/runtime.js";
import { createFakeKeychain } from "../helpers/fake-keychain.js";
import { createMockFetch, type MockRoute } from "../helpers/mock-fetch.js";
import { makeTmpDir } from "../helpers/tmp-dir.js";

async function setup(routes: MockRoute[] = [{ method: "POST", path: "/oauth/token", json: { access_token: "AT", refresh_token: "RT", expires_in: 3600 } }]) {
  const { dir, cleanup } = await makeTmpDir();
  const { runner } = createFakeKeychain();
  const { fetch } = createMockFetch(routes);
  const runtime = createRuntime({ env: { SKYLIGHT_CREDENTIALS_DIR: dir }, fetch, runner });
  const { url } = await startLogin(runtime);
  const state = new URL(url).searchParams.get("state")!;
  return { runtime, state, cleanup };
}

function scripted(answers: Array<string | null>) {
  const prompts: string[] = [];
  const out: string[] = [];
  const io: LoginFlowIo = {
    ask: async (p) => { prompts.push(p); return answers.shift() ?? null; },
    write: (t) => { out.push(t); },
  };
  return { io, prompts, out };
}

test("Enter retries until Chrome history has the sign-in, re-prompting each time", async () => {
  const { runtime, state, cleanup } = await setup();
  const { io, prompts, out } = scripted(["", "", ""]);
  let lookups = 0;
  const r = await runLoginPrompt(runtime, io, async () => (++lookups < 3 ? null : `https://ourskylight.com/welcome?code=C&state=${state}`));
  assert.equal(r.status, "done");
  assert.equal(lookups, 3);
  assert.deepEqual(prompts, [FIRST_PROMPT, RETRY_PROMPT, RETRY_PROMPT]);
  assert.deepEqual(out, [RETRY_NOTICE, RETRY_NOTICE]);
  assert.equal((await runtime.store.read())!.accessToken, "AT");
  await cleanup();
});

test("a pasted address completes the login without searching Chrome", async () => {
  const { runtime, state, cleanup } = await setup();
  const { io, prompts } = scripted(["", `https://ourskylight.com/welcome?code=C&state=${state}`]);
  let lookups = 0;
  const r = await runLoginPrompt(runtime, io, async () => { lookups++; return null; });
  assert.equal(r.status, "done");
  assert.equal(lookups, 1);
  assert.equal(prompts.length, 2);
  await cleanup();
});

test("q quits, keeping the pending login", async () => {
  const { runtime, cleanup } = await setup();
  const { io } = scripted(["", "Q"]);
  const r = await runLoginPrompt(runtime, io, async () => null);
  assert.deepEqual(r, { status: "quit" });
  assert.ok(await runtime.store.readPendingLogin());
  await cleanup();
});

test("end of input ends the loop with an error", async () => {
  const { runtime, cleanup } = await setup();
  const { io } = scripted(["", null]);
  await assert.rejects(runLoginPrompt(runtime, io, async () => null), /prompt closed/);
  await cleanup();
});

test("a bad pasted address ends the loop with completeLogin's error", async () => {
  const { runtime, cleanup } = await setup();
  const { io, prompts } = scripted(["https://ourskylight.com/welcome?code=C&state=WRONG", "", ""]);
  await assert.rejects(runLoginPrompt(runtime, io, async () => null), /state/i);
  assert.equal(prompts.length, 1);
  await cleanup();
});

test("an expired pending login ends the retry loop with the TTL error", async () => {
  const { runtime, state, cleanup } = await setup();
  const pending = (await runtime.store.readPendingLogin())!;
  await runtime.store.writePendingLogin({ ...pending, createdAt: Date.now() - 700_000 });
  const { io, prompts } = scripted(["", "", ""]);
  await assert.rejects(runLoginPrompt(runtime, io, async () => `https://ourskylight.com/welcome?code=C&state=${state}`), /expired/);
  assert.equal(prompts.length, 1);
  await cleanup();
});
