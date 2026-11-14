# Dead Code Sweep

## 被要求做什么

按 review 已核过的清理清单删除死代码，但删前自己 grep 复核调用点。

1. `deleted_provider` 相关两个函数（`lib/store.ts`）
2. `lib/quota-plugins.ts` 的 `warnedUnknownPlugins`
3. `lib/admin/accounts.ts` 里不可达的厂商 kind case（`kindOf(name)` 恒为 null）
4. 三家 transport 的推理侧残留（tokenrhythm / sensenova / intern-ai）
5. `writeTokenRhythmKey`

边界：只改 `lib/store.ts`、`lib/quota-plugins.ts`、`lib/admin/accounts.ts`、`lib/tokenrhythm/**`、`lib/sensenova/transport.ts`、`lib/intern-ai/transport.ts`、对应 `test/**`、`.pi/worklogs/**`。禁止 git stash / checkout -- / restore。

## 步骤

- [x] 建分支 wt/dead-code-sweep、建 worklog
- [x] 逐项 grep 复核调用点（含运行时 kindOf 验证）
- [x] 逐项删除
- [x] 跑 typecheck、check:admin、check:kinds、privacy
- [x] 提交并汇报

## 各清理点的复核与处理

### 1. deleted_provider（lib/store.ts）
- `markProviderDeleted` / `providerDeleted` 全仓库零调用点。
- 表在**生产库中存在**（老版本建的），但代码里已无建表语句。两个函数是早期设计残留，无人读这张表。
- **只删函数，不动表，不写 drop 迁移**（为一张没人读的空表冒迁移风险不值得）。

### 2. warnedUnknownPlugins（lib/quota-plugins.ts）
- 仅声明处一处，全仓库无其它引用。
- 历史用途：平台 quota_plugin 字段指向未登记插件时警告一次。该字段已随「按地址匹配」退场（commit 0457a65f 删列），警告路径不再存在。→ 删变量与其注释块。

### 3. lib/admin/accounts.ts 不可达厂商 kind case
- 运行时验证 kindOf：sensenova / intern-ai / tokenrhythm / qiniu / xinghuo 全部 NULL（厂商 kind 退场）。
- provider.kind 从平台行派生（lib/providers.ts toRow：`known?.kind`），厂商平台行 kind='openai'（test/vendor-platform.ts 与 lib/store.ts migrateLegacyVendorKinds 一致）。
- 删除 testTarget 里 case sensenova/intern-ai/tokenrhythm/qiniu/xinghuo、refreshTarget 里 case tokenrhythm、forgetAccountRecords 里 `if (kind === "tokenrhythm")`。
- forgetAccountRecords 的 `kind` 参数随分支一起删除，两个调用点（logoutAccount/deleteAccount）同步去掉实参。
- 连带删除仅被这些 case 用到的 import。

### 4. 三家 transport 推理侧残留
- `senseNovaChat`（lib/sensenova/transport.ts）、`internAiChat`（lib/intern-ai/transport.ts）：全仓库（含 test）零调用点，直调 openAiPlatformChat 的薄壳 → 删。
- `lib/tokenrhythm/transport.ts`：父级实测确认上游不再有那个失效场景，`tokenRhythmChat` 及其整簇（`restoreReasoningContent`、`inferenceAccount`、`TokenRhythmBusyError`、`isRelayBusy`、`busyDetail`、`upstreamSaid`）一并删除。保留 `TokenRhythmNoBalanceError`（policy.ts / provider-selection.ts / balance.ts 在用）。文件只剩这一个类。
- `test/cooldown-single-check.ts`：删掉直接调 `tokenRhythmChat` 的那几处与随之无用的夹具（tokenrhythm 账号、TOKENRHYTHM_INFER_BASE、TokenRhythmBusyError），workbuddy 用例保留。「忙→server→不记冷却」的验证在 cooldown-check.ts 已有同等覆盖（server 5xx 不记冷却），此处不重复补。

### 5. writeTokenRhythmKey（lib/tokenrhythm/keys.ts）
- 零调用点。
- 原保留理由「key 与账号密码同住 :account，那一格没有别的写入口」已不成立：TokenRhythm 已迁成开放平台，推理 key 由面板写进 `key:provider:<账号>:key`（openPlatformPlan().write → writeOpenPlatformKey），`:account` 里的 apiKey 只是旧形状残留。→ 删。
- 同步更新 lib/tokenrhythm/accounts.ts 里引用它的注释，指向开放平台写入路径。

## 未决问题

- worktree 的 `node_modules` 原本是符号链接指向主仓库，pnpm 会把它重建成错误深度的相对链接导致 tsc 找不到。已将 worktree 的 `node_modules` 换成真实目录（`pnpm install` 生成），git status 干净。
- `node_modules` 在 worktree 的 git 里显示为 untracked（git 不把符号链接当目录，`node_modules/` 忽略规则对符号链接不生效）。已换成真实目录后恢复正常忽略，无需改 `.gitignore`。
