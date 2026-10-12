import type { SkylightClient } from "./client.js";
import { AuthError, SkylightApiError, ValidationError } from "./errors.js";
import { assertId } from "./ids.js";

export interface FrameSummary { id: string; name: string }

export interface FrameResolver {
  resolve(): Promise<string>;
  list(): Promise<FrameSummary[]>;
}

interface FramesJson { data?: Array<{ id?: unknown; attributes?: { name?: unknown; household_name?: unknown } }> }

export function createFrameResolver(opts: { client: SkylightClient; configuredFrameId: string | null }): FrameResolver {
  let cached: Promise<string> | null = null;

  async function list(): Promise<FrameSummary[]> {
    let json: FramesJson;
    try {
      json = await opts.client.request<FramesJson>({ method: "GET", path: "/api/frames/calendar" });
    } catch (e) {
      if (!(e instanceof SkylightApiError) || e.status !== 404) throw e;
      json = await opts.client.request<FramesJson>({ method: "GET", path: "/api/frames" });
    }
    if (!Array.isArray(json?.data)) throw new SkylightApiError(200, "GET", "/api/frames/calendar", "Frame list response is missing a data array.");
    return json.data.map((f) => {
      if (typeof f.id !== "string" && typeof f.id !== "number") throw new ValidationError("frame id", "missing in frame list");
      const id = assertId(f.id, "frame id");
      const a = f.attributes ?? {};
      const name = typeof a.household_name === "string" ? a.household_name : typeof a.name === "string" ? a.name : "";
      return { id, name };
    });
  }

  async function discover(): Promise<string> {
    const frames = await list();
    if (opts.configuredFrameId !== null) {
      if (frames.some((f) => f.id === opts.configuredFrameId)) return opts.configuredFrameId;
      throw new AuthError(`SKYLIGHT_FRAME_ID=${opts.configuredFrameId} is not one of this account's frames: ${frames.map((f) => f.id).join(", ") || "(none)"}.`);
    }
    if (frames.length === 1) return frames[0]!.id;
    if (frames.length === 0) throw new AuthError("No Skylight frames found on this account.");
    const lines = frames.map((f) => `  ${f.id}${f.name ? ` (${f.name})` : ""}`).join("\n");
    throw new AuthError(`This account has several frames:\n${lines}\nSet SKYLIGHT_FRAME_ID to one of these ids.`);
  }

  return {
    list,
    resolve() {
      if (cached === null) {
        cached = discover().catch((e) => { cached = null; throw e; });
      }
      return cached;
    },
  };
}
