import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_SECRETS } from "../remote/env.js";
import { isPlainEmail } from "../remote/identity.js";
import type { Runtime } from "../runtime.js";
import type { KeychainRunner } from "../skylight/credentials.js";
import { AuthError } from "../skylight/errors.js";
import type { OAuthCredential, PkceMethod } from "../skylight/oauth.js";
import { excerpt } from "../skylight/redact.js";
import { formatHuman } from "../skylight/time.js";
import { exchangeLogin, startLogin, type CompleteLogin } from "./commands.js";
import { runLoginPrompt, type LoginFlowIo } from "./login-flow.js";

/**
 * `skylight-mcp remote ...`: the Mac side of the shared server. Secrets it creates go straight into `wrangler secret put`
 * (stdin) and the Keychain; they are never printed or written to a file. remote.json holds only the server URLs.
 */

export const REMOTE_ENVS = ["staging", "production"] as const;
export const REMOTE_COMMANDS = ["setup", "login", "status", "logout", "revoke"] as const;
export type RemoteEnvName = (typeof REMOTE_ENVS)[number];
export const ADMIN_KEYCHAIN_SERVICE = "skylight-mcp.remote-admin";
const ADMIN_TIMEOUT_MS = 20_000;

export type RemoteConfig = Partial<Record<RemoteEnvName, string>>;
export type WranglerRunner = (args: string[], stdin: string) => Promise<{ code: number }>;

export interface RemoteDeps {
  rt: Runtime;
  runner: KeychainRunner;
  wrangler: WranglerRunner;
  /** ~/Library/Application Support/skylight-mcp/remote.json */
  configPath: string;
  io: LoginFlowIo;
  /** Finds the Skylight callback in Chrome's history (injectable for tests). */
  find?: (o: { since: number }) => Promise<string | null>;
}

export const REMOTE_USAGE = `Shared server (Claude and ChatGPT on any device):
  skylight-mcp remote setup --env staging|production --url <https://...workers.dev>
                                                             Save the URL, generate and upload SKYLIGHT_TOKEN_KEY and ADMIN_TOKEN
  skylight-mcp remote login --env staging|production       Sign the shared server in to Skylight (its own grant)
  skylight-mcp remote status --env staging|production      Show the shared server's Skylight sign-in (no secrets)
  skylight-mcp remote logout --env staging|production      Remove the shared server's Skylight sign-in
  skylight-mcp remote revoke <email> --env staging|production
                                                             Disconnect every app that family member connected
`;

// ---- arguments ----

export interface RemoteArgs { sub: string; env: RemoteEnvName; url?: string; email?: string; pkce: PkceMethod }

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function parseRemoteArgs(argv: string[]): RemoteArgs {
  const sub = argv[0] ?? "";
  const env = flag(argv, "--env");
  if (env === undefined) throw new Error("Pass --env staging or --env production.");
  if (!(REMOTE_ENVS as readonly string[]).includes(env)) throw new Error(`--env must be staging or production, not "${env}".`);
  const out: RemoteArgs = { sub, env: env as RemoteEnvName, pkce: flag(argv, "--pkce") === "plain" ? "plain" : "S256" };
  const url = flag(argv, "--url");
  if (argv.includes("--url") && !url) throw new Error("--url needs the server address, e.g. https://skylight-mcp-staging.<you>.workers.dev");
  if (url !== undefined) out.url = url;
  if (sub === "revoke") {
    const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !(all[i - 1]?.startsWith("--")));
    if (positional[0]) out.email = positional[0];
  }
  return out;
}

/** The server's origin: https (http only on loopback, for wrangler dev), no credentials, no path except /mcp. */
export function normalizeServerUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new Error("The server URL must be an absolute address like https://skylight-mcp-staging.<you>.workers.dev"); }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("The server URL must use https.");
  if (url.username || url.password || url.search || url.hash) throw new Error("The server URL must not carry credentials, a query or a fragment.");
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname !== "" && pathname !== "/mcp") throw new Error("Give the server's address (optionally ending in /mcp), nothing else.");
  return url.origin;
}

// ---- remote.json ----

export async function readRemoteConfig(file: string): Promise<RemoteConfig> {
  let raw: string;
  try { raw = await readFile(file, "utf8"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return {}; throw e; }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`${file} is not valid JSON. Fix or delete it, then run \`skylight-mcp remote setup\` again.`); }
  const out: RemoteConfig = {};
  for (const env of REMOTE_ENVS) {
    const v = (parsed as Record<string, unknown> | null)?.[env];
    if (typeof v === "string") out[env] = normalizeServerUrl(v);
  }
  return out;
}

export async function writeRemoteConfig(file: string, config: RemoteConfig): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(tmp, file);
    await chmod(file, 0o600);
  } finally {
    await rm(tmp, { force: true });
  }
}

async function serverUrl(deps: RemoteDeps, env: RemoteEnvName): Promise<string> {
  const url = (await readRemoteConfig(deps.configPath))[env];
  if (!url) throw new Error(`No ${env} server yet. Run \`skylight-mcp remote setup --env ${env} --url <https://...workers.dev>\` first.`);
  return url;
}

// ---- the admin token in the Keychain ----

export async function storeAdminToken(runner: KeychainRunner, url: string, token: string): Promise<void> {
  const r = await runner(["add-generic-password", "-U", "-a", url, "-s", ADMIN_KEYCHAIN_SERVICE, "-l", `skylight-mcp admin token for ${url}`, "-w"], `${token}\n${token}\n`);
  if (r.code !== 0) throw new AuthError(`Could not store the admin token in macOS Keychain (exit ${r.code}).`);
}

export async function readAdminToken(runner: KeychainRunner, url: string): Promise<string> {
  const r = await runner(["find-generic-password", "-a", url, "-s", ADMIN_KEYCHAIN_SERVICE, "-w"]);
  if (r.code === 44) throw new AuthError(`No admin token for ${url} in the Keychain. Run \`skylight-mcp remote setup\` for this server again.`);
  if (r.code !== 0) throw new AuthError(`Could not read the admin token from macOS Keychain (exit ${r.code}).`);
  const token = r.stdout.trim();
  if (token === "") throw new AuthError("The Keychain admin token is empty. Run `skylight-mcp remote setup` again.");
  return token;
}

// ---- admin calls ----

const STATUS_HINT: Record<number, string> = {
  401: "the server refused the admin token; run `skylight-mcp remote setup` for this server again",
  404: "no admin endpoint at that address; check the URL and that the Worker is deployed",
  413: "the request was too large",
  429: "too many admin calls; wait 10 minutes",
  503: "the server is missing ADMIN_TOKEN; run `skylight-mcp remote setup` and deploy",
};

/** Calls an /admin route. Errors name the status only, never a response body (which could echo what was sent). */
async function admin(deps: RemoteDeps, env: RemoteEnvName, method: string, route: string, body?: unknown): Promise<unknown> {
  const url = await serverUrl(deps, env);
  const token = await readAdminToken(deps.runner, url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ADMIN_TIMEOUT_MS);
  let res: Response;
  try {
    res = await deps.rt.fetch(`${url}${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "error",
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) throw new Error(`The ${env} server at ${url} did not answer within ${ADMIN_TIMEOUT_MS / 1000} s.`);
    throw new Error(`Could not reach the ${env} server at ${url}: ${excerpt(e instanceof Error ? e.message : String(e), [token], 200)}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`The ${env} server answered ${res.status}${STATUS_HINT[res.status] ? `: ${STATUS_HINT[res.status]}` : ""}.`);
  try { return JSON.parse(text) as unknown; } catch { throw new Error(`The ${env} server answered with something that is not JSON.`); }
}

// ---- commands ----

function generatedSecret(name: (typeof GENERATED_SECRETS)[number]): string {
  return name === "SKYLIGHT_TOKEN_KEY" ? randomBytes(32).toString("base64") : randomBytes(32).toString("base64url");
}

export async function remoteSetup(deps: RemoteDeps, args: RemoteArgs): Promise<void> {
  const config = await readRemoteConfig(deps.configPath);
  const url = args.url !== undefined ? normalizeServerUrl(args.url) : config[args.env];
  if (!url) throw new Error(`Pass --url with the ${args.env} Worker's address (printed by \`npm run remote:deploy:${args.env}\`), e.g. https://skylight-mcp${args.env === "staging" ? "-staging" : ""}.<you>.workers.dev`);
  await writeRemoteConfig(deps.configPath, { ...config, [args.env]: url });
  deps.io.write(`Saved the ${args.env} server: ${url}\n`);

  for (const name of GENERATED_SECRETS) {
    const value = generatedSecret(name);
    deps.io.write(`Uploading a new ${name} with wrangler...\n`);
    const { code } = await deps.wrangler(["secret", "put", name, "--env", args.env], value);
    if (code !== 0) throw new Error(`\`wrangler secret put ${name} --env ${args.env}\` failed (exit ${code}). Run \`npx wrangler login\` (and deploy once with \`npm run remote:deploy:${args.env}\`), then run setup again.`);
    if (name === "ADMIN_TOKEN") await storeAdminToken(deps.runner, url, value);
  }
  deps.io.write(`
Done: SKYLIGHT_TOKEN_KEY and ADMIN_TOKEN are set on the ${args.env} Worker, and the admin token is in your Keychain.
(Running setup again replaces both; afterwards run \`skylight-mcp remote login --env ${args.env}\` again.)

Still to do, in order:
  1. Google Cloud console > APIs & Services > Credentials > Create OAuth client ID > Web application.
     Authorized redirect URI: ${url}/callback
  2. Give the Worker the Google client and the family list (each command asks for the value):
       npx wrangler secret put GOOGLE_CLIENT_ID --env ${args.env}
       npx wrangler secret put GOOGLE_CLIENT_SECRET --env ${args.env}
       npx wrangler secret put ALLOWED_EMAILS --env ${args.env}      (comma-separated Google emails)
  3. Deploy: npm run remote:deploy:${args.env}
  4. Sign the server in to Skylight: skylight-mcp remote login --env ${args.env}
  5. Add the connector in Claude or ChatGPT with the URL ${url}/mcp
`);
}

/** PUTs a fresh credential to the server; the Mac's own credential store is never touched. */
async function putCredential(deps: RemoteDeps, env: RemoteEnvName, c: OAuthCredential): Promise<void> {
  await admin(deps, env, "PUT", "/admin/skylight-credential", { accessToken: c.accessToken, refreshToken: c.refreshToken, expiresAt: c.expiresAt, fingerprint: c.fingerprint });
}

export async function remoteLogin(deps: RemoteDeps, args: RemoteArgs): Promise<boolean> {
  // Fail before the Skylight sign-in if the server or the admin token is not usable.
  await admin(deps, args.env, "GET", "/admin/skylight-credential");
  const { url } = await startLogin(deps.rt, { method: args.pkce });
  deps.io.write(`\nThis signs the shared ${args.env} server in to Skylight with its own sign-in (this Mac's login is not changed).\n\n1. Open this link in Chrome and sign in to Skylight:\n\n   ${url}\n\n2. Skylight then bounces you to its home page. That's fine: come back here.\n\n3. Press Enter to finish (reads the sign-in result from Chrome's history),\n   or paste the https://ourskylight.com/welcome?code=... address:\n\n`);
  const complete: CompleteLogin = async (rt, callbackUrl) => {
    const credential = await exchangeLogin(rt, callbackUrl);
    await putCredential(deps, args.env, credential);
    return { expiresAt: credential.expiresAt };
  };
  const result = await runLoginPrompt(deps.rt, deps.io, deps.find, complete);
  if (result.status === "quit") {
    deps.io.write("Not finished. The shared server's Skylight sign-in was not changed.\n");
    return false;
  }
  deps.io.write(`\nShared server signed in to Skylight. Token valid until ${formatHuman(new Date(result.expiresAt).toISOString(), deps.rt.config.timezone)}.\n`);
  return true;
}

export async function remoteStatus(deps: RemoteDeps, args: RemoteArgs): Promise<void> {
  const url = await serverUrl(deps, args.env);
  const status = await admin(deps, args.env, "GET", "/admin/skylight-credential") as Record<string, unknown>;
  const expires = typeof status.tokenExpiresAt === "string" ? formatHuman(status.tokenExpiresAt, deps.rt.config.timezone) : null;
  deps.io.write(`${JSON.stringify({ env: args.env, url, mcpUrl: `${url}/mcp`, ...status, tokenExpiresWhen: expires }, null, 2)}\n`);
}

export async function remoteLogout(deps: RemoteDeps, args: RemoteArgs): Promise<boolean> {
  const url = await serverUrl(deps, args.env);
  const answer = await deps.io.ask(`Remove the ${args.env} server's Skylight sign-in (${url})? Family members' tools stop working until \`remote login\`. [y/N] `);
  if (answer === null || !/^y(es)?$/i.test(answer.trim())) {
    deps.io.write("Nothing removed.\n");
    return false;
  }
  const r = await admin(deps, args.env, "DELETE", "/admin/skylight-credential") as { removed?: boolean };
  deps.io.write(r.removed ? "Removed the shared server's Skylight sign-in.\n" : "The shared server had no Skylight sign-in.\n");
  return true;
}

export async function remoteRevoke(deps: RemoteDeps, args: RemoteArgs): Promise<void> {
  const email = args.email?.trim().toLowerCase() ?? "";
  if (!isPlainEmail(email)) throw new Error("Usage: skylight-mcp remote revoke <email> --env staging|production");
  const query = `?email=${encodeURIComponent(email)}`;
  const r = await admin(deps, args.env, "DELETE", `/admin/grants${query}`) as { revoked?: number };
  // Also forget which Google account the email is bound to, so the next sign-in binds again.
  const id = await admin(deps, args.env, "DELETE", `/admin/identity${query}`) as { removed?: boolean };
  const n = r.revoked ?? 0;
  deps.io.write(`Revoked ${n} connection${n === 1 ? "" : "s"} for ${email}${id.removed ? " and cleared its Google account binding" : ""}. They stay off until they connect again (remove them from ALLOWED_EMAILS to keep them out).\n`);
}

export async function runRemote(argv: string[], deps: RemoteDeps): Promise<number> {
  const sub = argv[0];
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") { deps.io.write(REMOTE_USAGE); return sub === undefined ? 2 : 0; }
  if (!(REMOTE_COMMANDS as readonly string[]).includes(sub)) throw new Error(`Unknown remote command "${sub}".\n${REMOTE_USAGE}`);
  const args = parseRemoteArgs(argv);
  switch (args.sub) {
    case "setup": await remoteSetup(deps, args); return 0;
    case "login": return (await remoteLogin(deps, args)) ? 0 : 1;
    case "status": await remoteStatus(deps, args); return 0;
    case "logout": await remoteLogout(deps, args); return 0;
    case "revoke": await remoteRevoke(deps, args); return 0;
    default: throw new Error(`Unknown remote command "${args.sub}".\n${REMOTE_USAGE}`);
  }
}

// ---- real implementations for the CLI entry ----

/** The repository root (where wrangler.jsonc lives): two levels above this file in src/cli or dist/cli. */
export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** Runs the repository's own wrangler (never installs one), feeding `stdin` to it; wrangler's output goes to the terminal. */
export function createWranglerRunner(cwd: string = packageRoot()): WranglerRunner {
  return (args, stdin) => new Promise((resolve) => {
    const child = spawn("npx", ["--no", "wrangler", ...args], { cwd, stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", () => resolve({ code: 127 }));
    child.on("close", (code) => resolve({ code: code ?? 1 }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
}
