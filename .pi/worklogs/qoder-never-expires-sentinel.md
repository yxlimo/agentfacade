# Qoder「永不过期」哨兵污染恢复时刻

任务：Qoder 上游 `body.expiresAt=253402214400000`（9999-12-31）是「批次不过期」的哨兵，
现在被当成恢复时刻透出，面板显示「额度用尽，窗口 9999年12月31日 结束」。
在知道上游语义的那一层（`lib/qoder/credits.ts`）认出哨兵，恢复时刻返回「不知道」，
不改面板、不改路由能否接的判定。

## 证据链

- `lib/qoder/credits.ts:fetchQoderCredits` 把 `body.expiresAt` 原样转 `resetsAt` ISO 串
- `lib/kinds/qoder.ts:qoderQuotas` 把批次 `expiresAt` 设为它，`recoverAt()` 当作恢复时刻返回
- `lib/admin/platform-state.ts:accountRecoveryAtMs` 采纳 → proto `credits_recover_at_ms` → 面板

## 路由语义（改前/改后都要保持）

「能不能接」由 `kind.outOfCredits()` 决定（`quotaExceeded===true` 或两个池都空），
与 `resetsAt` 无关。改动只影响展示时间：哨兵 → `resetsAt=null` → 批次 `expiresAt=0`、
`recoverAt()=null`、`platformCooling.creditsRecoverAtMs=0`；
`state=out_of_credits`、`usable=[]` 不变。

## 进度

- [ ] 读代码、确认修复点（完成）
- [ ] `lib/qoder/credits.ts`：命名常量 + 宽判据 helper + 接入解析
- [ ] 新测试 `test/qoder-credits-sentinel-check.ts` + mise.toml 挂载
- [ ] 反证：去掉哨兵判据，a 必须红，记录后还原
- [ ] 门禁：typecheck / check:kinds / check:admin / check:routing / privacy
- [ ] 提交
