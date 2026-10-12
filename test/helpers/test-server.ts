import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";
import { createRuntime, type Runtime } from "../../src/runtime.js";
import { createFakeKeychain } from "./fake-keychain.js";
import { createMockFetch, type MockRoute, type RecordedCall } from "./mock-fetch.js";
import { makeTmpDir } from "./tmp-dir.js";

export async function connectTestClient(routes: MockRoute[], opts: { loggedIn?: boolean; env?: NodeJS.ProcessEnv; sleep?: (ms: number) => Promise<void>; now?: () => Date } = {}) {
  const { dir, cleanup } = await makeTmpDir();
  const { runner } = createFakeKeychain();
  const { fetch, calls } = createMockFetch(routes);
  const runtime: Runtime = createRuntime({ env: { SKYLIGHT_CREDENTIALS_DIR: dir, ...(opts.env ?? {}) }, fetch, runner, sleep: opts.sleep ?? (async () => {}), ...(opts.now ? { now: opts.now } : {}) });
  if (opts.loggedIn !== false) {
    await runtime.store.write({ version: 1, accessToken: "AT", refreshToken: "RT", fingerprint: "f", expiresAt: Date.now() + 3_600_000 });
  }
  const server = createServer(runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ type: string; text?: string }>).find((c) => c.type === "text")?.text ?? "";
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { isError: r.isError === true, text, data };
  };
  return { client, runtime, calls: calls as RecordedCall[], callTool, close: async () => { await client.close(); await server.close(); await cleanup(); } };
}
