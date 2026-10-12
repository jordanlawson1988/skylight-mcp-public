import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ChromeHistoryOptions { chromeDir?: string; sqlite3Path?: string; since: number; tmpDir?: string }

const CALLBACK_PREFIX = "https://ourskylight.com/welcome?code=";
// Chrome stores microseconds since 1601-01-01.
const chromeTime = (unixMs: number): number => Math.floor((unixMs + 11_644_473_600_000) * 1000);

/**
 * Looks in Chrome's local history for the Skylight sign-in callback visited after `since` (unix ms).
 * Reads only URLs that start with the callback prefix, from a private temp copy of each profile's History
 * database that is deleted afterwards. Never logs the URL; any failure for a profile skips that profile.
 */
export async function findCallbackInChromeHistory(o: ChromeHistoryOptions): Promise<string | null> {
  const chromeDir = o.chromeDir ?? path.join(os.homedir(), "Library", "Application Support", "Google", "Chrome");
  const sqlite3 = o.sqlite3Path ?? "/usr/bin/sqlite3";
  const since = chromeTime(o.since);
  if (!Number.isFinite(since)) return null;
  // Only a number is interpolated; the URL prefix is a constant.
  const sql = `select last_visit_time, url from urls where url like '${CALLBACK_PREFIX}%' and last_visit_time > ${since} order by last_visit_time desc limit 1`;

  let entries: string[];
  try { entries = await readdir(chromeDir); } catch { return null; }

  let best: { time: number; url: string } | null = null;
  for (const entry of entries.sort()) {
    const source = path.join(chromeDir, entry, "History");
    let work: string | null = null;
    try {
      work = await mkdtemp(path.join(o.tmpDir ?? os.tmpdir(), "skylight-mcp-history-"));
      const copy = path.join(work, "History");
      await copyFile(source, copy);
      // A rollback journal or WAL next to History may hold in-flight data; copy it alongside (best effort).
      for (const suffix of ["-journal", "-wal"]) {
        try { await copyFile(`${source}${suffix}`, `${copy}${suffix}`); } catch { /* absent or unreadable: ignore */ }
      }
      const { stdout } = await execFileAsync(sqlite3, ["-readonly", copy, sql], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      const line = stdout.trim();
      const bar = line.indexOf("|");
      if (bar < 0) continue;
      const time = Number(line.slice(0, bar));
      const url = line.slice(bar + 1);
      if (Number.isFinite(time) && url.startsWith(CALLBACK_PREFIX) && (best === null || time > best.time)) best = { time, url };
    } catch {
      // Profile without a History file, locked/corrupt DB, or missing sqlite3: skip silently.
    } finally {
      if (work !== null) await rm(work, { recursive: true, force: true });
    }
  }
  return best?.url ?? null;
}
