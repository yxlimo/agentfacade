# Qoder「永不过期」哨兵污染恢复时刻

任务：Qoder 上游 `body.expiresAt=253402214400000`（9999-12-31）是「批次不过期」的哨兵，
现在被当成恢复时刻透出，面板显示「额度用尽，窗口 9999年12月31日 结束」。
在知道上游语义的那一层（`lib/qoder/credits.ts`）认出哨兵，恢复时刻返回「不知道」，
不改面板、不改路由能否接的判定。

## 证据链

- `lib/qoder/credits.ts:fetchQoderCredits` 把 `body.expiresAt` 原样转 `resetsAt` ISO 串
- `lib/kinds/qoder.ts:qoderQuotas` 把批次 `expiresAt` 设为它，`recoverAt()` 当作恢复时刻返回
- `lib/admin/platform-state.ts:accountRecoveryAtMs` / `lib/admin/upstream-state.ts:platformCooling` 采纳 → proto → 面板

## 路由语义（改前/改后都要保持）

「能不能接」由 `kind.outOfCredits()` 决定（`quotaExceeded===true` 或两个池都空），
与 `resetsAt` 无关。改动只影响展示时间：哨兵 → `resetsAt=null` → 批次 `expiresAt=0`、
`recoverAt()=null`、`platformCooling.creditsRecoverAtMs=0`；
`state=out_of_credits`、`usable=[]` 不变。

## 进度

- [x] 读代码、确认修复点
- [x] `lib/qoder/credits.ts`：命名常量 `NEVER_EXPIRES_SENTINEL_MS` + 宽判据 `NEVER_EXPIRES_AFTER_MS`（100 年）+ helper `qoderResetsAt`，接入解析
- [x] 新测试 `test/qoder-credits-sentinel-check.ts`（29 项：判据、端到端、正常/过去、控制组）+ mise.toml 挂载（test / check:kinds / 单任务）
- [x] 反证：去掉哨兵判据后 7 项真红（线上哨兵→null、同类远期→null、resetsAt 无 9999、批次 expiresAt=0、recoverAt null、creditsRecoverAtMs 0、见底表恢复时刻 null），路由/控制组全绿；已还原，恢复后 29/0
- [ ] 门禁：typecheck / check:kinds / check:admin / check:routing / privacy
- [ ] 提交
