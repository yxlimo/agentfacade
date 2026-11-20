# ZCode 活动免费额度：定时领取

## 目标

- `lib/zcode/claim.ts`：preview（有没有可领）+ claim（领）。
- `lib/periodic.ts`：独立的 `claim` 步进，30 分钟一次，默认开（`FACADE_ZCODE_AUTO_CLAIM`）。
- 结论落快照 `snapshot.zcode[id].claim`，面板从额度卡 note 读出来。

## 已验证的接口事实（派单里给的，不去逆向）

- preview：`GET {ZCODE_BASE}/api/v1/zcode-plan/billing/preview?app_version=3.18.2&platform=win32-x64`
  - 有可领：`{code:0,data:{server_time,plans:[…]}}`
  - 没有可领：`{code:0,msg:"",logid:"…"}` —— **HTTP 200、code 0、没有 data 字段**。这是「没有」，不是「失败」。
  - 其它（非 200 / code 非 0）→ 失败。
- claim：`POST {ZCODE_BASE}/api/v1/zcode-plan/billing/claim`，body `{"plan_id":"…"}`
  - 成功：`code===0` 且 `data.plan` 存在。
  - 失败：透传 `code` 与 `data.message`（服务端中文，不自己映射）。
  - `1001–1005` 客户端当终态（不重试）。
  - 缺验证码头 → `3007` / 文案含「验证码校验失败」；网关过不了验证码 → 独立状态。

## 决定

1. **1001–1005 整组映射成 `already`**：客户端只说这组是终态，没说哪一条是「已领过」。
   不猜具体含义 → 整组一个状态，服务端原话进 `message`，面板念原话。
2. **`already` / `captcha` / `claimed` 都是本轮终态**：本轮不再试；下一轮重新 preview 判断，
   不记「已放弃」。
3. **claim 的 Authorization 头来自 `zcodePlatformHeaders()`**，不自己加（叠一份上游回 401 空正文）。
4. `X-ZCode-App-Version` 用 billing 自己的常量 `3.18.2`（实测值），**不动 `ZCODE_VERSION`**
   （那是模型请求的指纹）。
5. 领取与签到语义分开：独立的 `claim` 步进，不塞进 `benefits.runOnce()`。

## 步骤

- [x] 读代码：periodic 步进、快照形状、额度卡 note、配置读取
- [x] `lib/zcode/claim.ts`
- [x] `lib/periodic.ts` 加 `claim` 步进
- [x] 快照加 `claim` 一格 + 额度卡 note
- [x] `test/zcode-claim-check.ts`（假上游）
- [x] 修 `test/zcode-quota-check.ts` 的 ProviderRow 导入
- [x] mise.toml 登记 `test:zcode:claim` 并挂进 `check:kinds`

## 交付记录

### 改了哪些文件

- `lib/zcode/claim.ts`（新）：`previewClaims` / `claimPlan`。
- `lib/zcode/auto-claim.ts`（新）：一轮领取（`claimOnce`）、结论的记处、开关。
- `lib/periodic.ts`：加了 `claim` 步进（30 分钟）。
- `lib/admin/upstreams.ts`：快照的 zcode 那一格多一个 `claim`。
- `lib/kinds/zcode.ts`：额度卡 note 带上领取结论。
- `lib/provider-kinds.ts`：`HealthSnapshot.zcode` 多一格 `claim`，加了 `ZcodeClaimSnapshot`。
- `test/zcode-claim-check.ts`（新，39 项）、`test/zcode-quota-check.ts`（修 `ProviderRow` 的导入来源）。
- `mise.toml`：登记 `test:zcode:claim`，挂进 `test` 与 `check:kinds`。

### `state` 判据的取舍

- **1001–1005 整组 → `already`**。官方客户端只说这组是终态（不重试），没说哪一条是
  「已经领过了」。所以不猜：整组当一个终态，服务端的中文原话原样进 `message`，
  面板念原话（`领取：已领过（今日领取名额已用完）`）。这就是派单里那句
  「别猜具体哪一个是什么意思」的落法。
- **`captcha` 是独立状态**，不与 `failed` 混：网关过不了验证码，重试多少次都没用，
  人得自己去过。判据两条：业务码 3007，或文案含「验证码校验失败」（码不是 3007
  但说的是同一件事时也算）。
- **`none` 是「preview 的列表是空的」**，不是失败：上游那时答的是 HTTP 200 + code 0
  但没有 `data` 字段。折成 failed 的话面板会显示成「额度没问到」，而真相是「今天
  没有可领的」。
- **`failed` 不是终态**：5xx、超时、其它业务码都落这里，下一轮重新 preview 再试。
  不记「已放弃」—— 服务端的可领列表每轮都可能变。
- **`claimed` 才是成功**：code 0 且 `data.plan` 存在。

### 验证（原文）

- `mise run test:zcode:claim` → 全部通过（40 项）
- `mise run test:zcode:quota` → 全部通过（74 项）
- `mise run check:kinds` → 全部通过（84 项）
- `mise run check:routing` → 全部通过
- `mise run check` → pass=2195 fail=0
- `mise run typecheck` → 无输出（通过）
- `mise run privacy` → 0 条命中（`--all` 扫 748 个文件也是 0 条）

反证（每一处把实现退回旧行为后的红）：

1. preview 的「没有 data」当失败 → 3 项红（preview 空 → ok / 计划是空数组 / 结论是 none）
2. 终态码当可重试的 failed → 3 项红（1001–1005 → already / 原话 / 面板 note）
3. 验证码折进普通 failed → 2 项红（3007 → captcha / 文案含「验证码校验失败」→ captcha）
4. 开关不管用 → 1 项红（开关关着 → 一个请求都不发）
5. 每次可领的都领一遍 → 5 项红（领取请求恰好发了一个 / 终态与验证码各一条 / failed 还会再试 / 开关开着各发一个）
6. note 不带领取结论 → 3 项红（note 带着结论 / 计划名 / 终态 note）

### 未决

- `stateReason`（`lib/admin/upstream-state.ts`）没带领取结论：它是平台层的通用机制，
  领取是账号层的事，硬塞进去会让那个模块长出 zcode 分支。面板从额度卡的 note 上
  已经看得见结论。
- 领取的结论只活在进程内存里（与额度快照一样）。重启后要等下一轮领取才有结论 ——
  额度快照也是这个脾气（不落库：落库会拿旧数骗人）。
- 结论当场写进现役的快照（不只是等下一次全量刷新）：面板等的是“现在”，而全量
  刷新最快也要五分钟以后。
- `X-ZCode-App-Version` 用的是 billing 自己那个常量 `ZCODE_CLAIM_APP_VERSION`
  （默认 3.18.2，实测值），没动 `ZCODE_VERSION`（那是模型请求的指纹）。
- 领取只对 `kind === "zcode"` 且开着的账号跑；平台行改名不影响（认的是 kind）。
