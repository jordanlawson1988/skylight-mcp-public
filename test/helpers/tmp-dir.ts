import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export async function makeTmpDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "skylight-mcp-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
