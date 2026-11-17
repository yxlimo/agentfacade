# 修三处 review 问题：签到「没问过」、e2e 注释过时、no-snapshot 用例空缺

分支 `fix/stream-gate-and-panel-lan`，HEAD `8e8eaf3`。

## 任务

1. `web/src/features/benefits/daily-checkin.tsx`：`checkedAt === 0n` 是「从来没问过」，
   不是「还没签过」。与 `checkin-page.tsx`（`PlatformCheckinRow`）统一。
2. `web/src/features/benefits/daily-checkin.test.tsx`：把固化错误文案的断言改成按
   `checkinState` 区分；反证：撤掉修复后用例必须红。
3a. `tests/panel-quota-plugins.e2e.ts` 顶部注释引用了已删除的 `web/src/lib/quota-match.ts`。
3b. `web/src/features/open-platforms/open-platforms.test.tsx` 的 `no-snapshot` 用例没测到
    注释声称的「插件匹配上了、只是快照里没这份」。

## 计划

- 第 1 步规则：照 `PlatformCheckinRow` 定下的规则改 —— `checkedAt > 0n` 才显示时刻
  （`UNKNOWN` 说「上次查询」，其余说「上次签到」）；`checkedAt === 0n` 一律不渲染。
  `NOT_SIGNED` + `checkedAt === 0n` 由这条规则覆盖（不渲染），不新造文案。
- 第 3b 步：`no-snapshot` 行补 `quotaPluginId` + `quotaPluginLabel`；
  `platform-facts.tsx` 在 `quota` 为 undefined（快照里没这份）时显示插件名，把
  「没插件」与「有插件但快照空」区分开。

## 命令

- `mise run web:typecheck`
- `mise run web:test`

## 交付记录

（完成后补。）