# 平台行「正在登录」重复

## What I was asked to do

平台行的状态格里「正在登录」出现两次：徽标（`upstreams.stateLoggingIn`）一次、原因句（`upstreams.stateReasonLoggingIn`）又一次。要求：

- `LOGGING_IN` 不再给原因句（徽标已经说完了）。
- 删除 `upstreams.stateReasonLoggingIn` 键（zh 与 en 都删，不留死词条）。
- 其余状态一律不动。
- 只允许改 `web/src/features/upstreams/index.tsx`、两个 catalog、以及对应的 web 单测；不许改后端/proto/根 test。
- 不许降低任何既有断言的强度。
- 补一条单测：LOGGING_IN 行只出现一次「正在登录」；做反证（把原因句加回去必须真红）后还原。
- 门禁只跑 `mise run check:web`（`check:panel` 由主代理跑全量）。
- worktree 分支提交（可 --no-verify），不 push、不部署。

## Steps

- 读约定、确认无 `docs/tasks/**/context.md`，任务以派单正文为准 → 范围/约束已确认
- 建任务日志、提交 → 树为脏信号已就位
- 清点引用：`stateReasonLoggingIn` 只在 index.tsx、zh.ts、en.ts 三处；「正在登录」计数断言在 upstream-state.test.tsx 两条（`toHaveLength(2)`）
- 改动落地：index.tsx 的 LOGGING_IN 分支去掉原因句（留注释说明）；zh/en 各删一行键；两条既存断言 2→1（仍是精确计数，未降强度）；新增单测「正在登录：徽标说一次，原因句不再重复」，断言该行「正在登录」恰好一处且状态格除徽标外无第二段文字
- 定向测试（gen:sync 后 pnpm exec vitest run 该文件）→ 10 passed，新用例绿
- 反证：临时加回 index.tsx 原因句 + zh 键，重跑该文件 → 3 failed，三条「正在登录」计数断言全红（`expected ... length 1 but got 2`）；以 `git apply -R` 还原，确认无 `stateReasonLoggingIn` 残留、树干净
- 提交修复 → `bf8f504`
- `mise run check:web` → typecheck 通过；web:test 77 文件 / 614 项全绿（39.12s）
- 全树 `git status --short` 干净，已全部提交

## 交付记录

- 改了哪些文件：
  - `web/src/features/upstreams/index.tsx`：LOGGING_IN 分支不再赋原因句，留一行注释
  - `web/src/lib/i18n/catalogs/zh.ts`：删 `upstreams.stateReasonLoggingIn`
  - `web/src/lib/i18n/catalogs/en.ts`：删 `upstreams.stateReasonLoggingIn`
  - `web/src/features/upstreams/upstream-state.test.tsx`：两条既存计数断言 2→1；新增单测「正在登录：徽标说一次，原因句不再重复」
  - `.pi/worklogs/state-reason-logging-in-dedup.md`：任务日志
- 新用例：`正在登录：徽标说一次，原因句不再重复` —— 在 LOGGING_IN 行内断言「正在登录」恰好一处，且状态格 textContent 严格等于「正在登录」（连未翻译 key 漏出也能抓住）
- 反证红了什么：把原因句与 zh 键加回去后，新用例与两条既存计数断言共 3 条红，均报 `toHaveLength: expected 1 but got 2`；记录后已还原，树干净
- 门禁结果：`mise run check:web` 通过（web:typecheck 通过；web:test 77 files / 614 tests 全绿）
- 分支 / sha：`pi-subagents/fe-web-src-features-upstreams-index.tsx-...`，最新 `bf8f504`（修复）+ 日志提交
- 未决问题：无。`check:panel` 按派单未跑（主代理跑全量）

## Open questions

- 无
