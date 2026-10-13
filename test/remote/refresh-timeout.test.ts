import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { AccountCore } from "../../src/remote/account-core.js";
import { createRuntime } from "../../src/runtime.js";
import { parseConfig } from "../../src/skylight/config.js";
import { AuthError } from "../../src/skylight/errors.js";
import { REFRESH_TIMEOUT_MS } from "../../src/skylight/oauth.js";
import { createFakeKeychain } from "../helpers/fake-keychain.js";
import { createMemoryKv } from "../helpers/memory-kv.js";
import { createMockFetch } from "../helpers/mock-fetch.js";
import { makeTmpDir } from "../helpers/tmp-dir.js";

/** A Skylight token endpoint that answers after `delayMs`, rotating the refresh token each time. */
function slowSkylight(delayMs: number) {
  let n = 0;
  const bodies: Array<Record<string, string>> = [];
  const { fetch: inner } = createMockFetch([{ method: "POST", path: "/oauth/token", handler: ({ body }) => { bodies.push(body as Record<string, string>); n += 1; return { json: { access_token: `AT-${n + 1}`, refresh_token: `RT-${n + 1}`, expires_in: 3600 } }; } }]);
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, delayMs);
      init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); });
    });
    return inner(input, init);
  }) as typeof globalThis.fetch;
  return { fetch, bodies };
}

test("the refresh timeout is 30 s, its own setting, not SKYLIGHT_REQUEST_TIMEOUT_MS", () => {
  assert.equal(REFRESH_TIMEOUT_MS, 30_000);
});

test("shared server: a refresh slower than SKYLIGHT_REQUEST_TIMEOUT_MS still completes and stores the rotated token", async () => {
  const { fetch, bodies } = slowSkylight(150);
  const config = parseConfig({ SKYLIGHT_REQUEST_TIMEOUT_MS: "40" });
  const core = new AccountCore({ storage: createMemoryKv(), keyB64: randomBytes(32).toString("base64"), fetch, config, now: () => Date.now() });
  await core.setCredential({ version: 1, accessToken: "AT-1", refreshToken: "RT-1", fingerprint: "fp", expiresAt: Date.now() - 1 });
  assert.equal(await core.getAccessToken(), "AT-2");
  assert.equal(await core.refreshAfterRejection("AT-2"), "AT-3");
  assert.deepEqual(bodies.map((b) => b.refresh_token), ["RT-1", "RT-2"], "the second refresh used the rotated token");
});

test("shared server: a refresh slower than its own timeout fails clearly and keeps the old credential", async () => {
  const { fetch } = slowSkylight(200);
  const core = new AccountCore({ storage: createMemoryKv(), keyB64: randomBytes(32).toString("base64"), fetch, config: parseConfig({}), now: () => Date.now(), refreshTimeoutMs: 30 });
  await core.setCredential({ version: 1, accessToken: "AT-1", refreshToken: "RT-1", fingerprint: "fp", expiresAt: Date.now() - 1 });
  await assert.rejects(core.getAccessToken(), (e: unknown) => e instanceof AuthError && /timed out/.test(e.message));
  assert.equal((await core.status()).needsLogin, false);
});

test("Mac: the token provider also refreshes on the 30 s timeout, whatever SKYLIGHT_REQUEST_TIMEOUT_MS says", async () => {
  const { dir, cleanup } = await makeTmpDir();
  const { fetch, bodies } = slowSkylight(150);
  const rt = createRuntime({ env: { SKYLIGHT_CREDENTIALS_DIR: dir, SKYLIGHT_REQUEST_TIMEOUT_MS: "40" }, fetch, runner: createFakeKeychain().runner });
  await rt.store.write({ version: 1, accessToken: "AT-1", refreshToken: "RT-1", fingerprint: "fp", expiresAt: Date.now() - 1 });
  assert.equal(await rt.tokens.getAccessToken(), "AT-2");
  assert.equal((await rt.store.read())!.refreshToken, "RT-2");
  assert.equal(bodies.length, 1);
  await cleanup();
});
