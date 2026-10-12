import type { KeychainRunner } from "../../src/skylight/credentials.js";

export function createFakeKeychain(): { runner: KeychainRunner; items: Map<string, string> } {
  const items = new Map<string, string>();
  const key = (args: string[]) => `${args[args.indexOf("-a") + 1]}|${args[args.indexOf("-s") + 1]}`;
  const runner: KeychainRunner = async (args, stdin) => {
    const cmd = args[0];
    if (cmd === "find-generic-password") {
      const v = items.get(key(args));
      return v === undefined ? { code: 44, stdout: "", stderr: "not found" } : { code: 0, stdout: `${v}\n`, stderr: "" };
    }
    if (cmd === "add-generic-password") {
      const value = (stdin ?? "").split("\n")[0] ?? "";
      items.set(key(args), value);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "delete-generic-password") {
      const existed = items.delete(key(args));
      return existed ? { code: 0, stdout: "", stderr: "" } : { code: 44, stdout: "", stderr: "not found" };
    }
    return { code: 1, stdout: "", stderr: `unknown ${cmd}` };
  };
  return { runner, items };
}
