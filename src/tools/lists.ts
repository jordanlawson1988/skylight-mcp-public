import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SkylightApiError, ValidationError } from "../skylight/errors.js";
import { assertId, assertNumericId } from "../skylight/ids.js";
import { buildListCreateBody, buildListItemCreateBody, buildListItemUpdateBody, buildListUpdateBody, MAX_LIST_ITEM_LENGTH, MAX_LIST_TITLE_LENGTH, MAX_SECTION_LENGTH } from "../skylight/list-payload.js";
import { mapList, mapListItem, mapListItems, mapLists, type ListItem } from "../skylight/types.js";
import { DEFAULT_LIST_COLOR, DEFAULT_LIST_KIND, LIST_KINDS } from "../skylight/vocab.js";
import type { ToolContext } from "./context.js";
import { ANNOTATIONS, run, stopReason } from "./result.js";

export const MAX_LIST_ITEMS_PER_CALL = 100;

const listsPath = (frameId: string) => `/api/frames/${frameId}/lists`;
const itemsPath = (frameId: string, listId: string) => `${listsPath(frameId)}/${listId}/list_items`;
const dataOf = (json: unknown): unknown => (json as { data?: unknown } | null)?.data;

function bySectionThenPosition(a: ListItem, b: ListItem): number {
  if (a.section !== b.section) {
    if (a.section === null) return -1;
    if (b.section === null) return 1;
    return a.section < b.section ? -1 : 1;
  }
  if (a.position !== b.position) {
    if (a.position === null) return 1;
    if (b.position === null) return -1;
    return a.position - b.position;
  }
  return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
}

const listIdSchema = z.string().describe("List id from skylight_list_lists.");
const itemIdSchema = z.string().describe("Item id from skylight_list_items.");
const kindSchema = z.enum(LIST_KINDS);

export function registerListTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "skylight_list_lists",
    {
      title: "List lists",
      description: "List the family's Skylight lists (to-do, shopping and other) as { id, title, kind, color, hiddenOnDevice, itemCount }. List ids are needed for every other list tool.",
      inputSchema: {},
      annotations: ANNOTATIONS.read,
    },
    () => run(async () => {
      const frameId = await ctx.frames.resolve();
      return mapLists(await ctx.client.request({ method: "GET", path: listsPath(frameId) }));
    })
  );

  server.registerTool(
    "skylight_list_items",
    {
      title: "List the items on a list",
      description: "Items of one list as { id, title, done, section, position }, sorted by section (items without a section first) and then position. Item ids are needed to update, move and delete items.",
      inputSchema: {
        listId: listIdSchema,
        includeCompleted: z.boolean().optional().describe("Include items that are checked off. Default true."),
      },
      annotations: ANNOTATIONS.read,
    },
    (args) => run(async () => {
      const listId = assertId(args.listId, "listId");
      const frameId = await ctx.frames.resolve();
      const items = mapListItems(await ctx.client.request({ method: "GET", path: itemsPath(frameId, listId) }));
      return items.filter((i) => args.includeCompleted !== false || !i.done).sort(bySectionThenPosition);
    })
  );

  server.registerTool(
    "skylight_create_list",
    {
      title: "Create a list",
      description: `Create a list. kind is ${LIST_KINDS.join(", ")} (default ${DEFAULT_LIST_KIND}); color is a #RRGGBB hex (default ${DEFAULT_LIST_COLOR}); hiddenOnDevice hides it on the Skylight display (default false). Not idempotent: repeating the call creates a second list.`,
      inputSchema: {
        title: z.string().describe(`List name, up to ${MAX_LIST_TITLE_LENGTH} characters, e.g. "Groceries".`),
        kind: kindSchema.optional().describe(`${LIST_KINDS.join(", ")}. Default ${DEFAULT_LIST_KIND}.`),
        color: z.string().optional().describe(`Hex color "#RRGGBB". Default ${DEFAULT_LIST_COLOR}.`),
        hiddenOnDevice: z.boolean().optional().describe("Hide the list on the Skylight display. Default false."),
      },
      annotations: ANNOTATIONS.create,
    },
    (args) => run(async () => {
      const body = buildListCreateBody(args);
      const frameId = await ctx.frames.resolve();
      const json = await ctx.client.request<unknown>({ method: "POST", path: listsPath(frameId), body });
      return mapList(dataOf(json)) ?? { created: true, warning: "Skylight returned no list id; call skylight_list_lists to confirm." };
    })
  );

  server.registerTool(
    "skylight_update_list",
    {
      title: "Update a list",
      description: "Change a list's title, kind, color or hiddenOnDevice. Only the provided fields change.",
      inputSchema: {
        listId: listIdSchema,
        title: z.string().optional().describe(`New name, up to ${MAX_LIST_TITLE_LENGTH} characters.`),
        kind: kindSchema.optional().describe(LIST_KINDS.join(", ")),
        color: z.string().optional().describe("Hex color \"#RRGGBB\"."),
        hiddenOnDevice: z.boolean().optional().describe("Hide the list on the Skylight display."),
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const { listId, ...rest } = args;
      const id = assertId(listId, "listId");
      const body = buildListUpdateBody(rest);
      const frameId = await ctx.frames.resolve();
      const json = await ctx.client.request<unknown>({ method: "PUT", path: `${listsPath(frameId)}/${id}`, body });
      return mapList(dataOf(json)) ?? { id, updated: true };
    })
  );

  server.registerTool(
    "skylight_delete_list",
    {
      title: "Delete a list",
      description: "Delete a list and all of its items. Without confirm: true this makes NO change and returns the list's title and item count. Show that to the user and only call again with confirm: true after they agree.",
      inputSchema: {
        listId: listIdSchema,
        confirm: z.boolean().optional().describe("Must be true to actually delete. Ask the user first."),
      },
      annotations: ANNOTATIONS.destroy,
    },
    (args) => run(async () => {
      const id = assertId(args.listId, "listId");
      const frameId = await ctx.frames.resolve();
      if (args.confirm !== true) {
        const list = mapList(dataOf(await ctx.client.request({ method: "GET", path: `${listsPath(frameId)}/${id}` })));
        if (!list) throw new ValidationError("listId", "Skylight returned no list with that id");
        return {
          confirmed: false,
          wouldDelete: { id: list.id, title: list.title, kind: list.kind, itemCount: list.itemCount },
          message: `Nothing was deleted. This would delete the list "${list.title}" and its ${list.itemCount} ${list.itemCount === 1 ? "item" : "items"}. Ask the user to confirm, then call again with confirm: true.`,
        };
      }
      await ctx.client.request({ method: "DELETE", path: `${listsPath(frameId)}/${id}` });
      return { deleted: true, id };
    })
  );

  server.registerTool(
    "skylight_add_list_items",
    {
      title: "Add items to a list",
      description: `Add up to ${MAX_LIST_ITEMS_PER_CALL} items to a list, one request per item (in order). Every item is validated first; invalid items are reported without stopping the rest, and a rate limit or login failure stops the remaining items. Use dryRun: true to preview the payloads without sending anything. Not idempotent: if some items fail, fix and resend ONLY the failed items; resending the whole batch adds duplicates.`,
      inputSchema: {
        listId: listIdSchema,
        items: z.array(z.object({
          title: z.string().describe(`Item text, up to ${MAX_LIST_ITEM_LENGTH} characters.`),
          section: z.string().optional().describe(`Section (group) name such as "Dairy", up to ${MAX_SECTION_LENGTH} characters. Omit for no section.`),
        })).min(1).max(MAX_LIST_ITEMS_PER_CALL),
        dryRun: z.boolean().optional().describe("true validates and returns the payloads without adding anything."),
      },
      annotations: ANNOTATIONS.create,
    },
    (args) => run(async () => {
      const listId = assertId(args.listId, "listId");
      const built = args.items.map((item, index) => {
        try { return { index, payload: buildListItemCreateBody(item) }; }
        catch (e) { return { index, error: e instanceof Error ? e.message : String(e) }; }
      });
      if (args.dryRun === true) {
        return { dryRun: true, valid: built.filter((b) => "payload" in b).length, invalid: built.filter((b) => "error" in b).length,
          results: built.map((b) => ({ index: b.index, title: args.items[b.index]!.title, ok: !("error" in b), ...("payload" in b ? { payload: b.payload } : { error: b.error }) })) };
      }
      const frameId = await ctx.frames.resolve();
      const results: Array<{ index: number; title: string; ok: boolean; id?: string; warning?: string; error?: string }> = [];
      let stop: string | null = null;
      for (const b of built) {
        const title = args.items[b.index]!.title;
        if ("error" in b) { results.push({ index: b.index, title, ok: false, error: b.error }); continue; }
        if (stop !== null) { results.push({ index: b.index, title, ok: false, error: `not attempted: ${stop}` }); continue; }
        try {
          const created = mapListItem(dataOf(await ctx.client.request<unknown>({ method: "POST", path: itemsPath(frameId, listId), body: b.payload })));
          results.push({ index: b.index, title, ok: true, ...(created ? { id: created.id } : { warning: "Skylight returned no item id; call skylight_list_items to confirm." }) });
        } catch (e) {
          results.push({ index: b.index, title, ok: false, error: e instanceof Error ? e.message : String(e) });
          stop = stopReason(e);
        }
      }
      return { dryRun: false, added: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, results };
    })
  );

  server.registerTool(
    "skylight_update_list_item",
    {
      title: "Update a list item",
      description: "Rename an item (title), check it off or back on (done), or move it to another section (section; null removes it from its section). Only the provided fields change. To change the order inside a section use skylight_move_list_item.",
      inputSchema: {
        listId: listIdSchema,
        itemId: itemIdSchema,
        title: z.string().optional().describe(`New text, up to ${MAX_LIST_ITEM_LENGTH} characters.`),
        done: z.boolean().optional().describe("true checks the item off, false un-checks it."),
        section: z.string().nullable().optional().describe("Section name, or null for no section."),
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const listId = assertId(args.listId, "listId");
      const itemId = assertNumericId(args.itemId, "itemId");
      const body = buildListItemUpdateBody(args);
      const frameId = await ctx.frames.resolve();
      const json = await ctx.client.request<unknown>({ method: "PUT", path: `${itemsPath(frameId, listId)}/${itemId}`, body });
      return mapListItem(dataOf(json)) ?? { id: itemId, updated: true };
    })
  );

  server.registerTool(
    "skylight_move_list_item",
    {
      title: "Reorder a list item",
      description: "Place an item directly after another item (afterItemId), or at the top with afterItemId: null. The target must be in the same section as the item; to change sections use skylight_update_list_item first. Idempotent.",
      inputSchema: {
        listId: listIdSchema,
        itemId: itemIdSchema,
        afterItemId: z.string().nullable().describe("Id of the item to place this one after, or null to move it to the top."),
      },
      annotations: ANNOTATIONS.update,
    },
    (args) => run(async () => {
      const listId = assertId(args.listId, "listId");
      const itemId = assertNumericId(args.itemId, "itemId");
      const afterItemId = args.afterItemId === null ? null : assertNumericId(args.afterItemId, "afterItemId");
      if (afterItemId === itemId) throw new ValidationError("afterItemId", "must be a different item than itemId");
      const frameId = await ctx.frames.resolve();
      try {
        await ctx.client.request({ method: "POST", path: `${itemsPath(frameId, listId)}/${itemId}/move`, body: { after_item_id: afterItemId === null ? null : Number(afterItemId) } });
      } catch (e) {
        if (e instanceof SkylightApiError && e.status === 422 && /same scope/i.test(e.message)) {
          throw new ValidationError("afterItemId", "the target item is in a different section; move the item's section first");
        }
        throw e;
      }
      return { moved: true, listId, itemId, afterItemId };
    })
  );

  server.registerTool(
    "skylight_delete_list_items",
    {
      title: "Delete list items",
      description: `Delete up to ${MAX_LIST_ITEMS_PER_CALL} items from a list in one request. Without confirm: true this makes NO change and returns the titles that would be deleted (and any ids not on the list). Show that to the user and only call again with confirm: true after they agree.`,
      inputSchema: {
        listId: listIdSchema,
        itemIds: z.array(z.string()).min(1).max(MAX_LIST_ITEMS_PER_CALL).describe("Item ids from skylight_list_items."),
        confirm: z.boolean().optional().describe("Must be true to actually delete. Ask the user first."),
      },
      annotations: ANNOTATIONS.destroy,
    },
    (args) => run(async () => {
      const listId = assertId(args.listId, "listId");
      const ids = args.itemIds.map((i) => assertNumericId(i, "itemIds"));
      if (new Set(ids).size !== ids.length) throw new ValidationError("itemIds", "must not repeat");
      const frameId = await ctx.frames.resolve();
      if (args.confirm !== true) {
        const byId = new Map(mapListItems(await ctx.client.request({ method: "GET", path: itemsPath(frameId, listId) })).map((i) => [i.id, i]));
        const items = ids.flatMap((id) => { const hit = byId.get(id); return hit ? [{ id, title: hit.title }] : []; });
        const notFound = ids.filter((id) => !byId.has(id));
        return {
          confirmed: false,
          wouldDelete: { listId, items, notFound },
          message: `Nothing was deleted. This would delete ${items.length} ${items.length === 1 ? "item" : "items"}: ${items.map((i) => `"${i.title}"`).join(", ") || "(none found)"}.${notFound.length > 0 ? ` ${notFound.join(", ")} ${notFound.length === 1 ? "is" : "are"} not on this list.` : ""} Ask the user to confirm, then call again with confirm: true.`,
        };
      }
      await ctx.client.request({ method: "DELETE", path: `${itemsPath(frameId, listId)}/bulk_destroy`, body: { ids: ids.map(Number) } });
      return { deleted: true, listId, ids };
    })
  );
}
