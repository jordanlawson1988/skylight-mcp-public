import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { connectTestClient } from "../helpers/test-server.js";
import type { MockRoute, RecordedCall } from "../helpers/mock-fetch.js";

const FRAMES: MockRoute = { method: "GET", path: "/api/frames/calendar", json: { data: [{ id: "77" }] } };
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8"));
const writes = (t: { calls: RecordedCall[] }) => t.calls.filter((c) => c.method !== "GET");
const item = (id: number | string, label: string, over: Record<string, unknown> = {}) => ({ id: String(id), type: "list_item", attributes: { id: Number(id), label, status: "pending", section: null, position: 1, created_at: "2026-10-12T10:00:00.000Z", draft: false, ...over } });
const listRes = (id: string, label: string, over: Record<string, unknown> = {}, items: string[] = []) => ({ id, type: "list", attributes: { label, color: "#42D792", kind: "to_do", hide_on_device: false, draft: false, default_grocery_list: false, ...over }, relationships: { list_items: { data: items.map((i) => ({ id: i, type: "list_item" })) } } });

test("list lists maps the live fixture", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/lists", json: fixture("lists") }]);
  const r = await t.callTool("skylight_list_lists");
  assert.deepEqual(r.data, [
    { id: "4771333", title: "List 1", kind: "shopping", color: "#42D792", hiddenOnDevice: false, itemCount: 2 },
    { id: "4771334", title: "List 2", kind: "to_do", color: "#A8D4D3", hiddenOnDevice: false, itemCount: 2 },
  ]);
  await t.close();
});

test("list items sorts by section (none first) then position, and can hide completed items", async () => {
  const t = await connectTestClient([FRAMES, { method: "GET", path: "/api/frames/77/lists/5/list_items", json: { data: [
    item(1, "Milk", { section: "Dairy", position: 2 }),
    item(2, "Bread", { section: null, position: 9 }),
    item(3, "Eggs", { section: "Dairy", position: 1, status: "completed" }),
    item(4, "Apples", { section: null, position: 3 }),
    item(5, "Zucchini", { section: "Produce", position: 1 }),
  ] } }]);
  const all = await t.callTool("skylight_list_items", { listId: "5" });
  assert.deepEqual((all.data as Array<{ title: string }>).map((x) => x.title), ["Apples", "Bread", "Eggs", "Milk", "Zucchini"]);
  assert.deepEqual((all.data as Array<unknown>)[2], { id: "3", title: "Eggs", done: true, section: "Dairy", position: 1 });
  const open = await t.callTool("skylight_list_items", { listId: "5", includeCompleted: false });
  assert.deepEqual((open.data as Array<{ title: string }>).map((x) => x.title), ["Apples", "Bread", "Milk", "Zucchini"]);
  assert.equal((await t.callTool("skylight_list_items", { listId: "../5" })).isError, true);
  await t.close();
});

test("create list posts label, kind, color and hide_on_device with defaults", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/lists", json: { data: listRes("9", "Groceries", { kind: "shopping" }) } }]);
  const r = await t.callTool("skylight_create_list", { title: " Groceries ", kind: "shopping" });
  assert.equal(r.isError, false);
  assert.deepEqual(writes(t)[0]!.body, { label: "Groceries", kind: "shopping", color: "#42D792", hide_on_device: false });
  assert.equal((r.data as { id: string }).id, "9");
  await t.callTool("skylight_create_list", { title: "Chores", color: "#cb434c", hiddenOnDevice: true });
  assert.deepEqual(writes(t)[1]!.body, { label: "Chores", kind: "to_do", color: "#CB434C", hide_on_device: true });
  await t.close();
});

test("create list validates before any request", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/lists", json: { data: listRes("9", "x") } }]);
  for (const args of [{ title: "  " }, { title: "x".repeat(101) }, { title: "x", kind: "weekly" }, { title: "x", color: "red" }]) {
    assert.equal((await t.callTool("skylight_create_list", args)).isError, true, JSON.stringify(args));
  }
  assert.equal(writes(t).length, 0);
  await t.close();
});

test("update list PUTs only the provided fields", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/lists/9", json: { data: listRes("9", "Weekend") } }]);
  const r = await t.callTool("skylight_update_list", { listId: "9", title: "Weekend", hiddenOnDevice: true });
  assert.equal(r.isError, false);
  assert.deepEqual(writes(t)[0]!.body, { label: "Weekend", hide_on_device: true });
  assert.equal((await t.callTool("skylight_update_list", { listId: "9" })).isError, true);
  assert.equal((await t.callTool("skylight_update_list", { listId: "a/b", title: "x" })).isError, true);
  assert.equal(writes(t).length, 1);
  await t.close();
});

test("delete list previews title and item count, then deletes on confirm", async () => {
  const t = await connectTestClient([FRAMES,
    { method: "GET", path: "/api/frames/77/lists/9", json: { data: listRes("9", "Groceries", { kind: "shopping" }, ["1", "2", "3"]) } },
    { method: "DELETE", path: "/api/frames/77/lists/9", json: {} }]);
  const r = await t.callTool("skylight_delete_list", { listId: "9" });
  const d = r.data as { confirmed: boolean; wouldDelete: Record<string, unknown>; message: string };
  assert.equal(d.confirmed, false);
  assert.deepEqual(d.wouldDelete, { id: "9", title: "Groceries", kind: "shopping", itemCount: 3 });
  assert.match(d.message, /Nothing was deleted/);
  assert.match(d.message, /3 items/);
  assert.equal(writes(t).length, 0);
  const done = await t.callTool("skylight_delete_list", { listId: "9", confirm: true });
  assert.deepEqual(done.data, { deleted: true, id: "9" });
  assert.equal(writes(t).length, 1);
  assert.equal(writes(t)[0]!.method, "DELETE");
  await t.close();
});

test("add list items posts one item per call, sequentially, with label and section", async () => {
  let n = 100;
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/lists/5/list_items", handler: ({ body }) => ({ json: { data: item(++n, (body as { label: string }).label) } }) }]);
  const r = await t.callTool("skylight_add_list_items", { listId: "5", items: [{ title: "Milk", section: "Dairy" }, { title: " Bread " }] });
  assert.equal(r.isError, false);
  assert.deepEqual(writes(t).map((c) => c.body), [{ label: "Milk", section: "Dairy" }, { label: "Bread", section: null }]);
  const d = r.data as { dryRun: boolean; added: number; failed: number; results: Array<{ ok: boolean; id?: string }> };
  assert.deepEqual([d.dryRun, d.added, d.failed], [false, 2, 0]);
  assert.deepEqual(d.results.map((x) => x.id), ["101", "102"]);
  await t.close();
});

test("add list items: dryRun sends nothing; invalid items are reported and skipped", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/lists/5/list_items", json: { data: item(1, "x") } }]);
  const dry = await t.callTool("skylight_add_list_items", { listId: "5", dryRun: true, items: [{ title: "A" }, { title: "  " }] });
  const dd = dry.data as { dryRun: boolean; valid: number; invalid: number; results: Array<{ ok: boolean; payload?: unknown; error?: string }> };
  assert.deepEqual([dd.dryRun, dd.valid, dd.invalid], [true, 1, 1]);
  assert.deepEqual(dd.results[0]!.payload, { label: "A", section: null });
  assert.match(dd.results[1]!.error!, /title/);
  assert.equal(writes(t).length, 0);
  const real = await t.callTool("skylight_add_list_items", { listId: "5", items: [{ title: "A" }, { title: "" }, { title: "C", section: "x".repeat(101) }, { title: "D" }] });
  const d = real.data as { added: number; failed: number; results: Array<{ ok: boolean; error?: string }> };
  assert.deepEqual([d.added, d.failed], [2, 2]);
  assert.equal(writes(t).length, 2);
  await t.close();
});

test("add list items continues past a server failure but stops on rate limiting", async () => {
  let n = 0;
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/lists/5/list_items", handler: () => (++n === 2 ? { status: 500, text: "boom" } : { json: { data: item(n, "x") } }) }]);
  const r = await t.callTool("skylight_add_list_items", { listId: "5", items: ["a", "b", "c"].map((title) => ({ title })) });
  const d = r.data as { added: number; failed: number; results: Array<{ ok: boolean; error?: string }> };
  assert.deepEqual([d.added, d.failed], [2, 1]);
  assert.equal(d.results[1]!.ok, false);
  await t.close();
  let m = 0;
  const t2 = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/lists/5/list_items", handler: () => (++m === 2 ? { status: 429, text: "slow down" } : { json: { data: item(m, "x") } }) }]);
  const r2 = await t2.callTool("skylight_add_list_items", { listId: "5", items: ["a", "b", "c"].map((title) => ({ title })) });
  const d2 = r2.data as { added: number; results: Array<{ ok: boolean; error?: string }> };
  assert.equal(d2.added, 1);
  assert.match(d2.results[2]!.error!, /not attempted: rate limited/);
  assert.equal(writes(t2).length, 2);
  await t2.close();
});

test("add list items caps at 100 items and tells the model to resend only failures", async () => {
  const t = await connectTestClient([FRAMES]);
  const r = await t.callTool("skylight_add_list_items", { listId: "5", items: Array.from({ length: 101 }, (_, i) => ({ title: `i${i}` })) });
  assert.equal(r.isError, true);
  assert.equal(writes(t).length, 0);
  const tool = (await t.client.listTools()).tools.find((x) => x.name === "skylight_add_list_items")!;
  assert.match(tool.description ?? "", /ONLY the failed items/);
  await t.close();
});

test("update list item PUTs label, status and section; null clears the section", async () => {
  const t = await connectTestClient([FRAMES, { method: "PUT", path: "/api/frames/77/lists/5/list_items/7", json: { data: item(7, "Oat milk", { status: "completed" }) } }]);
  const r = await t.callTool("skylight_update_list_item", { listId: "5", itemId: "7", title: "Oat milk", done: true, section: "Dairy" });
  assert.equal(r.isError, false);
  assert.deepEqual(writes(t)[0]!.body, { label: "Oat milk", status: "completed", section: "Dairy" });
  assert.equal((r.data as { done: boolean }).done, true);
  await t.callTool("skylight_update_list_item", { listId: "5", itemId: "7", done: false, section: null });
  assert.deepEqual(writes(t)[1]!.body, { status: "pending", section: null });
  assert.equal((await t.callTool("skylight_update_list_item", { listId: "5", itemId: "7" })).isError, true);
  assert.equal((await t.callTool("skylight_update_list_item", { listId: "5", itemId: "x7", title: "a" })).isError, true);
  assert.equal(writes(t).length, 2);
  await t.close();
});

test("move list item posts after_item_id as a number, or null for the top", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/lists/5/list_items/7/move", json: {} }]);
  const r = await t.callTool("skylight_move_list_item", { listId: "5", itemId: "7", afterItemId: "3" });
  assert.equal(r.isError, false);
  assert.deepEqual(writes(t)[0]!.body, { after_item_id: 3 });
  assert.deepEqual(r.data, { moved: true, listId: "5", itemId: "7", afterItemId: "3" });
  await t.callTool("skylight_move_list_item", { listId: "5", itemId: "7", afterItemId: null });
  assert.deepEqual(writes(t)[1]!.body, { after_item_id: null });
  assert.equal((await t.callTool("skylight_move_list_item", { listId: "5", itemId: "7", afterItemId: "7" })).isError, true);
  assert.equal((await t.callTool("skylight_move_list_item", { listId: "5", itemId: "7", afterItemId: "abc" })).isError, true);
  assert.equal((await t.callTool("skylight_move_list_item", { listId: "5", itemId: "7" })).isError, true);
  assert.equal(writes(t).length, 2);
  await t.close();
});

test("move list item maps the same-section 422 to guidance and leaves other errors alone", async () => {
  const t = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/lists/5/list_items/7/move", status: 422, json: { errors: ["After item must be in the same scope"] } }]);
  const r = await t.callTool("skylight_move_list_item", { listId: "5", itemId: "7", afterItemId: "3" });
  assert.equal(r.isError, true);
  assert.match(r.text, /^Invalid input\. afterItemId: the target item is in a different section; move the item's section first/);
  await t.close();
  const t2 = await connectTestClient([FRAMES, { method: "POST", path: "/api/frames/77/lists/5/list_items/7/move", status: 422, json: { errors: ["Something else"] } }]);
  const r2 = await t2.callTool("skylight_move_list_item", { listId: "5", itemId: "7", afterItemId: "3" });
  assert.equal(r2.isError, true);
  assert.match(r2.text, /Something else/);
  await t2.close();
});

test("delete list items previews the titles from one read, then bulk_destroys with numeric ids", async () => {
  const t = await connectTestClient([FRAMES,
    { method: "GET", path: "/api/frames/77/lists/5/list_items", json: { data: [item(1, "Milk"), item(2, "Bread"), item(3, "Eggs")] } },
    { method: "DELETE", path: "/api/frames/77/lists/5/list_items/bulk_destroy", json: {} }]);
  const r = await t.callTool("skylight_delete_list_items", { listId: "5", itemIds: ["1", "3", "99"] });
  const d = r.data as { confirmed: boolean; wouldDelete: { listId: string; items: Array<{ id: string; title: string }>; notFound: string[] }; message: string };
  assert.equal(d.confirmed, false);
  assert.deepEqual(d.wouldDelete, { listId: "5", items: [{ id: "1", title: "Milk" }, { id: "3", title: "Eggs" }], notFound: ["99"] });
  assert.match(d.message, /Nothing was deleted/);
  assert.equal(writes(t).length, 0);
  assert.equal(t.calls.filter((c) => c.url.pathname.endsWith("/list_items")).length, 1);
  const done = await t.callTool("skylight_delete_list_items", { listId: "5", itemIds: ["1", "3"], confirm: true });
  assert.deepEqual(done.data, { deleted: true, listId: "5", ids: ["1", "3"] });
  assert.equal(writes(t).length, 1);
  assert.deepEqual(writes(t)[0]!.body, { ids: [1, 3] });
  await t.close();
});

test("delete list items rejects bad, duplicate or too many ids before any request", async () => {
  const t = await connectTestClient([FRAMES, { method: "DELETE", path: /bulk_destroy/, json: {} }]);
  for (const itemIds of [[], ["1", "1"], ["abc"], ["1/2"], Array.from({ length: 101 }, (_, i) => String(i + 1))]) {
    assert.equal((await t.callTool("skylight_delete_list_items", { listId: "5", itemIds, confirm: true })).isError, true, JSON.stringify(itemIds).slice(0, 40));
  }
  assert.equal(t.calls.length, 0);
  await t.close();
});

test("list tools are annotated: read, create, update, destroy", async () => {
  const t = await connectTestClient([FRAMES]);
  const tools = new Map((await t.client.listTools()).tools.map((x) => [x.name, x]));
  const a = (n: string) => tools.get(n)!.annotations!;
  assert.equal(a("skylight_list_lists").readOnlyHint, true);
  assert.equal(a("skylight_list_items").readOnlyHint, true);
  assert.equal(a("skylight_create_list").destructiveHint, false);
  assert.equal(a("skylight_add_list_items").destructiveHint, false);
  for (const n of ["skylight_update_list", "skylight_update_list_item", "skylight_move_list_item"]) assert.equal(a(n).idempotentHint, true, n);
  for (const n of ["skylight_delete_list", "skylight_delete_list_items"]) {
    assert.deepEqual([a(n).destructiveHint, a(n).idempotentHint], [true, false], n);
    assert.match(tools.get(n)!.description ?? "", /confirm: true/);
  }
  await t.close();
});
