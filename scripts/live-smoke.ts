// Opt-in live checks against the real Skylight API using the stored credential.
// Read-only by default. SKYLIGHT_LIVE_WRITE=1 also creates, updates, completes and deletes one test chore.
import { createRuntime, assertMacOS } from "../src/runtime.js";
import { listProfiles } from "../src/tools/profiles.js";
import { mapChore, mapChores, mapRewardPoints } from "../src/skylight/types.js";
import { buildChoreCreateBody } from "../src/skylight/chore-payload.js";
import { CHORE_STATUS } from "../src/skylight/vocab.js";

async function main() {
  assertMacOS();
  const rt = createRuntime();
  const frameId = await rt.frames.resolve();
  console.log("frame", frameId);
  const profiles = await listProfiles(rt);
  console.log("profiles", profiles.map((p) => `${p.name}:${p.id}`).join(", "));
  const today = new Date().toISOString().slice(0, 10);
  const chores = mapChores(await rt.client.request({ method: "GET", path: `/api/frames/${frameId}/chores`, query: { after: today, before: today, include_late: true, include_up_for_grabs: true, filter: "linked_to_profile" } }));
  console.log("chores today", chores.length);
  console.log("points", mapRewardPoints(await rt.client.request({ method: "GET", path: `/api/frames/${frameId}/reward_points` })));
  if (process.env.SKYLIGHT_LIVE_WRITE !== "1") { console.log("read-only smoke OK (set SKYLIGHT_LIVE_WRITE=1 for write checks)"); return; }
  const profile = profiles[0];
  if (!profile) throw new Error("no profile to assign to");
  const summary = `[skylight-mcp smoke] ${new Date().toISOString()}`;
  const json = await rt.client.request<unknown>({ method: "POST", path: `/api/frames/${frameId}/chores/create_multiple`, body: buildChoreCreateBody({ summary, start: today, profileIds: [profile.id] }) });
  const created = mapChores(json);
  const id = created[0]?.id ?? mapChore((json as { data?: unknown } | null)?.data)?.id;
  if (!id) throw new Error("create returned no id; inspect response shape");
  console.log("created", id);
  try {
    await rt.client.request({ method: "PUT", path: `/api/frames/${frameId}/chores/${id}`, body: { summary: `${summary} (updated)` } });
    await rt.client.request({ method: "PUT", path: `/api/frames/${frameId}/chores/${id}/completions`, body: { status: CHORE_STATUS.done, instance_date: today, instance_time: null, category_id: profile.id } });
  } finally {
    await rt.client.request({ method: "DELETE", path: `/api/frames/${frameId}/chores/${id}` });
  }
  console.log("write smoke OK (created, updated, completed, deleted)");
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
