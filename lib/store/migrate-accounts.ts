// lib/store/migrate-accounts.ts — 账号那一侧的一次性迁移。
//
// 从 store.ts 原样搬来：旧「一行一个上游」改成「一行一个账号」、补权重列、
// 账号 id 换成数字。都拿调用方传进来的 db，不自己开连接 —— 迁移的先后顺序
// 由 store() 那一层调度，这里只管各步骤自己怎么跑。

import type { DatabaseSync } from "node:sqlite";

/**
 * 把旧的「一行一个上游」改成「一行一个账号」。
 *
 * 旧的行里 `kind` 的值基本上就是平台 id（`minimax`、`qoder`、`qoder-cn`……），
 * 但有两处要修：`workbuddy` 那一行的平台叫 `workbuddy-cn`，`qoder` 那一行要
 * 按 region 分成 `qoder`（全球区）与 `qoder-cn`（中国区）两个平台。
 *
 * 旧行的 `policy` 搬到平台层：一个平台下有多个账号时，取第一个不是默认值的
 * 那个——否则 TokenRhythm 的「余额到期优先」会默默丢掉。
 */
export function migrateProviderToAccounts(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(provider)").all() as { name?: string }[];
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has("kind")) return; // 已经是新的形状了。

  const rows = db
    .prepare("SELECT id, kind, alias, enabled, region, created_at, updated_at FROM provider")
    .all() as any[];
  const policies = has("policy")
    ? (db.prepare("SELECT id, policy FROM provider").all() as any[])
    : [];

  db.exec("ALTER TABLE provider RENAME TO provider_old");
  db.exec(
    `CREATE TABLE provider (
      id         TEXT PRIMARY KEY,
      platform   TEXT NOT NULL,
      alias      TEXT NOT NULL DEFAULT '',
      enabled    INTEGER NOT NULL DEFAULT 1,
      weight     INTEGER NOT NULL DEFAULT 100,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  const insert = db.prepare(
    "INSERT INTO provider (id, platform, alias, enabled, weight, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const setPolicy = db.prepare(
    "INSERT INTO platform_policy (platform, policy, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(platform) DO NOTHING",
  );
  const policyOf = new Map(policies.map((r) => [String(r.id), String(r.policy ?? "single")]));
  const now = Date.now();
  let order = 0;

  for (const row of rows) {
    const platform = platformOfLegacyRow(String(row.kind), String(row.region ?? ""));
    insert.run(
      String(row.id),
      platform,
      String(row.alias ?? ""),
      Number(row.enabled ?? 1) ? 1 : 0,
      // 旧行没有权重：按创建先后给一个递减的，顺序跟从前一样。
      100 - order * 10,
      Number(row.created_at ?? now),
      Number(row.updated_at ?? now),
    );
    order++;
    const policy = policyOf.get(String(row.id));
    if (policy && policy !== "single") setPolicy.run(platform, policy, now);
  }
  db.exec("DROP TABLE provider_old");
}

/**
 * 权重这一列是后来加的：旧的账号行没有它，先补上。
 *
 * 补的默认值按创建先后递减（第一个 100、第二个 90……），这样顺序跟从前一样，
 * 面板上再让人调。
 */
export function migrateProviderWeight(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(provider)").all() as { name?: string }[];
  if (columns.some((c) => c.name === "weight")) return;
  db.exec("ALTER TABLE provider ADD COLUMN weight INTEGER NOT NULL DEFAULT 100");
  const rows = db
    .prepare("SELECT id, platform FROM provider ORDER BY platform, created_at, id")
    .all() as { id?: string; platform?: string }[];
  const perPlatform = new Map<string, number>();
  const set = db.prepare("UPDATE provider SET weight = ? WHERE id = ?");
  for (const row of rows) {
    const platform = String(row.platform ?? "");
    const order = perPlatform.get(platform) ?? 0;
    perPlatform.set(platform, order + 1);
    set.run(100 - order * 10, String(row.id));
  }
}

/** 旧行（kind + region）属于哪个平台。 */
function platformOfLegacyRow(kind: string, region: string): string {
  if (kind === "workbuddy") return "workbuddy-cn";
  if (kind === "qoder") return region === "cn" ? "qoder-cn" : "qoder";
  return kind;
}
/**
 * 账号 id 从「平台名」换成数字。 *
 * 账号 id 现在是一个自增整数（lib/providers.ts 的 nextAccountId），面板只显示
 * alias，所以换号对使用者不可见 —— 但凭据与冷却都按 id 认人，得跟着搬。老库里
 * 还是「平台名」形态（`tokenrhythm`、`qoder`、`workbuddy-cn`），启动时换掉。
 *
 * 幂等：全是数字就整段跳过。
 *
 * 一个事务里改四样：行上的 id、alias、凭据的 id、冷却。中途任何一步抛错就整个
 * 回滚并把错误抛出去 —— 网关宁可起不来，也不能带着「一半账号换了号、另一半还
 * 是旧号」的库对外服务：那会把凭据接到不相干的账号上。
 */
export function migrateAccountIds(db: DatabaseSync): void {
  const rows = db.prepare("SELECT id, alias, created_at FROM provider").all() as {
    id?: string;
    alias?: string;
    created_at?: number;
  }[];
  if (!rows.some((row) => !/^\d+$/.test(String(row.id)))) return;

  // 编号：按建出来的先后（同一时刻再按 id），从现有最大数字往后接 —— 老库里
  // 可能已经有数字 id（新装的库就是），接着排才不会撞号；也不填空洞，删掉的号
  // 不再发放。
  const ordered = [...rows].sort((a, b) => {
    const byTime = Number(a.created_at ?? 0) - Number(b.created_at ?? 0);
    return byTime !== 0 ? byTime : String(a.id).localeCompare(String(b.id));
  });
  let next = 1;
  for (const row of rows) {
    const id = String(row.id);
    if (/^\d+$/.test(id)) next = Math.max(next, Number(id) + 1);
  }
  const mapping = new Map<string, string>();
  for (const row of ordered) {
    const old = String(row.id);
    if (/^\d+$/.test(old)) continue;
    mapping.set(old, String(next++));
  }

  let step = "开事务";
  try {
    db.exec("BEGIN IMMEDIATE");
    // 1. 行上的 id 换号。alias 只在空的时候补旧 id：生产上有人把账号改名成
    //    「中转站 1」，那个名字不能被旧 id 盖掉。
    step = "账号行";
    const renameRow = db.prepare(
      "UPDATE provider SET id = ?, alias = CASE WHEN alias = '' THEN ? ELSE alias END WHERE id = ?",
    );
    for (const [old, fresh] of mapping) renameRow.run(fresh, old, old);
    // 2. 凭据：四种前缀都按冒号边界换中间那一段。
    step = "凭据";
    const secrets = db.prepare("SELECT id FROM secrets").all() as { id?: string }[];
    const renameSecret = db.prepare("UPDATE secrets SET id = ? WHERE id = ?");
    for (const row of secrets) {
      const id = String(row.id);
      const fresh = renamedSecretId(id, mapping);
      if (fresh) renameSecret.run(fresh, id);
    }
    // 3. 冷却：按账号 id 记的，跟着换。
    step = "冷却";
    const renameCooldown = db.prepare("UPDATE cooldown SET provider_id = ? WHERE provider_id = ?");
    for (const [old, fresh] of mapping) renameCooldown.run(fresh, old);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* 事务可能已经没了 */
    }
    throw new Error(
      `账号 id 迁移在「${step}」这一步失败：${(e as Error)?.message ?? String(e)}。` +
        `事务已整个回滚，没有账号被换号；库还是迁移前的样子。`,
    );
  }
}
/**
 * 凭据 id 跟着账号换号。
 *
 * 四种形态：`session:provider:<id>`、`key:provider:<id>`、
 * `key:provider:<id>:<后缀>`、`account:<id>[:<后缀>]`。边界是冒号 ——
 * `key:provider:qoder` 不能把 `key:provider:qoder-cn:…` 一起改掉，那是另一个
 * 账号的凭据。映射里没有的账号（行已经被删掉、凭据留下）原样不动。
 */
function renamedSecretId(id: string, mapping: Map<string, string>): string | null {
  const parts = id.split(":");
  const rebase = (index: number): string | null => {
    const fresh = mapping.get(parts[index] ?? "");
    if (!fresh) return null;
    return [...parts.slice(0, index), fresh, ...parts.slice(index + 1)].join(":");
  };
  if (parts[0] === "session" && parts[1] === "provider" && parts.length === 3) return rebase(2);
  if (parts[0] === "key" && parts[1] === "provider" && parts.length >= 3) return rebase(2);
  if (parts[0] === "account" && parts.length >= 2) return rebase(1);
  return null;
}
