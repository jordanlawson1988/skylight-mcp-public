import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { findCallbackInChromeHistory } from "../../src/cli/chrome-history.js";
import { makeTmpDir } from "../helpers/tmp-dir.js";

const run = promisify(execFile);
const toChrome = (ms: number) => (ms + 11_644_473_600_000) * 1000;
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

async function makeHistory(chromeDir: string, profile: string, rows: Array<[string, number]>): Promise<void> {
  const dir = path.join(chromeDir, profile);
  await mkdir(dir, { recursive: true });
  const inserts = rows.map(([url, ms]) => `insert into urls(url, last_visit_time) values('${url}', ${toChrome(ms)});`).join("");
  await run("/usr/bin/sqlite3", [path.join(dir, "History"), `create table urls(id integer primary key, url text, last_visit_time integer); ${inserts}`]);
}

test("returns the newest callback visited after since, across profiles, and removes temp copies", async () => {
  const chrome = await makeTmpDir();
  const tmp = await makeTmpDir();
  await makeHistory(chrome.dir, "Default", [
    ["https://ourskylight.com/welcome?code=OLD&state=s", NOW - 3_600_000],
    ["https://ourskylight.com/welcome?code=MID&state=s", NOW + 1000],
    ["https://example.com/welcome?code=OTHERHOST", NOW + 5000],
  ]);
  await makeHistory(chrome.dir, "Profile 2", [["https://ourskylight.com/welcome?code=NEW&state=s", NOW + 9000]]);
  await mkdir(path.join(chrome.dir, "System Profile"));
  const url = await findCallbackInChromeHistory({ chromeDir: chrome.dir, since: NOW, tmpDir: tmp.dir });
  assert.equal(url, "https://ourskylight.com/welcome?code=NEW&state=s");
  assert.deepEqual(await readdir(tmp.dir), []);
  await chrome.cleanup();
  await tmp.cleanup();
});

test("returns null when every callback is older than since or on another host", async () => {
  const chrome = await makeTmpDir();
  const tmp = await makeTmpDir();
  await makeHistory(chrome.dir, "Default", [
    ["https://ourskylight.com/welcome?code=OLD&state=s", NOW - 1000],
    ["https://example.com/welcome?code=X", NOW + 1000],
  ]);
  assert.equal(await findCallbackInChromeHistory({ chromeDir: chrome.dir, since: NOW, tmpDir: tmp.dir }), null);
  assert.deepEqual(await readdir(tmp.dir), []);
  await chrome.cleanup();
  await tmp.cleanup();
});

test("returns null for a missing Chrome dir, a missing sqlite3, or a corrupt History file", async () => {
  const chrome = await makeTmpDir();
  const tmp = await makeTmpDir();
  assert.equal(await findCallbackInChromeHistory({ chromeDir: path.join(chrome.dir, "nope"), since: NOW, tmpDir: tmp.dir }), null);
  await makeHistory(chrome.dir, "Default", [["https://ourskylight.com/welcome?code=NEW", NOW + 1000]]);
  assert.equal(await findCallbackInChromeHistory({ chromeDir: chrome.dir, since: NOW, tmpDir: tmp.dir, sqlite3Path: path.join(chrome.dir, "no-sqlite3") }), null);
  await mkdir(path.join(chrome.dir, "Profile 9"));
  await run("/bin/sh", ["-c", `echo garbage > '${path.join(chrome.dir, "Profile 9", "History")}'`]);
  assert.equal(await findCallbackInChromeHistory({ chromeDir: chrome.dir, since: NOW, tmpDir: tmp.dir }), "https://ourskylight.com/welcome?code=NEW");
  assert.deepEqual(await readdir(tmp.dir), []);
  await chrome.cleanup();
  await tmp.cleanup();
});

test("copies into a private 0700 temp dir, copies History-journal/-wal alongside, and removes everything", async () => {
  const chrome = await makeTmpDir();
  const tmp = await makeTmpDir();
  const shimDir = await makeTmpDir();
  await makeHistory(chrome.dir, "Default", [["https://ourskylight.com/welcome?code=NEW&state=s", NOW + 1000]]);
  // Empty sidecars are valid (sqlite ignores a zero-length journal/WAL) and let us see they were copied.
  await writeFile(path.join(chrome.dir, "Default", "History-journal"), "");
  await writeFile(path.join(chrome.dir, "Default", "History-wal"), "");
  const log = path.join(shimDir.dir, "log.txt");
  const shim = path.join(shimDir.dir, "sqlite3-shim");
  await writeFile(shim, `#!/bin/sh\ndir=$(dirname "$2")\n{ stat -f %Lp "$dir"; ls "$dir"; } > '${log}'\nexec /usr/bin/sqlite3 "$@"\n`);
  await chmod(shim, 0o755);
  const url = await findCallbackInChromeHistory({ chromeDir: chrome.dir, since: NOW, tmpDir: tmp.dir, sqlite3Path: shim });
  assert.equal(url, "https://ourskylight.com/welcome?code=NEW&state=s");
  const [mode, ...files] = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(mode, "700");
  assert.deepEqual(files.sort(), ["History", "History-journal", "History-wal"]);
  assert.deepEqual(await readdir(tmp.dir), []);
  await Promise.all([chrome.cleanup(), tmp.cleanup(), shimDir.cleanup()]);
});
