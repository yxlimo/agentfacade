# 开放平台转发头模板 —— 交接说明

分支 `pi-subagents/be-admin-session-id-opencode-go-...`（当前 HEAD `d0a9da7`）。
主线已到 `99b9f25`（balance 策略那一单），本单的补丁流程已被主会话叫停：store.ts /
service.ts 要先拆模块，拆完再开工。本文只记「改哪里、为什么」，不含补丁。

已提交的新文件（可复用，不要重写）：

- `lib/admin/platform-headers.ts`：纯数据层。常量、类型、校验、渲染、存储序列化、400 文案。
- `lib/admin/platform-header-injection.ts`：注入层。`resolveForwardedHeaders()`，把会话提取与头模板接起来。

**尚未写的文件**：`test/platform-header-template-check.ts` 没写（原派单以为它已存在）。
它依赖会话模块、store 内部结构和假上游，见文末「测试」一节。

## 一、每个已有文件要改哪里、加什么、为什么

基线提醒：`lib/router/handle.ts`、`mise.toml`、`proto/agentfacade/admin/v1/admin.proto`
在 `99b9f25` 相对 `d0a9da7` 已变（balance 策略 + 测试注册 + 一处注释）。其余三个文件
（store.ts / open-platforms.ts / service.ts）两版之间没变。拆完模块后按当时的主线重新取基线。

### 1. `lib/store.ts`

- `store()` 里的 `CREATE TABLE IF NOT EXISTS platform`：在 `models` 那行后加一列
  `headers TEXT NOT NULL DEFAULT '[]'`。为什么：新库一次性建好，默认空列表（没配过模板）。
- 版本常量区（`TRAITS_VERSION=1`、`LEGACY_VENDOR_KIND_VERSION=2`，另有
  `QUOTA_PLUGIN_BY_BASE_VERSION=4`）：加 `const PLATFORM_HEADERS_VERSION = 5;`。为什么：
  当前最大 user_version 是 4，递增到 5；每步有自己的号、各判各的，别用一个总版本去找前序步骤。
- 新增函数 `migratePlatformHeaders(db: DatabaseSync): void`：
  - `PRAGMA table_info(platform)` 判有没有 `headers` 列，没有就
    `ALTER TABLE platform ADD COLUMN headers TEXT NOT NULL DEFAULT '[]'`；
  - `schemaVersion(db) < PLATFORM_HEADERS_VERSION` 时 `setSchemaVersion(db, 5)`。
  - 为什么幂等：判列存在 + 版本号两道闸，重复执行不会重来；没有一次性数据要搬，版本号
    只为后续步骤留基线并满足「迁移递增 user_version」。
- `store()` 的迁移调用链：在 `migrateQuotaPluginToBase(db)` 之后加 `migratePlatformHeaders(db);`。
  为什么放最后：前面几步按 user_version 判「是否已跑」，不能在它们之前把版本推到 5，
  否则旧库的 legacy/vendor/quota 迁移会被跳过。已有的迁移函数都不调用 `openPlatformOf()`，
  所以列晚一点加上不影响它们。

### 2. `lib/open-platforms.ts`

- 顶部加 `import { parseStoredHeaders, serializeHeaders, validateHeaderTemplates,
  type HeaderTemplate } from "./admin/platform-headers.ts";`。
- `OpenPlatformRow` 接口：加 `headers: HeaderTemplate[]`。为什么：注入层从这一行读模板。
- `listOpenPlatforms()` 与 `openPlatformOf()` 的 `SELECT`：列清单里加 `headers`。
  为什么：漏了的话 `toRow` 读到 undefined，模板永远空。
- `createOpenPlatform(input)`：入参加 `headers?: unknown`；在建行前
  `const checked = validateHeaderTemplates(input.headers); if (!checked.ok) return checked;`，
  INSERT 的列表与 VALUES 里加 `headers` / `serializeHeaders(checked.templates)`。
  为什么：建平台就能带模板；校验在写库前，坏值整条拒绝。
- `updateOpenPlatform(id, patch)`：patch 类型加 `headers?: unknown`；
  `const checked = patch.headers === undefined ? null : validateHeaderTemplates(patch.headers);
  if (checked && !checked.ok) return checked;`，没给就用 `row.headers`（不搞动态 SQL），
  UPDATE SET 里加 `headers = ?` 并传 `serializeHeaders(headers)`。
  为什么：面板每次保存都可能只改一格；没给的模板必须保持原样，给了空列表才是清空。
- `toRow(row)`：加 `headers: parseStoredHeaders(row.headers)`。为什么：坏 JSON 读成空，
  不让一行写坏拖垮整个平台列表。

### 3. `lib/router/handle.ts`（按 `99b9f25` 基线，那边已有 balance 改动）

- import：把 `../agent.ts` 那行的 `clientForwardHeaders` 去掉（本文件不再直接用），
  加一行 `import { resolveForwardedHeaders } from "../admin/platform-header-injection.ts";`。
  balance 那几行 import（`extractSessionKey` / `balanceOrder` / `sessionKeyFingerprint` /
  `sessionHeaderNames`）一行都别动。
- `callUpstream()` 里 `if (kind?.openPlatform) { … }` 那块（99b9f25 约 614–616 行）：
  把 `uctx.forwardedHeaders = clientForwardHeaders(ctx.request.headers);` 换成——
  1. `const injected = resolveForwardedHeaders(route.platform, template?.label ?? route.platform,
     ctx.request.headers, body);`
  2. `if (!injected.ok)`：`ctx.status = 400`；
     `ctx.body = { error: { type: "invalid_request_error", message: injected.message } }`；`return`。
  3. 成功分支 `uctx.forwardedHeaders = injected.headers;`
  为什么这段必须在 `try { switch(kind.kind) … }` 之前：400 要在任何上游往返之前返回，
  且不能走到 `recordRequestUsage` 写一行上游失败用量。`body` 是 `Json`，正是
  `resolveForwardedHeaders` 要的类型。

### 4. `lib/admin/service.ts`

- 从 `../gen/agentfacade/admin/v1/admin_pb.ts` 的 import 块里加 `HeaderTemplateSchema`
  （生成物名字；`mise run proto` 由主会话跑）。
- `openPlatformMessage(row)`：create(OpenPlatformSchema, …) 里加
  `headers: row.headers.map((h) => create(HeaderTemplateSchema, { name: h.name, value: h.value }))`。
  为什么：面板读回模板才能显示/再保存。
- `addPlatform(request)`：传给 `createOpenPlatform({...})` 的对象加 `headers: request.headers`。
- `updatePlatform(request)`：那个 patch 对象加 `headers`，值取
  `request.headers === undefined ? undefined : request.headers.items`（带 presence 的包装，
  没给 = 别动、给了空列表 = 清空）；patch 的类型声明里也加 `headers?: unknown`。
  为什么：Connect 层只做形状搬运，校验在那两层已经做了。

### 5. `mise.toml`（按 `99b9f25` 基线，已有 `test:router:session-balance`）

- 新增 `[tasks."test:platform-header-template"]`：
  `run = "node --experimental-strip-types test/platform-header-template-check.ts"`。
- 把 `"test:platform-header-template"` 加进 `[tasks.test]` 的 depends 和
  `[tasks."check:admin"]` 的 depends。为什么：离线、进单测矩阵与 check:admin。

## 二、proto 要加什么（`proto/agentfacade/admin/v1/admin.proto`）

- 新消息 `HeaderTemplate { string name = 1; string value = 2; }`。
- 新消息 `HeaderTemplateList { repeated HeaderTemplate items = 1; }`。为什么包一层：
  repeated 没有 presence，更新时要分清「没给 = 别动」与「给了空列表 = 清空」，
  与本文件 `EffortList` 同一个理由。
- `OpenPlatform`：加 `repeated HeaderTemplate headers = 10;`（9 之后第一个空号）。
- `AddPlatformRequest`：加 `repeated HeaderTemplate headers = 6;`（5 是 reserved）。
- `UpdatePlatformRequest`：加 `HeaderTemplateList headers = 8;`（7 是 traits_from_common；
  消息字段自带 presence，不需要写 optional）。
- **不加新 RPC**：`UpdatePlatform` 本来就是改这几格的地方，把 headers 加进去即可；
  目录、kind 仍不在这里改，别把它做成万能更新。
- 主会话跑 `mise run proto` 生成 `lib/gen` 与 `web/.gen`；生成物没就位前 service.ts
  的 `HeaderTemplateSchema` 会类型报错，属预期。

## 三、校验函数（已实现在 `lib/admin/platform-headers.ts`）

签名：

```ts
function validateHeaderTemplates(raw: unknown):
  | { ok: true; templates: HeaderTemplate[] }
  | { ok: false; code: string; message: string }
```

拒绝条件（每条报错都带「第 n 条」+ 哪一格，面板能直接指到那一行）：

- 不是列表 → `PLATFORM_HEADERS_INVALID`
- 超过 20 条 → `PLATFORM_HEADERS_TOO_MANY`
- 某条不是对象 → `PLATFORM_HEADERS_INVALID`
- 名字为空 → `PLATFORM_HEADERS_NAME_EMPTY`
- 名字不是 RFC 7230 token（`/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/`，即含空格/冒号/中文/CRLF 都拒）→ `PLATFORM_HEADERS_NAME_INVALID`
- 值为空 → `PLATFORM_HEADERS_VALUE_EMPTY`
- 值含 CR 或 LF → `PLATFORM_HEADERS_VALUE_INVALID`
- 值长度 > 200 → `PLATFORM_HEADERS_VALUE_TOO_LONG`
- `undefined` / `null` → 当成空列表（不是错误，表示「这一格没给」）。
- `{session-id}` 之外的 `{...}` **不校验、不展开**，当字面量原样发。

## 四、已经踩过/想清楚的坑

- **注入点只有一处**：`lib/router/handle.ts` 的 `callUpstream()` 里
  `if (kind?.openPlatform)` 那块，在 deny-list 透传（`clientForwardHeaders`）之后、`try` 之前。
  不要改 `lib/agent.ts` 的 `clientForwardHeaders` 本身（模拟端与既有 `test/session-check.ts`
  都用它，改了会串味），也不要改 `lib/router/upstreams/open-platform.ts` 的
  `attributionHeaders`（那里没有 body、也没有平台 label，取不到会话）。
- **模拟端一个字都别动**（qoder / workbuddy / minimax / zcode）：它们的请求照客户端指纹重建，
  从来不读 `forwardedHeaders`，所以 `kind?.openPlatform` 这个 guard 就是天然边界 —— 即使有人
  在库里给 zcode 塞了模板，也发不出去。改它们等于改握手指纹，会断会话。
- **会话提取只在 `extractSessionKey`**：主线 `99b9f25` 的 `lib/session-id.ts` 导出
  `extractSessionKey(headers: Record<string, unknown>, body: Json): { id, source } | null`
  （走 SESSION_HEADER 设置）与 `sessionIdFrom(...)`。转发层用 `extractSessionKey`；
  `Json` 来自 `lib/json.ts`。**不要自己写第二套提取**。extract 拿不到 → 400。
- **400 的边界**：只有当某个模板值含 `{session-id}` 且提取失败才 400；纯常量头即使没有会话
  也照发。文案由 `missingSessionMessage(label, headerName)` 生成，含平台名、哪个头、试过哪些
  来源、怎么配。`resolveForwardedHeaders` 在渲染之前就把会话取好，取不到一次就打回。
- **日志**：只记平台 id、头名、`source`（`extractSessionKey` 返回的 `source`），**绝不记会话
  标识的值**——那是客户端的会话身份，等价于凭据。
- **替换用 split/join 不用正则/replace**：会话 id 里可能有连字符、`$`、反斜杠（`sess-1` 这类），
  当替换语法会坏。`renderHeaderTemplates()` 已按此实现，顺序不变。
- **同名头**：模板覆盖客户端头（渲染结果按小写名写回）；客户端传了同名头而平台没配模板时
  保持现状，继续按 deny-list 透传。
- **注入层对 store 的依赖**：`resolveForwardedHeaders` 调 `openPlatformOf(platformId)?.headers`。
  在 `OpenPlatformRow.headers` 落库之前这一行类型不过，属预期；不是注入层写错了。
- **迁移顺序**：user_version 现在最大 4（quota-by-base）；新步骤用 5。判列用 PRAGMA，
  判版本用 schemaVersion，两层都幂等。

## 五、测试（还没写）

`test/platform-header-template-check.ts` 需要处理 a–f 六组，全部离线：

- a 纯函数：`{session-id}` 被替换、无占位符原样、多头保序、`sess-1` 不被破坏 —— 用
  `renderHeaderTemplates()`，现在就能写（只依赖已提交的新文件）。
- b 校验：非法头名（空格/冒号）、CRLF、超长、超 20 条、空值逐条被拒且报错说清哪一条 —— 用
  `validateHeaderTemplates()`，现在就能写。
- c 注入：`test/fake-upstream.ts` 起假上游，配 `x-opencode-session: {session-id}`，
  请求带 `x-session-affinity: S1`，断言假上游收到的头是 `S1` —— 依赖 store 落库 + handle 注入 +
  会话模块，等拆完模块再写。
- d 400：配了占位符但没有任何会话来源 → 400，用假上游自己的 `fake.requests.length` 断言
  一次都没打到 —— 同上，等依赖。
- e 不越界：zcode 即使库里被塞模板，发出去的请求也不含那个头 —— 同上，等依赖。
- f 客户端自带同名头、平台没模板 → 仍按 deny-list 透传 —— 只依赖 `clientForwardHeaders`，
  现在就能写。
- 三次反证（必须真做、贴红了什么）：(a) 去掉替换 → c 红；(b) 400 改成跳过该头 → d 红；
  (c) 注入对模拟端也生效 → e 红。三次还原后全绿。

接手的人：等 store/service 拆完、会话模块进分支、proto 生成物就位，再从本文第一步往下做。
