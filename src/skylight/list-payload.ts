import { ValidationError } from "./errors.js";
import { assertHexColor, cleanText } from "./ids.js";
import { DEFAULT_LIST_COLOR, DEFAULT_LIST_KIND, LIST_ITEM_STATUS, LIST_KINDS, type ListKind } from "./vocab.js";

export const MAX_LIST_TITLE_LENGTH = 100;
export const MAX_LIST_ITEM_LENGTH = 200;
export const MAX_SECTION_LENGTH = 100;

export interface ListInput { title: string; kind?: ListKind | undefined; color?: string | undefined; hiddenOnDevice?: boolean | undefined }
export interface ListBody { label: string; kind: ListKind; color: string; hide_on_device: boolean }

function assertListKind(value: string, field: string): ListKind {
  const kind = LIST_KINDS.find((k) => k === value);
  if (kind === undefined) throw new ValidationError(field, `must be one of ${LIST_KINDS.join(", ")}`);
  return kind;
}

export function buildListCreateBody(input: ListInput): ListBody {
  return {
    label: cleanText(input.title, "title", MAX_LIST_TITLE_LENGTH),
    kind: assertListKind(input.kind ?? DEFAULT_LIST_KIND, "kind"),
    color: assertHexColor(input.color ?? DEFAULT_LIST_COLOR, "color"),
    hide_on_device: input.hiddenOnDevice ?? false,
  };
}

export function buildListUpdateBody(input: { [K in keyof ListInput]?: ListInput[K] | undefined }): Partial<ListBody> {
  const out: Partial<ListBody> = {};
  if (input.title !== undefined) out.label = cleanText(input.title, "title", MAX_LIST_TITLE_LENGTH);
  if (input.kind !== undefined) out.kind = assertListKind(input.kind, "kind");
  if (input.color !== undefined) out.color = assertHexColor(input.color, "color");
  if (input.hiddenOnDevice !== undefined) out.hide_on_device = input.hiddenOnDevice;
  if (Object.keys(out).length === 0) throw new ValidationError("update", "provide at least one field to change");
  return out;
}

export interface ListItemInput { title: string; section?: string | undefined }
export interface ListItemCreateBody { label: string; section: string | null }
export interface ListItemUpdateBody { label?: string; status?: string; section?: string | null }

export function buildListItemCreateBody(input: ListItemInput): ListItemCreateBody {
  return {
    label: cleanText(input.title, "title", MAX_LIST_ITEM_LENGTH),
    section: input.section === undefined ? null : cleanText(input.section, "section", MAX_SECTION_LENGTH),
  };
}

/** `section: null` moves the item out of its section; omitted leaves it alone. */
export function buildListItemUpdateBody(input: { title?: string | undefined; done?: boolean | undefined; section?: string | null | undefined }): ListItemUpdateBody {
  const out: ListItemUpdateBody = {};
  if (input.title !== undefined) out.label = cleanText(input.title, "title", MAX_LIST_ITEM_LENGTH);
  if (input.done !== undefined) out.status = input.done ? LIST_ITEM_STATUS.done : LIST_ITEM_STATUS.notDone;
  if (input.section !== undefined) out.section = input.section === null ? null : cleanText(input.section, "section", MAX_SECTION_LENGTH);
  if (Object.keys(out).length === 0) throw new ValidationError("update", "provide at least one of title, done or section");
  return out;
}
