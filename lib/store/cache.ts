// lib/store/cache.ts — cache 表：快照与派生数据的落地。
//
// 从 store.ts 原样搬来。/health 的快照存这里，省得每次有人看都去问上游；
// 过期是读的时候比时间，不靠定时器清理。

import { store } from "./connection.ts";

/** A cached value, with the time it was written. */
export interface Cached<T> {
  data: T;
  at: number;
}

/** The cached value, if it is not older than the given age. */
function getCached<T>(id: string, maxAgeMs: number): Cached<T> | null {
  const row = store().prepare("SELECT data, at FROM cache WHERE id = ?").get(id) as
    | { data?: string; at?: number }
    | undefined;
  if (!row?.data) return null;
  const at = Number(row.at ?? 0);
  if (maxAgeMs >= 0 && Date.now() - at > maxAgeMs) return null;
  try {
    return { data: JSON.parse(row.data) as T, at };
  } catch {
    return null;
  }
}
/** The cached value, however old it is. */
export function peekCached<T>(id: string): Cached<T> | null {
  return getCached<T>(id, -1);
}

/** Write a cached value. */
export function setCached(id: string, data: unknown): void {
  store()
    .prepare(
      "INSERT INTO cache (id, data, at) VALUES (?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET data = excluded.data, at = excluded.at",
    )
    .run(id, JSON.stringify(data), Date.now());
}

/** The cached rows whose id starts with the prefix. */
export function listCached(prefix = ""): { id: string; at: number }[] {
  const rows = store()
    .prepare("SELECT id, at FROM cache WHERE id LIKE ? ORDER BY at")
    .all(`${prefix}%`) as { id?: string; at?: number }[];
  return rows.map((row) => ({ id: String(row.id ?? ""), at: Number(row.at ?? 0) }));
}

/** Forget a cached value. */
export function deleteCached(id: string): void {
  store().prepare("DELETE FROM cache WHERE id = ?").run(id);
}
