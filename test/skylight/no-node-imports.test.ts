import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** The Mac credential store (files + Keychain) is the one core module that is Node-only by design. */
const ALLOWED = new Set(["src/skylight/credentials.ts"]);

/** Core code shared by the Mac stdio server and the Cloudflare Worker: src/skylight, src/tools and src/server-core.ts. */
function coreFiles(): string[] {
  const out: string[] = ["src/server-core.ts"];
  const walk = (rel: string) => {
    for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".ts")) out.push(child);
    }
  };
  walk("src/skylight");
  walk("src/tools");
  return out.filter((f) => !ALLOWED.has(f)).sort();
}

function code(file: string): string {
  const text = readFileSync(path.join(root, file), "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

test("the core file list covers the shared modules", () => {
  const files = coreFiles();
  assert.ok(files.length > 30, `only ${files.length} core files found`);
  for (const f of ["src/server-core.ts", "src/skylight/oauth.ts", "src/skylight/config.ts", "src/tools/auth.ts", "src/tools/result.ts"]) assert.ok(files.includes(f), f);
  assert.ok(!files.includes("src/skylight/credentials.ts"));
});

test("nothing under src/skylight, src/tools or src/server-core.ts imports node:* (except the Mac credential store)", () => {
  const offenders = coreFiles().filter((file) => /from\s+["']node:|import\(\s*["']node:|require\(\s*["']node:/.test(code(file)));
  assert.deepEqual(offenders, []);
});

test("core files use no Node-only globals and do not reach into the CLI, the Mac runtime or the credential store", () => {
  const offenders: string[] = [];
  for (const file of coreFiles()) {
    const c = code(file);
    if (/\bBuffer\b/.test(c)) offenders.push(`${file}: Buffer`);
    if (/\bprocess\./.test(c)) offenders.push(`${file}: process`);
    if (/\bNodeJS\./.test(c)) offenders.push(`${file}: NodeJS types`);
    if (/from\s+["'](\.\.\/)+cli\//.test(c) || /from\s+["']\.\/cli\//.test(c)) offenders.push(`${file}: imports the CLI`);
    if (/from\s+["'](\.\.?\/)+runtime\.js["']/.test(c)) offenders.push(`${file}: imports the Mac runtime`);
    if (/from\s+["'](\.\/|\.\.\/skylight\/)credentials\.js["']/.test(c)) offenders.push(`${file}: imports the Mac credential store`);
  }
  assert.deepEqual(offenders, []);
});
