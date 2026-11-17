import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runRemote, storeAdminToken, type RemoteDeps } from "../../src/cli/remote.js";
import { createRuntime } from "../../src/runtime.js";
import { createPendingLogin, parseCallbackUrl, REMOTE_LOGIN_COMMAND } from "../../src/skylight/oauth.js";
import { createFakeKeychain } from "../helpers/fake-keychain.js";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { makeTmpDir } from "../helpers/tmp-dir.js";

const URL_STAGING = "https://skylight-mcp-staging.example.workers.dev";

async function setup(find: RemoteDeps["find"], answers: Array<string | null>) {
  const { dir, cleanup } = await makeTmpDir();
  const keychain = createFakeKeychain();
  const { fetch } = createMockFetch([{ method: "GET", path: "/admin/skylight-credential", json: { loggedIn: false } }]);
  const rt = createRuntime({ env: { SKYLIGHT_CREDENTIALS_DIR: path.join(dir, "credentials") }, fetch, runner: keychain.runner });
  const deps: RemoteDeps = {
    rt, runner: keychain.runner, configPath: path.join(dir, "remote.json"),
    wrangler: async () => ({ code: 0 }),
    io: { write: () => {}, ask: async () => (answers.length > 0 ? answers.shift()! : null) },
    ...(find ? { find } : {}),
  };
  await runRemote(["setup", "--env", "staging", "--url", URL_STAGING], deps);
  await storeAdminToken(keychain.runner, URL_STAGING, "ADMIN-TOKEN-0123456789abcdefghijklmnopqrstuv");
  return { deps, rt, cleanup };
}

const namesRemoteCommand = (e: unknown) => e instanceof Error && e.message.includes("`skylight-mcp remote login`") && !e.message.includes("`skylight-mcp login`");

test("parseCallbackUrl names the login command it is given", () => {
  assert.equal(REMOTE_LOGIN_COMMAND, "skylight-mcp remote login");
  const p = createPendingLogin(1000);
  assert.throws(() => parseCallbackUrl("https://ourskylight.com/welcome?code=a&state=WRONG", p, 2000, REMOTE_LOGIN_COMMAND), namesRemoteCommand);
  assert.throws(() => parseCallbackUrl(`https://ourskylight.com/welcome?code=a&state=${p.state}`, p, 1000 + 600_001, REMOTE_LOGIN_COMMAND), namesRemoteCommand);
  assert.throws(() => parseCallbackUrl("https://ourskylight.com/welcome?code=a&state=WRONG", p, 2000), /`skylight-mcp login`/, "the Mac default is unchanged");
});

test("remote login: a callback from another sign-in says to run `skylight-mcp remote login`", async () => {
  const t = await setup(async () => "https://ourskylight.com/welcome?code=C&state=NOT-THIS-ONE", [""]);
  await assert.rejects(runRemote(["login", "--env", "staging"], t.deps), namesRemoteCommand);
  await t.cleanup();
});

test("remote login: a pasted callback after the 10-minute window says to run `skylight-mcp remote login`", async () => {
  const t = await setup(undefined, []);
  t.deps.io.ask = async () => {
    const pending = (await t.rt.store.readPendingLogin())!;
    await t.rt.store.writePendingLogin({ ...pending, createdAt: pending.createdAt - 700_000 });
    return `https://ourskylight.com/welcome?code=C&state=${pending.state}`;
  };
  await assert.rejects(runRemote(["login", "--env", "staging"], t.deps), namesRemoteCommand);
  await t.cleanup();
});

test("remote login: closing the prompt says to run `skylight-mcp remote login`", async () => {
  const t = await setup(async () => null, [null]);
  await assert.rejects(runRemote(["login", "--env", "staging"], t.deps), namesRemoteCommand);
  await t.cleanup();
});
