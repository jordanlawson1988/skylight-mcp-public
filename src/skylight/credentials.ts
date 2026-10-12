import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthError } from "./errors.js";
import type { OAuthCredential, PendingLogin } from "./oauth.js";

export type KeychainRunner = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const DEFAULT_SERVICE = "skylight-mcp";
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 50;

export function createKeychainRunner(command = "/usr/bin/security"): KeychainRunner {
  return (args, stdin) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => { child.kill(); reject(new AuthError("macOS Keychain operation timed out.")); }, 15_000);
      child.stdout.setEncoding("utf8").on("data", (c: string) => { stdout += c; });
      child.stderr.setEncoding("utf8").on("data", (c: string) => { stderr += c; });
      child.on("error", (e) => { clearTimeout(timer); reject(new AuthError(`macOS Keychain command failed: ${e.message}`)); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
      child.stdin.end(stdin ?? "");
    });
}

interface Encrypted { version: 1; iv: string; ciphertext: string; tag: string }

export interface CredentialStore {
  read(): Promise<OAuthCredential | null>;
  write(credential: OAuthCredential): Promise<void>;
  delete(): Promise<boolean>;
  readPendingLogin(): Promise<PendingLogin | null>;
  writePendingLogin(pending: PendingLogin): Promise<void>;
  deletePendingLogin(): Promise<void>;
  withRefreshLock<T>(fn: () => Promise<T>): Promise<T>;
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

function isEnoent(e: unknown): boolean {
  return (e as NodeJS.ErrnoException)?.code === "ENOENT";
}

export function createCredentialStore(opts: {
  dir: string; apiBaseUrl: string; runner: KeychainRunner; service?: string; now?: () => number;
}): CredentialStore {
  const service = opts.service ?? DEFAULT_SERVICE;
  const keyService = `${service}.encryption-key`;
  const account = opts.apiBaseUrl;
  const now = opts.now ?? Date.now;
  const credFile = path.join(opts.dir, `${createHash("sha256").update(account).digest("hex")}.json`);
  const pendingFile = path.join(opts.dir, "pending-login.json");
  const lockFile = path.join(opts.dir, "refresh.lock");

  const ensureDir = async () => { await mkdir(opts.dir, { recursive: true, mode: 0o700 }); await chmod(opts.dir, 0o700); };

  const readKey = async (): Promise<Buffer | null> => {
    const r = await opts.runner(["find-generic-password", "-a", account, "-s", keyService, "-w"]);
    if (r.code === 44) return null;
    if (r.code !== 0) throw new AuthError(`Could not read the encryption key from macOS Keychain (exit ${r.code}).`);
    const key = Buffer.from(r.stdout.trim(), "base64");
    if (key.length !== 32) throw new AuthError("The Keychain encryption key is invalid. Run `skylight-mcp login` again.");
    return key;
  };

  const writeKey = async (key: Buffer): Promise<void> => {
    const enc = key.toString("base64");
    const r = await opts.runner(
      ["add-generic-password", "-U", "-a", account, "-s", keyService, "-l", `skylight-mcp credential key for ${account}`, "-w"],
      `${enc}\n${enc}\n`
    );
    if (r.code !== 0) throw new AuthError(`Could not store the encryption key in macOS Keychain (exit ${r.code}).`);
  };

  const deleteKey = async (): Promise<boolean> => {
    const r = await opts.runner(["delete-generic-password", "-a", account, "-s", keyService]);
    if (r.code === 44) return false;
    if (r.code !== 0) throw new AuthError(`Could not remove the encryption key from macOS Keychain (exit ${r.code}).`);
    return true;
  };

  let lockTail: Promise<void> = Promise.resolve();

  return {
    async read() {
      let raw: string;
      try { raw = await readFile(credFile, "utf8"); } catch (e) { if (isEnoent(e)) return null; throw e; }
      const key = await readKey();
      if (key === null) throw new AuthError("Credential file exists but its Keychain key is missing. Run `skylight-mcp login` again.");
      let enc: Encrypted;
      try { enc = JSON.parse(raw) as Encrypted; } catch { throw new AuthError("The credential file is corrupt. Run `skylight-mcp login` again."); }
      try {
        const d = createDecipheriv("aes-256-gcm", key, Buffer.from(enc.iv, "base64"));
        d.setAuthTag(Buffer.from(enc.tag, "base64"));
        const plain = Buffer.concat([d.update(Buffer.from(enc.ciphertext, "base64")), d.final()]).toString("utf8");
        const c = JSON.parse(plain) as OAuthCredential;
        if (c.version !== 1 || typeof c.accessToken !== "string" || typeof c.refreshToken !== "string") throw new Error("shape");
        return c;
      } catch {
        throw new AuthError("The stored credential could not be decrypted. Run `skylight-mcp login` again.");
      }
    },
    async write(credential) {
      await ensureDir();
      let key = await readKey();
      if (key === null) { key = randomBytes(32); await writeKey(key); }
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential), "utf8"), cipher.final()]);
      const enc: Encrypted = { version: 1, iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
      await writeAtomic(credFile, `${JSON.stringify(enc)}\n`);
    },
    async delete() {
      let removedFile = false;
      try { await rm(credFile); removedFile = true; } catch (e) { if (!isEnoent(e)) throw e; }
      const removedKey = await deleteKey();
      await rm(pendingFile, { force: true });
      return removedFile || removedKey;
    },
    async readPendingLogin() {
      try { return JSON.parse(await readFile(pendingFile, "utf8")) as PendingLogin; } catch (e) { if (isEnoent(e)) return null; throw e; }
    },
    async writePendingLogin(pending) {
      await ensureDir();
      await writeAtomic(pendingFile, `${JSON.stringify(pending)}\n`);
    },
    async deletePendingLogin() {
      await rm(pendingFile, { force: true });
    },
    withRefreshLock(fn) {
      // Callers within this process take the file lock in call order; the lockfile then serializes across processes.
      const run = lockTail.then(() => withFileLock(fn));
      lockTail = run.then(() => undefined, () => undefined);
      return run;
    },
  };

  async function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    await ensureDir();
    const deadline = now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const h = await open(lockFile, "wx", 0o600);
        await h.close();
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          const s = await stat(lockFile);
          if (now() - s.mtimeMs > LOCK_STALE_MS) { await rm(lockFile, { force: true }); continue; }
        } catch (se) { if (!isEnoent(se)) throw se; continue; }
        if (now() > deadline) throw new AuthError("Timed out waiting for another skylight-mcp process to finish refreshing the token.");
        await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
      }
    }
    try { return await fn(); } finally { await rm(lockFile, { force: true }); }
  }
}
