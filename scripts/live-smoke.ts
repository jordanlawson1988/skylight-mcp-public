// Opt-in live checks against the real Skylight API using the stored credential.
// Read-only by default. SKYLIGHT_LIVE_WRITE=1 also exercises one-time and recurring chores end to end (create, update, complete, revert, delete one/all), then a profile (create, update, assign a chore, delete, verify gone).
import { createRuntime, assertMacOS, type Runtime } from "../src/runtime.js";
import { listProfiles } from "../src/tools/profiles.js";
import { mapChore, mapChores, mapProfile, mapProfiles, mapRewardPoints } from "../src/skylight/types.js";
import { buildChoreCreateBody } from "../src/skylight/chore-payload.js";
import { buildProfileCreateBody, buildProfileUpdateBody } from "../src/skylight/profile-payload.js";
import { localDateString } from "../src/skylight/ids.js";
import { CHORE_STATUS } from "../src/skylight/vocab.js";

async function main() {
  assertMacOS();
  const rt = createRuntime();
  const frameId = await rt.frames.resolve();
  console.log("frame", frameId);
  const profiles = await listProfiles(rt);
  console.log("profiles", profiles.map((p) => `${p.name}:${p.id}`).join(", "));
  const today = localDateString();
  const chores = mapChores(await rt.client.request({ method: "GET", path: `/api/frames/${frameId}/chores`, query: { after: today, before: today, include_late: true, include_up_for_grabs: true, filter: "linked_to_profile" } }));
  console.log("chores today", chores.length);
  console.log("points", mapRewardPoints(await rt.client.request({ method: "GET", path: `/api/frames/${frameId}/reward_points` })));
  if (process.env.SKYLIGHT_LIVE_WRITE !== "1") { console.log("read-only smoke OK (set SKYLIGHT_LIVE_WRITE=1 for write checks)"); return; }
  const profile = profiles.find((p) => p.name === "Jordan") ?? profiles[0];
  if (!profile) throw new Error("no profile to assign to");
  console.log("using profile", `${profile.name}:${profile.id}`);
  await writeSmoke(rt, frameId, profile.id, today);
}

const PREFIX = "[skylight-mcp smoke]";

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

async function writeSmoke(rt: Runtime, frameId: string, profileId: string, today: string): Promise<void> {
  const base = `/api/frames/${frameId}/chores`;
  const stamp = new Date().toISOString();
  const steps: string[] = [];
  const step = (name: string) => { steps.push(name); console.log("ok:", name); };
  const list = async (after: string, before: string, includeLate = false) =>
    mapChores(await rt.client.request({ method: "GET", path: base, query: { after, before, include_late: includeLate, include_up_for_grabs: true, filter: "linked_to_profile" } }))
      .filter((c) => c.summary.startsWith(PREFIX));
  const create = async (summary: string, extra: Partial<Parameters<typeof buildChoreCreateBody>[0]> = {}) => {
    const json = await rt.client.request<unknown>({ method: "POST", path: `${base}/create_multiple`, body: buildChoreCreateBody({ summary, start: today, profileIds: [profileId], ...extra }) });
    const created = mapChores(json);
    const chore = created[0] ?? mapChore((json as { data?: unknown } | null)?.data);
    if (!chore) throw new Error("create returned no chore; inspect response shape");
    return chore;
  };

  // Series ids we still need to clean up: id -> whether the chore is recurring.
  const live = new Map<string, boolean>();
  let leftoverCount = 0;
  let leftoverProfiles = 0;
  const catBase = `/api/frames/${frameId}/categories`;
  const smokeProfiles = async () => mapProfiles(await rt.client.request({ method: "GET", path: catBase })).filter((p) => p.name.startsWith(PREFIX));
  // Delete a profile; if the API refuses, convert it to a label (linked_to_profile: false) and delete again.
  const deleteProfile = async (id: string): Promise<string> => {
    try {
      await rt.client.request({ method: "DELETE", path: `${catBase}/${id}` });
      return "deleted directly";
    } catch (e) {
      console.log("profile delete refused:", e instanceof Error ? e.message : e);
      await rt.client.request({ method: "PUT", path: `${catBase}/${id}`, body: buildProfileUpdateBody({ kind: "label" }) });
      await rt.client.request({ method: "DELETE", path: `${catBase}/${id}` });
      return "converted to label, then deleted";
    }
  };
  let smokeProfileId: string | null = null;
  let profileChoreId: string | null = null;
  try {
    // One-time chore: create, update, complete (status only), revert, delete (no apply_to).
    const once = await create(`${PREFIX} once ${stamp}`);
    live.set(once.seriesId, false);
    step(`one-time created ${once.seriesId}`);
    await rt.client.request({ method: "PUT", path: `${base}/${once.seriesId}`, body: { summary: `${PREFIX} once ${stamp} (updated)` } });
    step("one-time updated");
    await rt.client.request({ method: "PUT", path: `${base}/${once.seriesId}/completions`, body: { status: CHORE_STATUS.done } });
    step("one-time completed (status only)");
    await rt.client.request({ method: "PUT", path: `${base}/${once.seriesId}/completions`, body: { status: CHORE_STATUS.notDone } });
    step("one-time reverted");
    await rt.client.request({ method: "DELETE", path: `${base}/${once.seriesId}` });
    live.delete(once.seriesId);
    step("one-time deleted (no apply_to)");

    // Recurring (daily) chore.
    const tomorrow = addDays(today, 1);
    const daily = await create(`${PREFIX} daily ${stamp}`, { recurrence: { frequency: "daily" } });
    live.set(daily.seriesId, true);
    if (!daily.recurring) throw new Error("recurring chore came back with recurring=false");
    step(`recurring created ${daily.seriesId}`);
    const window = await list(today, addDays(today, 3));
    console.log("ids in window:", window.map((c) => c.id).join(", "));
    if (!window.some((c) => c.id === `${daily.seriesId}-${tomorrow}`)) throw new Error("tomorrow's composite occurrence id not listed");
    step("recurring listed with composite ids");
    await rt.client.request({ method: "PUT", path: `${base}/${daily.seriesId}/completions`, body: { status: CHORE_STATUS.done, instance_date: today } });
    step("recurring completed today (instance_date)");
    await rt.client.request({ method: "PUT", path: `${base}/${daily.seriesId}/completions`, body: { status: CHORE_STATUS.notDone, instance_date: today } });
    step("recurring reverted");
    await rt.client.request({ method: "DELETE", path: `${base}/${daily.seriesId}-${tomorrow}`, query: { apply_to: "one" } });
    step("recurring tomorrow deleted (apply_to=one)");
    const after = await list(today, addDays(today, 3));
    console.log("ids after delete-one:", after.map((c) => c.id).join(", "));
    if (after.some((c) => c.id === `${daily.seriesId}-${tomorrow}`)) throw new Error("tomorrow's occurrence still listed after apply_to=one");
    if (after.length === 0) throw new Error("whole series vanished after apply_to=one");
    step("recurring other occurrences remain");
    await rt.client.request({ method: "DELETE", path: `${base}/${daily.seriesId}`, query: { apply_to: "all" } });
    live.delete(daily.seriesId);
    step("recurring series deleted (apply_to=all)");
    const gone = await list(today, addDays(today, 3));
    if (gone.some((c) => c.summary.includes(stamp))) throw new Error("smoke chores still listed after apply_to=all");
    step("list shows none of the smoke chores");

    // Profile: create, update, assign a one-time chore, delete without reassign, verify gone.
    const created = mapProfile(((await rt.client.request<unknown>({ method: "POST", path: catBase, body: buildProfileCreateBody({ name: `${PREFIX} ${stamp}`, color: "#123456", kind: "profile" }) })) as { data?: unknown } | null)?.data);
    if (!created) throw new Error("profile create returned no profile; inspect response shape");
    smokeProfileId = created.id;
    if (created.kind !== "profile") throw new Error(`created profile came back with kind=${String(created.kind)}`);
    step(`profile created ${created.id}`);
    const renamed = `${PREFIX} ${stamp} (updated)`;
    await rt.client.request({ method: "PUT", path: `${catBase}/${created.id}`, body: buildProfileUpdateBody({ name: renamed, color: "#abcdef" }) });
    const afterUpdate = (await smokeProfiles()).find((p) => p.id === created.id);
    if (!afterUpdate || afterUpdate.name !== renamed || afterUpdate.color?.toUpperCase() !== "#ABCDEF") throw new Error(`profile update not reflected: ${JSON.stringify(afterUpdate)}`);
    step("profile updated (name + color)");
    const pchore = await create(`${PREFIX} profile chore ${stamp}`, { profileIds: [created.id] });
    profileChoreId = pchore.seriesId;
    step(`profile chore created ${pchore.seriesId}`);
    const how = await deleteProfile(created.id);
    smokeProfileId = null;
    step(`profile ${how}`);
    if ((await smokeProfiles()).some((p) => p.id === created.id)) throw new Error("smoke profile still listed after delete");
    step("profile gone from the list");
    const choreGone = !(await list(today, addDays(today, 3), true)).some((c) => c.seriesId === pchore.seriesId);
    console.log(choreGone ? "profile chore disappeared with its profile" : "NOTE: profile chore still listed after its profile was deleted");
    step(`profile chore ${choreGone ? "removed with profile" : "survived profile delete"}`);
  } finally {
    if (profileChoreId !== null) {
      try { await rt.client.request({ method: "DELETE", path: `${base}/${profileChoreId}` }); console.log("cleanup deleted profile chore", profileChoreId); }
      catch { /* usually already gone with its profile */ }
    }
    if (smokeProfileId !== null) {
      try { console.log("cleanup profile", smokeProfileId, await deleteProfile(smokeProfileId)); }
      catch (e) { console.error("cleanup FAILED for profile", smokeProfileId, e instanceof Error ? e.message : e); }
    }
    for (const [id, recurring] of live) {
      try {
        await rt.client.request({ method: "DELETE", path: `${base}/${id}`, ...(recurring ? { query: { apply_to: "all" } } : {}) });
        console.log("cleanup deleted", id);
      } catch (e) {
        console.error("cleanup FAILED for", id, e instanceof Error ? e.message : e);
      }
    }
    try {
      const leftover = await list(addDays(today, -1), addDays(today, 14), true);
      leftoverCount = leftover.length;
      if (leftover.length > 0) console.error("LEFTOVER smoke chores:", leftover.map((c) => c.id).join(", "));
      else console.log("no leftover smoke chores");
    } catch (e) {
      console.error("leftover check failed:", e instanceof Error ? e.message : e);
    }
    try {
      const leftover = await smokeProfiles();
      leftoverProfiles = leftover.length;
      if (leftover.length > 0) console.error("LEFTOVER smoke profiles:", leftover.map((p) => `${p.name}:${p.id}`).join(", "));
      else console.log("no leftover smoke profiles");
    } catch (e) {
      console.error("profile leftover check failed:", e instanceof Error ? e.message : e);
    }
  }
  if (leftoverProfiles > 0) throw new Error(`${leftoverProfiles} smoke profile(s) left behind; delete them in the Skylight app or with skylight_delete_profile`);
  if (leftoverCount > 0) throw new Error(`${leftoverCount} smoke chore(s) left behind; the ids may be from a prior run; delete them in the Skylight app or with skylight_delete_chore`);
  console.log(`write smoke OK (${steps.join("; ")})`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
