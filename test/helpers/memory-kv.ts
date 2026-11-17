import type { KvLike } from "../../src/remote/account-core.js";

/** An in-memory KvLike (what the Durable Object's storage looks like to AccountCore). */
export function createMemoryKv(): KvLike & { data: Map<string, string>; reads: number; writes: number } {
  const data = new Map<string, string>();
  const kv = {
    data,
    reads: 0,
    writes: 0,
    async get(key: string) { kv.reads += 1; return data.get(key) ?? null; },
    async put(key: string, value: string) { kv.writes += 1; data.set(key, value); },
    async delete(key: string) { kv.writes += 1; data.delete(key); },
  };
  return kv;
}
