import { rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Every directory made here is also removed when the test process exits, so a failed assertion
// (which skips the explicit cleanup) cannot leak a skylight-mcp-* directory into os.tmpdir().
const live = new Set<string>();
process.on("exit", () => {
  for (const dir of live) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

export async function makeTmpDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "skylight-mcp-"));
  live.add(dir);
  return { dir, cleanup: async () => { await rm(dir, { recursive: true, force: true }); live.delete(dir); } };
}
