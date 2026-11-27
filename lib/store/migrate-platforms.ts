// lib/store/migrate-platforms.ts — 平台那一侧的一次性迁移。
//
// 从 store.ts 原样搬来：平台表补列、schema 版本号、厂商 kind 退场、额度插件
// 改按地址认、模拟客户端播种。都拿调用方传进来的 db，迁移的先后顺序由 store()
// 那一层调度 —— 顺序是行为的一部分（哪个先跑决定旧库能不能正确升级），不许重排。

import type { DatabaseSync } from "node:sqlite";
// 环境变量的白名单读取（叶子模块）：legacySetting 要按部署钉住的地址填行。
import { readEnvValue } from "../env.ts";
// 预置的模拟客户端目录（叶子模块）：播种按它把表里的行播出来。
import { SIMULATED_CLIENTS } from "../platform-catalog.ts";
// 凭据 id 的唯一算法（叶子模块）：厂商 kind 退场要按账号定位推理 key 原来存哪。
import { providerSecretId } from "../credential-ids.ts";
import { jsonObjectOf } from "../dialect/json-value.ts";
// legacySetting 读的设置在 settings 模块里：环境先、库里其次、默认最后。
import { getConfig } from "./settings.ts";

/**
 * 平台表的迁移：补两列。
 *
 * 导出：测试要能单独再跑一次（老库模拟），迁移本身得能被调用。
 */
export function migratePlatforms(db: DatabaseSync): void {
  migratePlatformColumns(db);
}

/**
 * 平台表补两列：kind 与 region。
 *
 * `kind` 是「怎么跟它说话」（kind 注册表里的那一类），`region` 是「在哪个区域」。
 * 这两样以前只存在于代码里的模板（lib/platform-templates.ts），平台迁进表里就得
 * 有地方放。旧库没有这两列：补上，缺的那一列按缺省算（kind 是 openai ——
 * 表里那些行都是用户自己加的开放平台；region 是空串）。
 */
function migratePlatformColumns(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(platform)").all() as { name?: string }[];
  const has = (name: string) => columns.some((c) => c.name === name);
  if (!has("kind")) db.exec("ALTER TABLE platform ADD COLUMN kind TEXT NOT NULL DEFAULT 'openai'");
  if (!has("region")) db.exec("ALTER TABLE platform ADD COLUMN region TEXT NOT NULL DEFAULT ''");
  // 共性表那个开关也是后来加的：老库没有这一列，补成开（与新建的库一样）。
  if (!has("traits_from_common")) {
    db.exec("ALTER TABLE platform ADD COLUMN traits_from_common INTEGER NOT NULL DEFAULT 1");
  }
  backfillTraitsFromCommon(db);
}
/**
 * 库的 schema 版本：SQLite 自己的 `PRAGMA user_version`。
 *
 * 只用在「光看列与数据判断不了一次性」的迁移上：`traits_from_common` 这一列早就
 * 在库里了（默认值当时是 0），光看列存不存在永远不知道这一遍跑没跑过 —— 于是每
 * 次启动都会把用户后来关掉的那个开关重新打开。版本号记在库里，跑过一次就不再动。
 *
 * 每一步有自己的号、各判各的：用一个「当前版本」去找前面的步，后加的步就会把
 * 前面那些重跑一遍（`traits_from_common` 抹回 1，用户关掉的那一格就没了）。
 */
const TRAITS_VERSION = 1;
const LEGACY_VENDOR_KIND_VERSION = 2;
/** 平台行的注入头模板：列存在与否就是「跑没跑过」，版本号只为后续步骤递增留基线。 */
const PLATFORM_HEADERS_VERSION = 5;

/** 库的 schema 版本现在是多少（没写过就是 0）。 */
export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/** 把版本推到 n；已经更高就不动（步骤是往上堆的，不能回写旧号）。 */
export function setSchemaVersion(db: DatabaseSync, n: number): void {
  if (schemaVersion(db) >= n) return;
  db.exec(`PRAGMA user_version = ${n}`);
}

/**
 * 存量行的 `traits_from_common` 从 0 补成 1，只做一次。
 *
 * 补的是「这一层以前根本没人开过」这件事：老库 12 个平台全是 0，等于共性表那一
 * 层从上线起就没通过电。第一次跑到这里之后写 schema 版本，之后就再也不碰这一
 * 列 —— 用户在那之后自己关掉的平台必须保持关着。
 */
function backfillTraitsFromCommon(db: DatabaseSync): void {
  if (schemaVersion(db) >= TRAITS_VERSION) return;
  db.exec("UPDATE platform SET traits_from_common = 1");
  setSchemaVersion(db, TRAITS_VERSION);
}
/**
 * 退场的厂商 kind：它们一直用的推理地址，与推理 key 原来在哪一段凭据里。
 *
 * 地址是常量而不是 `baseUrl()`：那五家的 `baseUrl()` 根本不读平台行，一直返回
 * 这几个常量 —— 行里存的地址从来没生效过。迁移把当时真正生效的那台写进行里，
 * 否则那条不知哪来的旧地址会在迁移后突然变成生效地址。
 *
 * key 的位置：七牛/星火/SenseNova 在 `:account` 的 `apiKey`，孟点（intern-ai）
 * 在 `:account` 的 `discoveryKey`，TokenRhythm 在 `:account#api_key` 的 `apiKey`。
 */
const LEGACY_VENDOR_KINDS: readonly {
  kind: string;
  baseUrl: string;
  /** 推理 key 原来那段凭据的后缀（`providerSecretId(账号, 后缀)`）。 */
  secretSuffix: string;
  /** 那段凭据里装 key 的那一格。 */
  keyField: string;
}[] = [
  { kind: "qiniu", baseUrl: "https://api.qnaigc.com/v1", secretSuffix: "account", keyField: "apiKey" },
  {
    kind: "xinghuo",
    baseUrl: "https://maas-api.cn-huabei-1.xf-yun.com/v2",
    secretSuffix: "account",
    keyField: "apiKey",
  },
  {
    kind: "sensenova",
    baseUrl: "https://token.sensenova.cn/v1",
    secretSuffix: "account",
    keyField: "apiKey",
  },
  {
    kind: "intern-ai",
    baseUrl: "https://discovery-api.intern-ai.org.cn/v1",
    secretSuffix: "account",
    keyField: "discoveryKey",
  },
  {
    kind: "tokenrhythm",
    baseUrl: "https://tokenrhythm.studio/v1",
    secretSuffix: "account#api_key",
    keyField: "apiKey",
  },
];

/**
 * 五个厂商 kind 退场（2026-11）：存量行改成通用方言 `openai`。
 *
 * 为什之要改：那五家不再是「能新建的一类平台」（面板上只剩两种方言与模拟客户端），
 * 它们名下已经建过的行不能因此变成没人认得的 kind —— kind 认不出 = 无路可走。
 *
 * 两件事一起做，顺序有意义：
 *
 *   1. 凭据先搬。推理 key 从各处搬到开放平台读的那一处（`:key` 的 `{apiKey}`）。
 *      不搬的话，迁移之后每个账号都是「没凭据」：面板显示 MISSING，路由发不出去。
 *      原来那段（`:account` …）一律不动 —— 额度插件读的就是它（七牛的门户 cookie
 *      就在同一段里）。
 *   2. 平台行改 kind 与地址。地址写当时真正生效的那台（见 LEGACY_VENDOR_KINDS）。
 *      `models`（含 traits）也不动：目录本来就在行里，不属于 kind。
 *   3. 策略值不动：`expiry_first` 是一等策略（按余额到期挑账号），任何平台都能选 ——
 *      它不随 kind 走，因此这里不重写。
 *
 * 幂等：版本号到了就不再跑；凭据那一步还另判「目标已有就不覆盖」，手动重跑一遍
 * 也只会把已经对的东西再对一遍。
 */
export function migrateLegacyVendorKinds(db: DatabaseSync): void {
  if (schemaVersion(db) >= LEGACY_VENDOR_KIND_VERSION) return;
  const now = Date.now();
  const readSecret = db.prepare("SELECT data FROM secrets WHERE id = ?");
  const writeSecret = db.prepare(
    "INSERT INTO secrets (id, kind, data, updated_at) VALUES (?, 'key', ?, ?) " +
      "ON CONFLICT(id) DO NOTHING",
  );
  const accountsOfKind = db.prepare(
    "SELECT p.id AS id FROM provider p JOIN platform pl ON pl.id = p.platform WHERE pl.kind = ?",
  );

  for (const legacy of LEGACY_VENDOR_KINDS) {
    for (const row of accountsOfKind.all(legacy.kind) as { id?: string }[]) {
      const accountId = String(row.id ?? "");
      if (!accountId) continue;
      const from = readSecret.get(providerSecretId(accountId, legacy.secretSuffix)) as
        | { data?: string }
        | undefined;
      if (!from?.data) continue;
      let apiKey = "";
      try {
        const parsed: unknown = JSON.parse(from.data);
        const fields = jsonObjectOf(parsed);
        apiKey = String(fields?.[legacy.keyField] ?? "").trim();
      } catch {
        // 读不出来的凭据就是没凭据：下面的写入自然跳过它。
        continue;
      }
      if (!apiKey) continue;
      writeSecret.run(providerSecretId(accountId, "key"), JSON.stringify({ apiKey }), now);
    }
  }

  const moveKind = db.prepare(
    "UPDATE platform SET kind = 'openai', base_url = ?, updated_at = ? WHERE kind = ?",
  );
  for (const legacy of LEGACY_VENDOR_KINDS) moveKind.run(legacy.baseUrl, now, legacy.kind);

  setSchemaVersion(db, LEGACY_VENDOR_KIND_VERSION);
}
/**
 * 额度插件改按地址认（schema 版本 4）：存量行上的 `quota_plugin` 退场。
 *
 * 新的判据是平台行的 base_url：对上哪个插件声明的地址，额度插件就是哪个 ——
 * 用户不选，也没有「没选」这一说。所以迁移做两件事，都只跑一次：
 *
 *   1. 只给「地址为空」的行补上规范地址。存量行上 `quota_plugin` 指着某个
 *      已知插件、而行上地址空着时，把该插件的规范地址写进去 —— 空地址的行
 *      本来也发不出去，补上才认得出额度插件。
 *
 *      **非空的地址一律不动。** 用户把某个平台指到自建端点或假上游是合法且
 *      有文档的用法；把它改回厂商地址，等于把请求从用户指定的地方搬到真
 *      上游（2026-11 review 的阻塞项）。地址认不出任何插件就是「没有额度」
 *      —— 额度变未知是可接受的，动用户的推理地址不可接受。
 *
 *   2. 把列删掉（ALTER TABLE … DROP COLUMN：这列没索引、没约束，直接退）。
 *      列没了，老数据里残留的插件 id 也就彻底没了 —— 不留「界面没有、库里
 *      还有」的半截状态。
 *
 * 幂等：版本号到了就不再跑。新库没有这一列，判列存在时直接跳过（但版本号
 * 照推，免得后加的步骤把它当旧库重跑一遍）。
 */
const QUOTA_PLUGIN_BY_BASE_VERSION = 4;

/**
 * 一个设置的值：环境变量先，面板写进库的那份其次，代码里的默认最后 ——
 * 与 lib/config.ts 的 resolve() 同一套次序（包括「空串也算一个值」）。
 *
 * 为什么在 store 里自己读一遍：那些设置走 lib/config.ts，而 config.ts 引
 * store.ts —— store 引回去就是环。所以这里只读自己需要的那几个键，次序照抄
 * config.ts 的 resolve()。
 */
function legacySetting(key: string, fallback: string): string | null {
  const fromEnv = readEnvValue(key);
  const raw = fromEnv !== null ? fromEnv : getConfig(key) ?? fallback;
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
}

/**
 * 插件 id → 该插件服务的那个平台地址（只给「地址为空」的行填）。
 *
 * 填的是**平台自己的推理地址**，不是插件的额度接口地址：
 *
 *   - 七牛的推理地址是代码里的常量（lib/qiniu/config.ts），没有环境变量。
 *   - SenseNova、书生·端砚、TokenRhythm 的推理地址是设置（lib/sensenova/config.ts、
 *     lib/intern-ai/config.ts、lib/tokenrhythm/config.ts 读的就是这三个键），
 *     部署改了它就是真的在用另一台 —— 填死厂商地址等于把流量指回真上游。
 *
 * 填完这行认不认得出插件，取决于填的地址与插件声明的那个是不是同一台
 * （各家的 quota-plugin.ts 里的 baseUrls）。认不出就是「没有额度」（未知）——
 * 那比把用户的地址改掉轻得多。
 */
function legacyPluginBase(pluginId: string): string | null {
  switch (pluginId) {
    case "qiniu":
      return "https://api.qnaigc.com/v1";
    case "intern-ai-credits":
      return legacySetting("INTERN_AI_DISCOVERY_API_BASE", "https://discovery-api.intern-ai.org.cn/v1");
    case "sensenova-pools":
      return legacySetting("SENSENOVA_BASE", "https://token.sensenova.cn/v1");
    case "tokenrhythm-wallet": {
      // pi-lens-ignore: hardcoded-url -- the vendor default a legacy wallet row is migrated to; the operator's own value wins whenever the old setting exists
      const apiBase = legacySetting("TOKENRHYTHM_API_BASE", "https://tokenrhythm.studio");
      return legacySetting("TOKENRHYTHM_INFER_BASE", `${apiBase ?? "https://tokenrhythm.studio"}/v1`);
    }
    default:
      return null;
  }
}

export function migrateQuotaPluginToBase(db: DatabaseSync): void {
  if (schemaVersion(db) >= QUOTA_PLUGIN_BY_BASE_VERSION) return;
  const columns = db.prepare("PRAGMA table_info(platform)").all() as { name?: string }[];
  if (columns.some((c) => c.name === "quota_plugin")) {
    const rows = db.prepare("SELECT id, base_url, quota_plugin FROM platform").all() as {
      id?: string;
      base_url?: string;
      quota_plugin?: string;
    }[];
    const move = db.prepare("UPDATE platform SET base_url = ?, updated_at = ? WHERE id = ?");
    const now = Date.now();
    for (const row of rows) {
      const pluginId = String(row.quota_plugin ?? "").trim();
      if (!pluginId) continue;
      const base = String(row.base_url ?? "").trim();
      // 行上有地址就是用户的地址，一个字都不动：把平台指到自建端点或假上游
      // 是合法且有文档的用法，改回厂商地址等于把请求搬到真上游。地址认不出
      // 任何插件的后果只是「没有额度」（未知），那比改掉用户的地址轻得多。
      if (base) continue;
      const canonical = legacyPluginBase(pluginId);
      if (!canonical) continue;
      move.run(canonical, now, String(row.id ?? ""));
    }
    db.exec("ALTER TABLE platform DROP COLUMN quota_plugin");
  }
  setSchemaVersion(db, QUOTA_PLUGIN_BY_BASE_VERSION);
}

/**
 * 平台表补注入头模板那一列。
 *
 * 只补列，不搬数据：模板是新东西，旧库里没有任何一份要迁的值，默认空列表
 * （没配过模板）就是正确的历史。判列存在 + 版本号两道闸，重复执行不会重来。
 *
 * 调度上必须放在迁移链的最后：前面的步骤按 user_version 判「是否已跑」，这里
 * 先把版本推到 5，旧库的 legacy/vendor/quota 迁移就会被跳过。
 */
export function migratePlatformHeaders(db: DatabaseSync): void {
  const columns = db.prepare("PRAGMA table_info(platform)").all() as { name?: string }[];
  if (!columns.some((c) => c.name === "headers")) {
    db.exec("ALTER TABLE platform ADD COLUMN headers TEXT NOT NULL DEFAULT '[]'");
  }
  setSchemaVersion(db, PLATFORM_HEADERS_VERSION);
}
/**
 * 模拟客户端那一族的平台补成表里的行。
 *
 * 必须在启动时播完，不能等第一次用到再建：PLATFORMS 已经清空
 * （lib/platform-templates.ts），表里没有的行就等于这个平台不存在 —— 路由、面板、
 * 额度、目录全都按表里的行找平台。少一行，那个客户端的请求就整条路断掉。
 *
 * 只播 `hidden === false` 的：hidden 是「目录里先备着、面板上还不给」。播出来就是
 * 一个地址空、目录空、额度空的平台，面板上看得见却用不了 —— 那样 hidden 就没意义
 * 了。将来把它改成 false，下一次启动自然就播。
 *
 * 删过的不播（platform_preset_removed 的墓碑）：删了就是没了，重启不该插回来。
 * 用户自己建回来会清墓碑（lib/open-platforms.ts 的 createOpenPlatform）。
 *
 * 幂等：存在就不插，已经有的行一个字段都不改 —— 名字用户在面板上能改，那是用户
 * 的值；目录与额度插件归别处维护，重启不该把它们拨回去。
 *
 * 判存在与判墓碑都在同一条语句里（INSERT … SELECT … WHERE NOT EXISTS），不再有
 * 两次读之间的窗口：先读墓碑、再读平台行、再插，中间别人写一条墓碑或建一行，播
 * 出来就是「删掉的长回来了」或者「盖掉用户刚建的行」。一句里判完，窗口就没了。
 *
 * 目录是空的：模拟客户端那一族的目录由各 kind 自己的 models() 给出，不从上游
 * 拉 —— 上游那份是那个封闭客户端的目录，网关拿不到也不该拿。
 */
export function migrateSimulatedClients(db: DatabaseSync): void {
  const insert = db.prepare(
    "INSERT INTO platform " +
      "(id, label, base_url, models, kind, region, created_at, updated_at) " +
      "SELECT ?, ?, '', '[]', ?, ?, ?, ? " +
      "WHERE NOT EXISTS (SELECT 1 FROM platform_preset_removed WHERE id = ?) " +
      "AND NOT EXISTS (SELECT 1 FROM platform WHERE id = ?)",
  );
  const now = Date.now();
  for (const client of SIMULATED_CLIENTS) {
    // hidden 是目录数据（「面板上还不给」），不是库里的状态，留在 JS 这一层判。
    if (client.hidden) continue;
    insert.run(client.id, client.label, client.kind, client.region, now, now, client.id, client.id);
  }
}
