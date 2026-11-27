// lib/store/connection.ts — 那一个 SQLite 连接：db 单例、打开与关闭。
//
// 从 store.ts 原样搬来。单例只有一个：store() 第一次调用时打开文件、建表、
// 按顺序跑迁移，之后所有模块经它拿同一个连接。预置平台的墓碑三函数也在这里 ——
// 它们只碰本层管的 platform_preset_removed 表，放 schema.ts 会让 schema 反向
// 依赖本文件（schema 只该是「表长什么样」的知识）。

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dbPath } from "../paths.ts";
// 表长什么样：建表语句归 lib/store/schema.ts。
import { createTables } from "./schema.ts";
// 一次性迁移：顺序是行为的一部分（哪个先跑决定旧库能不能正确升级），不许重排。
import {
  migrateAccountIds,
  migrateProviderToAccounts,
  migrateProviderWeight,
} from "./migrate-accounts.ts";
import {
  migrateLegacyVendorKinds,
  migratePlatforms,
  migrateQuotaPluginToBase,
  migratePlatformHeaders,
  migrateSimulatedClients,
} from "./migrate-platforms.ts";
import { migrateUsageSessionName } from "./migrate-usage.ts";

let db: DatabaseSync | null = null;
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
  // 注入头模板那一列最后补：前面的迁移按 user_version 判「是否已跑」，版本号
  // 先被推上去的话，旧库的 legacy/vendor/quota 迁移会被整段跳过。
  migratePlatformHeaders(db);
  migrateUsageSessionName(db);
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
/** Close the database — only for the tools that open it and are done. */
export function closeStore(): void {
  try {
    db?.close();
  } catch {
    /* nothing to close */
  }
  db = null;
}
