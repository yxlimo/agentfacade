# 按 diff 决定跑哪些门禁

## 做了什么

- 新脚本 `tools/verify-changes.ts`：算出改动文件（基线到工作区，含未提交的），
  按路径规则表选出要跑的门禁，先打印计划再顺序执行，第一个失败就停。
- 规则表在脚本里一处，每条带注释说清归属；不认识的路径从严跑全量 `check`。
- 新测试 `test/verify-changes-check.ts`，挂在 `mise run test:verify`，并进了
  `check:misc`。
- mise 新任务 `mise run verify`（`--plan` 只打印计划，`--base <rev>` 指定基线，
  `--files a,b,c` 注入假路径给测试与实验）。
- `CONVENTIONS.md` 的「测试只跑覆盖你改动的那一组」一节里写明统一跑
  `mise run verify`，表留作案头参考。
- `.gitignore` 里 `tools/*` 只放行 `verify-image.ts`，本次放行了
  `verify-changes.ts`（否则新脚本进不了版本库）。

## 两个取舍

1. **基线怎么取**：`--base` 优先；否则 HEAD 不在 main 上就用
   `git merge-base HEAD main`（worktree 与分支上的活都算），在 main 上就用
   `origin/main`，再没有就 `HEAD~1`。改动集合用 `git diff --name-only <base>`
   （比的是基线与工作区，所以未提交的改动也在里面），外加未跟踪的新文件。
2. **测试怎么注入**：规则表是纯函数（`planTasks` / `matchRules`），测试直接
   import 它算任务清单；CLI 另开 `--files` 给一组假路径，用来验「计划打印」
   这件事。没有往生产路径里塞复位口。

## 验证

`mise run verify --plan --base HEAD~1`、`--files` 三组假改动、
`mise run test:verify`（17 项全过）、`mise run check:misc`、`mise run privacy`
（0 命中）、`mise run typecheck` 全过。

`check:panel` 没在本单里跑（三分钟），留给主代理。
