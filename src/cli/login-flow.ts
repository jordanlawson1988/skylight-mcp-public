import type { Runtime } from "../runtime.js";
import { completeLogin, tryCompleteLoginFromChrome } from "./commands.js";
import { findCallbackInChromeHistory } from "./chrome-history.js";

export interface LoginFlowIo {
  /** Show a prompt and return the trimmed answer, or null at end of input. */
  ask(prompt: string): Promise<string | null>;
  write(text: string): void;
}

export type LoginFlowResult = { status: "done"; expiresAt: number } | { status: "quit" };

export const FIRST_PROMPT = "   > ";
export const RETRY_NOTICE =
  "\nNo sign-in found in Chrome's history yet. If the link showed a Skylight sign-in page, sign in there first; you'll be bounced to Skylight's home page, which is fine.\n";
export const RETRY_PROMPT = "Press Enter to check again, paste the callback address, or type q to quit: ";

/**
 * Prompt loop for `skylight-mcp login`. Enter checks Chrome's history, a pasted address completes the login,
 * `q` quits. The pending login (and its TTL) survives retries; completeLogin's own error (for example an expired
 * login or a state mismatch) ends the loop.
 */
export async function runLoginPrompt(rt: Runtime, io: LoginFlowIo, find: (o: { since: number }) => Promise<string | null> = findCallbackInChromeHistory): Promise<LoginFlowResult> {
  let prompt = FIRST_PROMPT;
  for (;;) {
    const answer = await io.ask(prompt);
    if (answer === null) throw new Error("Login prompt closed before finishing. Run `skylight-mcp login` again, or `skylight-mcp login --complete <url>`.");
    if (answer.toLowerCase() === "q") return { status: "quit" };
    if (answer !== "") return { status: "done", ...(await completeLogin(rt, answer)) };
    const result = await tryCompleteLoginFromChrome(rt, find);
    if (result !== null) return { status: "done", expiresAt: result.expiresAt };
    io.write(RETRY_NOTICE);
    prompt = RETRY_PROMPT;
  }
}
