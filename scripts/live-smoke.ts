// Opt-in live checks against the real Skylight API using the stored credential.
// Phase 2 (rewards, routine reorder, lists, events) lives in live-smoke-phase2.ts and runs after the write leg below.
// Read-only by default (also fails if balances or reward costs map to nothing). SKYLIGHT_LIVE_WRITE=1 also exercises one-time and recurring chores end to end (create, update, complete, revert, delete one/all), recurrence variants, a morning routine step (BYHOUR, time-suffixed ids, no single-occurrence delete), an up-for-grabs chore, clearing fields with null, then a profile (create, update, assign a chore, delete, verify gone).
import { createRuntime, assertMacOS, type Runtime } from "../src/runtime.js";
import { listProfiles } from "../src/tools/profiles.js";
import { mapChore, mapChores, mapProfile, mapProfiles, mapRewardPoints, mapRewards } from "../src/skylight/types.js";
import { buildChoreCreateBody, buildChoreUpdateBody, type ChoreInput } from "../src/skylight/chore-payload.js";
import { buildProfileCreateBody, buildProfileUpdateBody } from "../src/skylight/profile-payload.js";
import { localDateString } from "../src/skylight/ids.js";
import { CHORE_STATUS, ROUTINE_SLOTS } from "../src/skylight/vocab.js";
import { deletePathId, planCompletion } from "../src/tools/chores.js";
import { phase2Smoke } from "./live-smoke-phase2.js";

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
  const rawPoints = await rt.client.request<unknown>({ method: "GET", path: `/api/frames/${frameId}/reward_points` });
  const points = mapRewardPoints(rawPoints);
  console.log("points", points);
  const rawPointRows = Array.isArray(rawPoints) ? rawPoints : (rawPoints as { data?: unknown } | null)?.data;
  if (Array.isArray(rawPointRows) && rawPointRows.length > 0 && points.length === 0) throw new Error("reward_points is non-empty but the mapper returned zero balances; the response shape changed");
  const rawRewards = await rt.client.request<unknown>({ method: "GET", path: `/api/frames/${frameId}/rewards` });
  const rewards = mapRewards(rawRewards);
  console.log("rewards", rewards.map((r) => `${r.title}:${String(r.cost)}`).join(", "));
  const rawRewardRows = (rawRewards as { data?: Array<{ id?: unknown; attributes?: { point_value?: unknown } }> } | null)?.data ?? [];
  for (const raw of rawRewardRows) {
    const pv = raw.attributes?.point_value;
    if (typeof pv !== "number") continue;
    const mapped = rewards.find((r) => r.id === String(raw.id));
    if (!mapped || mapped.cost !== pv) throw new Error(`reward ${String(raw.id)} has point_value ${pv} but the mapper returned cost ${String(mapped?.cost)}`);
  }
  if (process.env.SKYLIGHT_LIVE_WRITE !== "1") { console.log("read-only smoke OK (set SKYLIGHT_LIVE_WRITE=1 for write checks)"); return; }
  const profile = profiles.find((p) => p.name === "Jordan") ?? profiles[0];
  if (!profile) throw new Error("no profile to assign to");
  console.log("using profile", `${profile.name}:${profile.id}`);
  await writeSmoke(rt, frameId, profile.id, today);
  await phase2Smoke(rt, frameId, today);
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
  const createFrom = async (input: ChoreInput) => {
    const json = await rt.client.request<unknown>({ method: "POST", path: `${base}/create_multiple`, body: buildChoreCreateBody(input) });
    const created = mapChores(json);
    const chore = created[0] ?? mapChore((json as { data?: unknown } | null)?.data);
    if (!chore) throw new Error("create returned no chore; inspect response shape");
    return chore;
  };
  const create = (summary: string, extra: Partial<ChoreInput> = {}) => createFrom({ summary, start: today, profileIds: [profileId], ...extra });

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

    // Recurrence variants: create each, assert the server echoes the expected rule tokens, delete the whole series.
    const until = addDays(today, 10);
    const variants: Array<{ name: string; recurrence: NonNullable<ChoreInput["recurrence"]>; tokens: string[] }> = [
      { name: "weekly MO,WE", recurrence: { frequency: "weekly", weekdays: ["MO", "WE"] }, tokens: ["FREQ=WEEKLY", "BYDAY=MO,WE"] },
      { name: "monthly on the 15th", recurrence: { frequency: "monthly", monthDay: 15 }, tokens: ["FREQ=MONTHLY", "BYMONTHDAY=15"] },
      { name: "every 2 days", recurrence: { frequency: "daily", interval: 2 }, tokens: ["FREQ=DAILY", "INTERVAL=2"] },
      { name: "daily until +10d", recurrence: { frequency: "daily", until }, tokens: ["FREQ=DAILY", `UNTIL=${until.replaceAll("-", "")}`] },
    ];
    for (const v of variants) {
      const made = await create(`${PREFIX} ${v.name} ${stamp}`, { recurrence: v.recurrence });
      live.set(made.seriesId, true);
      const rule = made.recurrenceRule ?? "";
      const missing = v.tokens.filter((t) => !rule.includes(t));
      if (missing.length > 0) throw new Error(`${v.name}: returned rule "${rule}" lacks ${missing.join(", ")}`);
      await rt.client.request({ method: "DELETE", path: `${base}/${made.seriesId}`, query: { apply_to: "all" } });
      live.delete(made.seriesId);
      step(`recurrence ${v.name} created with ${v.tokens.join(" + ")} and deleted`);
    }

    // Routine step (morning): BYHOUR=6, time-suffixed occurrence ids, complete/revert with instance_time, delete only as a whole series.
    const routine = await create(`${PREFIX} routine ${stamp}`, { routine: true, timeOfDay: "morning" });
    live.set(routine.seriesId, true);
    if (!(routine.recurrenceRule ?? "").includes(`BYHOUR=${ROUTINE_SLOTS.morning}`)) throw new Error(`routine rule lacks BYHOUR=6: ${routine.recurrenceRule}`);
    step(`routine created ${routine.seriesId} (${routine.recurrenceRule})`);
    const routineWindow = await list(today, addDays(today, 3));
    console.log("routine ids in window:", routineWindow.map((c) => c.id).join(", "));
    const todays = routineWindow.find((c) => c.seriesId === routine.seriesId && c.id.endsWith("-0600") && c.instanceDate === today);
    if (!todays) throw new Error("no -0600 occurrence listed for the routine step today");
    if (todays.timeOfDay !== "morning") throw new Error(`routine occurrence timeOfDay=${String(todays.timeOfDay)}`);
    step("routine occurrence id ends with -0600");
    for (const done of [true, false]) {
      const plan = planCompletion({ choreId: todays.id, done });
      if (plan.body.instance_time !== "06:00") throw new Error(`completion body lacks instance_time: ${JSON.stringify(plan.body)}`);
      await rt.client.request({ method: "PUT", path: `${base}/${plan.seriesId}/completions`, body: plan.body });
    }
    step("routine occurrence completed and reverted with instance_time");
    // Routines are all-or-nothing: the tool layer must refuse one/future for a time-suffixed id before any request.
    for (const applyTo of ["one", "future"]) {
      let message = "";
      try { deletePathId(todays.id, applyTo); } catch (e) { message = e instanceof Error ? e.message : String(e); }
      if (!message.includes("Skylight does not allow deleting a single occurrence of a routine step")) throw new Error(`deletePathId did not reject applyTo=${applyTo} for routine id ${todays.id}: "${message}"`);
    }
    step("routine one/future delete rejected by the tool helper");
    await rt.client.request({ method: "DELETE", path: `${base}/${routine.seriesId}`, query: { apply_to: "all" } });
    live.delete(routine.seriesId);
    step("routine series deleted");

    // Up-for-grabs, unassigned, no start date.
    const grabs = await createFrom({ summary: `${PREFIX} grabs ${stamp}`, upForGrabs: true });
    live.set(grabs.seriesId, false);
    if (!grabs.upForGrabs) throw new Error("up-for-grabs chore came back with up_for_grabs=false");
    if (grabs.profileIds.length > 0) throw new Error(`up-for-grabs chore has a category: ${grabs.profileIds.join(",")}`);
    await rt.client.request({ method: "DELETE", path: `${base}/${grabs.seriesId}` });
    live.delete(grabs.seriesId);
    step("up-for-grabs chore created unassigned with no start, then deleted");

    // Clearing fields on update.
    const clearable = await create(`${PREFIX} clear ${stamp}`, { emoji: "🧹", rewardPoints: 3 });
    live.set(clearable.seriesId, false);
    if (clearable.emoji === null || clearable.rewardPoints !== 3) throw new Error(`create did not keep emoji/points: ${JSON.stringify([clearable.emoji, clearable.rewardPoints])}`);
    const cleared = mapChore(((await rt.client.request<unknown>({ method: "PUT", path: `${base}/${clearable.seriesId}`, body: buildChoreUpdateBody({ emoji: null, rewardPoints: null }) })) as { data?: unknown } | null)?.data);
    if (!cleared || cleared.emoji !== null || cleared.rewardPoints !== null) throw new Error(`update with nulls did not clear: ${JSON.stringify(cleared && [cleared.emoji, cleared.rewardPoints])}`);
    await rt.client.request({ method: "DELETE", path: `${base}/${clearable.seriesId}` });
    live.delete(clearable.seriesId);
    step("update with null cleared emoji and rewardPoints");

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
