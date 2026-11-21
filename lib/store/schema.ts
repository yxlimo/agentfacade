// lib/store/schema.ts — 建表：store() 里那十一段 CREATE TABLE 原样搬到这里。
//
// 搬家是纯移动：语句与注释逐字保留，只是从 store() 的函数体里抽成一个函数，让
// store.ts 能把「打开连接」与「表长什么样」分成两个文件。没有 import 任何东西：
// 表结构是这层唯一的知识，别向它引依赖。

import type { DatabaseSync } from "node:sqlite";

/** Create the tables if they do not exist yet. */
export function createTables(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS secrets (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL,
      data       TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS locks (
      id     TEXT PRIMARY KEY,
      holder TEXT NOT NULL,
      at     INTEGER NOT NULL
    )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS cache (
      id   TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      at   INTEGER NOT NULL
    )`,
  );
  db.exec(
    `CREATE TABLE IF NOT EXISTS config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  // 账号：一行一个账号。`platform` 是平台 id（代码里的模板，或者表里的开放
  // 平台，也是请求路径里那一段），同一平台下可以有多行。
  db.exec(
    `CREATE TABLE IF NOT EXISTS provider (
      id         TEXT PRIMARY KEY,
      platform   TEXT NOT NULL,
      alias      TEXT NOT NULL DEFAULT '',
      enabled    INTEGER NOT NULL DEFAULT 1,
      weight     INTEGER NOT NULL DEFAULT 100,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  // 客户端会话 → 上游会话的映射。
  //
  // 客户端给的会话 id 什么样都有（pi 给裸 UUID，opencode 给 `ses_xxx`），
  // 而上游只认自己客户端那种形状。所以映射一次，落在这里：同一个客户端会话
  // 永远是同一个上游会话 id。
  db.exec(
    `CREATE TABLE IF NOT EXISTS session_map (
      upstream          TEXT NOT NULL,
      client_session_id TEXT NOT NULL,
      session_id        TEXT NOT NULL,
      created_at        INTEGER NOT NULL,
      PRIMARY KEY (upstream, client_session_id)
    )`,
  );
  // 平台层的生效策略：一行一个平台，没有行就是默认。
  //
  // 这张表要在迁移之前就存在：迁移会把旧行上的策略搬进来。
  db.exec(
    `CREATE TABLE IF NOT EXISTS platform_policy (
      platform   TEXT PRIMARY KEY,
      policy     TEXT NOT NULL DEFAULT 'single',
      updated_at INTEGER NOT NULL
    )`,
  );
  // 开放平台：用户自己加的平台，一行一个。
  //
  // 代码里的模板（lib/platform-templates.ts）与这张表是两处数据源：模板优先 ——
  // 模板里有的 id，表里的那一行当没有。这样把模板加回代码时不用先清库，
  // 回滚是安全的。
  //
  // 这一张表的 `id` 就是**平台 id**：跟 provider.platform、
  // platform_policy.platform 是同一个东西 —— 请求路径里那一段
  // （`<平台>/v1/messages`）用的就是它。
  //
  // `models` 存的是整个目录（模型名、各模型参数、上次什么时候拉的）。
  //
  // `models_auto` 这一列留着但不再读写：目录归上游还是归代码由平台的族决定，
  // 不是行说了算的。老库里的值不再有人读 —— 不删列是怕生产库升级时出事，
  // 留着不动最稳。
  //
  // `traits_from_common` 是「上游与代码都没说清时从共性表补参数」那个开关。
  //
  // 默认开：共性表只补前几层都没说的字段（lib/catalog-models.ts 的顺序），它不会
  // 盖掉上游明确说的任何一句。关着的时候屏幕上是「窗口/档位不知道」的模型，客户端
  // 只好用自己那份默认形状 —— 那比一条近似值更容易出错。要关的那个平台仍然能关
  // （面板上，或者 updatePlatform）。
  db.exec(
    `CREATE TABLE IF NOT EXISTS platform (
      id           TEXT PRIMARY KEY,
      label        TEXT NOT NULL,
      base_url     TEXT NOT NULL,
      models       TEXT NOT NULL DEFAULT '[]',
      models_auto  INTEGER NOT NULL DEFAULT 1,
      traits_from_common INTEGER NOT NULL DEFAULT 1,
      kind         TEXT NOT NULL DEFAULT 'openai',
      region       TEXT NOT NULL DEFAULT '',
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    )`,
  );
  // 预置平台被删掉的墓碑：一行一个 id。
  //
  // 播种是「表里没有就补一行」，补不出「用户删过它」这件事 —— 删掉 minimax 的
  // 行，下次启动又插回一个空平台，等于删不掉。所以删的那一下在这里留一条，播种
  // 见到就跳过；用户自己把它建回来（createOpenPlatform）就把墓碑清掉。
  //
  // 只记预置目录（platform-catalog.ts 的 SIMULATED_CLIENTS）里的 id：用户自己建
  // 的平台没有播种这一层，删了本来就没了。
  db.exec(
    `CREATE TABLE IF NOT EXISTS platform_preset_removed (
      id         TEXT PRIMARY KEY,
      removed_at INTEGER NOT NULL
    )`,
  );
  // 人给某个模型的元数据：一行一个模型，只放**写了的**那些字段（JSON）。
  //
  // 平台一级一份：模板平台与开放平台共用这一张表 —— 目录的来源是两回事（有的
  // 是代码里的表，有的是上游拉回来的），人写的那一层是同一个意思。
  //
  // 主键是（平台, 模型 id）：同一个模型在一个平台下只能有一条，重复写就是覆盖
  // 自己；没有序号列，所以读出来的顺序是 model_id 的顺序 —— 稳定比「保存的先后」
  // 重要（发布出去的目录每次都得一样）。
  db.exec(
    `CREATE TABLE IF NOT EXISTS platform_model_override (
      platform_id TEXT NOT NULL,
      model_id    TEXT NOT NULL,
      data        TEXT NOT NULL,
      PRIMARY KEY (platform_id, model_id)
    )`,
  );
  // 账号的冷却：失败之后一段时间不再路由到那个账号。
  //
  // 落库：网关重启以后它还在 —— 一个刚被限流的账号不该因为重启又被试一次。
  // 过期是惰性的：判定的时候比时间就行，不需要定时器去「恢复」。
  db.exec(
    `CREATE TABLE IF NOT EXISTS cooldown (
      provider_id TEXT PRIMARY KEY,
      until_ms    INTEGER NOT NULL,
      reason      TEXT NOT NULL DEFAULT '',
      updated_at  INTEGER NOT NULL
    )`,
  );
}
