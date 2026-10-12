import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { AuthError } from "./errors.js";
import type { OAuthCredential, PendingLogin } from "./oauth.js";

export type KeychainRunner = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

const DEFAULT_SERVICE = "skylight-mcp";
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 50;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

export function createKeychainRunner(command = "/usr/bin/security"): KeychainRunner {
  return (args, stdin) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: true });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => { child.kill(); reject(new AuthError("macOS Keychain operation timed out.")); }, 15_000);
      child.stdout.setEncoding("utf8").on("data", (c: string) => { stdout += c; });
      child.stderr.setEncoding("utf8").on("data", (c: string) => { stderr += c; });
      child.on("error", (e) => { clearTimeout(timer); reject(new AuthError(`macOS Keychain command failed: ${e.message}`)); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
      // detached: no controlling tty, so security(1) getpass() reads the piped key from stdin instead of /dev/tty.
      child.stdin.on("error", () => {}); // EPIPE if the child exits early; the close handler reports the outcome
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

function isPendingLogin(v: unknown): v is PendingLogin {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.state === "string" && typeof p.verifier === "string" && typeof p.fingerprint === "string"
    && typeof p.createdAt === "number" && (p.method === "S256" || p.method === "plain");
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

  // Callers within this process take the file lock in call order; the lockfile then serializes across processes.
  function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = lockTail.then(() => withFileLock(fn));
    lockTail = run.then(() => undefined, () => undefined);
    return run;
  }

  return {
    async read() {
      let raw: string;
      try { raw = await readFile(credFile, "utf8"); } catch (e) { if (isEnoent(e)) return null; throw e; }
      const key = await readKey();
      if (key === null) throw new AuthError("Credential file exists but its Keychain key is missing. Run `skylight-mcp login` again.");
      let enc: Encrypted;
      try { enc = JSON.parse(raw) as Encrypted; } catch { throw new AuthError("The credential file is corrupt. Run `skylight-mcp login` again."); }
      try {
        const iv = Buffer.from(enc.iv, "base64");
        const tag = Buffer.from(enc.tag, "base64");
        if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) throw new Error("bad iv/tag length");
        const d = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
        d.setAuthTag(tag);
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
      const iv = randomBytes(GCM_IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: GCM_TAG_BYTES });
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credential), "utf8"), cipher.final()]);
      const enc: Encrypted = { version: 1, iv: iv.toString("base64"), ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
      await writeAtomic(credFile, `${JSON.stringify(enc)}\n`);
    },
    delete() {
      // Under the refresh lock so logout cannot interleave with a refresh that would re-create the key and credential.
      return withRefreshLock(async () => {
        let removedFile = false;
        try { await rm(credFile); removedFile = true; } catch (e) { if (!isEnoent(e)) throw e; }
        const removedKey = await deleteKey();
        await rm(pendingFile, { force: true });
        return removedFile || removedKey;
      });
    },
    async readPendingLogin() {
      let raw: string;
      try { raw = await readFile(pendingFile, "utf8"); } catch (e) { if (isEnoent(e)) return null; throw e; }
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
      if (!isPendingLogin(parsed)) throw new AuthError("The pending login file is corrupt. Run `skylight-mcp login` again.");
      return parsed;
    },
    async writePendingLogin(pending) {
      await ensureDir();
      await writeAtomic(pendingFile, `${JSON.stringify(pending)}\n`);
    },
    async deletePendingLogin() {
      await rm(pendingFile, { force: true });
    },
    withRefreshLock,
  };

  async function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    await ensureDir();
    const owner = randomBytes(8).toString("hex");
    const deadline = now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const h = await open(lockFile, "wx", 0o600);
        try { await h.writeFile(owner); } finally { await h.close(); }
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (await breakIfStale()) continue;
        if (now() > deadline) throw new AuthError("Timed out waiting for another skylight-mcp process to finish refreshing the token.");
        await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
      }
    }
    try {
      return await fn();
    } finally {
      // Only remove the lockfile if it is still ours; a long holder's lock may have been broken and re-taken.
      try { if ((await readFile(lockFile, "utf8")) === owner) await rm(lockFile, { force: true }); } catch (e) { if (!isEnoent(e)) throw e; }
    }
  }

  // Returns true if the caller should retry the open immediately (lock was gone or was broken by us).
  async function breakIfStale(): Promise<boolean> {
    try {
      const s = await stat(lockFile);
      if (now() - s.mtimeMs <= LOCK_STALE_MS) return false;
    } catch (e) { if (isEnoent(e)) return true; throw e; }
    // rename is atomic: only one waiter gets the stale file; the others see ENOENT and retry the open.
    const aside = `${lockFile}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
    try { await rename(lockFile, aside); } catch (e) { if (isEnoent(e)) return true; throw e; }
    try {
      // If what we moved aside is fresh, another waiter broke the stale lock and took a new one first: put it back.
      const moved = await stat(aside);
      if (now() - moved.mtimeMs <= LOCK_STALE_MS) { await link(aside, lockFile).catch(() => undefined); return false; }
    } catch (e) { if (!isEnoent(e)) throw e; } finally {
      await rm(aside, { force: true });
    }
    return true;
  }
}
