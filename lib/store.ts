// lib/store.ts — where the credentials live: one SQLite file.
//
// Everything secret the gateway holds is in here: the sessions of the eight
// upstreams, the keys the clients authenticate with, the relay station's
// accounts, the salt the device fingerprint is derived from. The file itself
// is 0600, the same as the session files it replaces.
//
// Two more tables live beside them:
//   locks  one writer at a time, because a refresh token rotates on every
//          refresh and two writers would log each other out
//   cache  the snapshot /health serves, so it does not have to ask the
//          upstreams every time somebody looks
//
// And one that is not a secret:
//   config the settings, so the service reads them from here at startup
//          instead of from the environment, and a management panel can
//          write them
//
// Node 24 ships SQLite, so there is no native module to compile.

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "./paths.ts";
// 环境变量的白名单读取（叶子模块，不引 store）：迁移要按部署钉住的地址填行。
import { readEnvValue } from "./env.ts";
// 预置的模拟客户端目录（叶子模块，不引任何东西）：启动时按它把表里的行播出来。
import { SIMULATED_CLIENTS } from "./platform-catalog.ts";
// 凭据 id 的唯一算法（叶子模块）：迁移要按账号定位推理 key 原来存哪、挪到哪。
import { providerSecretId } from "./credential-ids.ts";
// 表长什么样：建表语句归 lib/store/schema.ts，这一层只调度。
import { createTables } from "./store/schema.ts";
// 一次性迁移归 lib/store/migrate-*.ts：这里只按原顺序调度（顺序是行为的一部分）。
import {
  migrateAccountIds,
  migrateProviderToAccounts,
  migrateProviderWeight,
} from "./store/migrate-accounts.ts";
import {
  migrateLegacyVendorKinds,
  migratePlatforms,
  migrateQuotaPluginToBase,
  migrateSimulatedClients,
} from "./store/migrate-platforms.ts";

export { migrateAccountIds, migratePlatforms, migrateSimulatedClients };

/** What kind of secret a row holds. */
export type SecretKind = "session" | "key" | "account" | "salt";

export interface SecretRow {
  id: string;
  kind: string;
  data: any;
  updatedAt: number;
}

let db: DatabaseSync | null = null;

export { dbPath };

/**
 * The open database.
 *
 * A database that cannot be opened is a hard failure: the credentials are in
 * here, and carrying on without them would look like a lost login.
 */
export function store(): DatabaseSync {
  if (db) return db;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(file)) {
    // An empty file is a valid new database, and creating it ourselves is the
    // only way to get the mode right.
    fs.writeFileSync(file, "", { mode: 0o600 });
  } else {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* not ours to change */
    }
  }
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  // The aggregate catalog's targets hang off its models, and the database has
  // to know that to clean up after a model is deleted.
  db.exec("PRAGMA foreign_keys = ON");
  // 表长什么样归 lib/store/schema.ts：这一层只打开连接、调度迁移。
  createTables(db);
  migrateProviderToAccounts(db);
  migrateProviderWeight(db);
  migratePlatforms(db);
  // 模拟客户端那一族的平台行必须在任何 allPlatforms() 之前就位：代码里的
  // PLATFORMS 已经清空（lib/platform-templates.ts），表里没有的行等于平台不存在 ——
  // 路由、面板、额度、目录全都按表里的行找平台。
  migrateSimulatedClients(db);
  migrateAccountIds(db);
  // 编号定下之后再搬凭据：这一段是按账号 id 定位凭据的，id 变了就找不到。
  migrateLegacyVendorKinds(db);
  // 额度插件改按地址认：把存量行上的插件 id 补成地址，再把那一列退场。
  migrateQuotaPluginToBase(db);
  return db;
}



/**
 * 这个预置平台是不是被用户删掉了。
 *
 * 只有播种与面板的删除/新建用得着：判断一个 id 在不在表里用 openPlatformOf。
 */
export function platformPresetRemoved(id: string): boolean {
  return store().prepare("SELECT id FROM platform_preset_removed WHERE id = ?").get(id) !== undefined;
}

/**
 * 记下「用户删掉了这个预置平台」。
 *
 * 与删平台那一行写在同一个事务里（调用方已经开着的那个）：两句话之间断掉，
 * 就会出现「行删了、墓碑没写，重启又长回来」。
 */
export function rememberPlatformPresetRemoved(id: string): void {
  store()
    .prepare("INSERT OR REPLACE INTO platform_preset_removed (id, removed_at) VALUES (?, ?)")
    .run(id, Date.now());
}

/**
 * 用户把这个 id 建回来了，把墓碑清掉。
 *
 * 不清的话，这一行哪天再被删一次也无所谓 —— 问题在下次建的时候：播种见到墓碑就
 * 跳过，可那一行是用户自己建的、归用户，墓碑留着只会误导后来读这张表的人。
 */
export function forgetPlatformPresetRemoved(id: string): void {
  store().prepare("DELETE FROM platform_preset_removed WHERE id = ?").run(id);
}


/* ------------------------------------------------------------------ *
 * The secrets
 * ------------------------------------------------------------------ */

/** Read a secret; a broken row counts as no secret. */
export function getSecret<T>(id: string): T | null {
  const row = store().prepare("SELECT data FROM secrets WHERE id = ?").get(id) as
    | { data?: string }
    | undefined;
  if (!row?.data) return null;
  try {
    const parsed = JSON.parse(row.data);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as T;
  } catch {
    return null;
  }
}

/** Write a secret. */
export function setSecret(id: string, kind: SecretKind, data: unknown): void {
  store()
    .prepare(
      "INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, data = excluded.data, " +
        "updated_at = excluded.updated_at",
    )
    .run(id, kind, JSON.stringify(data), Date.now());
}

/** Forget a secret — the way back to a fresh login. */
export function deleteSecret(id: string): void {
  store().prepare("DELETE FROM secrets WHERE id = ?").run(id);
}

/** Every secret whose id starts with the prefix. */
export function listSecrets(prefix = ""): SecretRow[] {
  const rows = store()
    .prepare("SELECT id, kind, data, updated_at FROM secrets WHERE id LIKE ? ORDER BY id")
    .all(`${prefix.replace(/[%_]/g, "")}%`) as any[];
  return rows.map((r) => {
    let data: any = null;
    try {
      data = JSON.parse(r.data);
    } catch {
      data = null;
    }
    return { id: r.id, kind: r.kind, data, updatedAt: Number(r.updated_at) };
  });
}

/* ------------------------------------------------------------------ *
 * The settings
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * The cache
 * ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ *
 * The lock
 * ------------------------------------------------------------------ */

/** A lock older than this counts as abandoned. */
const LOCK_STALE_MS = 30_000;

/** The lock could not be taken: somebody else is mid-refresh. */
export class LockUnavailableError extends Error {}

/**
 * Single writer around a refresh.
 *
 * Two holders of the same refresh token would rotate it twice and one of them
 * would be logged out, so a refresh takes this lock first. The other writer
 * waits; when the lock is gone it reads the session and finds the fresh token.
 */
export async function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  let acquired = false;
  for (let i = 0; i < 3 && !acquired; i++) {
    try {
      store()
        .prepare("INSERT INTO locks (id, holder, at) VALUES (?, ?, ?)")
        .run(id, String(process.pid), Date.now());
      acquired = true;
    } catch (e) {
      const message = String((e as Error)?.message ?? "");
      if (!message.includes("UNIQUE") && !message.includes("constraint")) throw e;
      const row = store().prepare("SELECT at FROM locks WHERE id = ?").get(id) as { at?: number } | undefined;
      const age = row?.at ? Date.now() - Number(row.at) : LOCK_STALE_MS;
      if (age > LOCK_STALE_MS) {
        try {
          store().prepare("DELETE FROM locks WHERE id = ?").run(id);
        } catch {
          /* someone else won the race */
        }
        continue;
      }
      // Another writer is mid-refresh: wait for its result instead of racing it.
      await new Promise((r) => setTimeout(r, Math.min(LOCK_STALE_MS - age, 2000)));
    }
  }
  if (!acquired) {
    throw new LockUnavailableError(`could not acquire the credential lock (${id})`);
  }
  try {
    return await fn();
  } finally {
    try {
      store().prepare("DELETE FROM locks WHERE id = ?").run(id);
    } catch {
      /* already gone */
    }
  }
}

/** Close the database — only for the tools that open it and are done. */
export function closeStore(): void {
  try {
    db?.close();
  } catch {
    /* nothing to close */
  }
  db = null;
}
