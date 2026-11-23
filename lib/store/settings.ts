// lib/store/settings.ts — config 表：设置的面板写入侧。
//
// 从 store.ts 原样搬来。环境是回落：部署照旧用环境变量，面板写的改动落在这里，
// `null` 表示库里对这个键没有话说。

import { store } from "./connection.ts";

/** One setting, and when it was last written. */
export interface ConfigRow {
  key: string;
  value: string;
  updatedAt: number;
}
/**
 * A setting that was written to the database.
 *
 * The environment is the fallback: the deployment still sets what it always
 * did, and the database is where a panel writes a change. `null` means the
 * database has nothing to say about this key.
 */
export function getConfig(key: string): string | null {
  const row = store().prepare("SELECT value FROM config WHERE key = ?").get(key) as
    | { value?: string }
    | undefined;
  return row?.value ?? null;
}

/** Write a setting to the database. */
export function setConfig(key: string, value: string): void {
  store()
    .prepare(
      "INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    )
    .run(key, value, Date.now());
}

/** Forget a setting — back to whatever the environment says. */
export function deleteConfig(key: string): void {
  store().prepare("DELETE FROM config WHERE key = ?").run(key);
}

/** Every setting the database holds. */
export function listConfig(): ConfigRow[] {
  const rows = store()
    .prepare("SELECT key, value, updated_at FROM config ORDER BY key")
    .all() as any[];
  return rows.map((r) => ({ key: String(r.key), value: String(r.value), updatedAt: Number(r.updated_at) }));
}
