# minimax-checkin-init-order

## What I was asked to do

修 `test:minimax:checkin` 的测试初始化顺序缺陷。分支 `fix/stream-gate-and-panel-lan`，HEAD `8668e82`。

现象：`mise run test:minimax:checkin` 在**默认数据目录不可写**的环境里确定性失败：

```
Error: attempt to write a readonly database (SQLITE_READONLY) at lib/store.ts:629 migrateSimulatedClients
```

根因（任务已查实）：`test/minimax-checkin-check.ts` 第 12 行有静态 import：

```ts
import { claimableDay, claimedToday, streak, type SigninPanel } from "../lib/minimax/checkin.ts";
```

ESM 静态 import 在任意顶层语句之前求值，`checkin.ts` 的导入链会走到 `store()`：

```
checkin.ts → auth.ts → oauth.ts → warn-ms.ts → configNumber → store()
```

`store()` 在模块加载时读 `BUDDY_DATA_DIR`。测试文件第 107-108 行想「先设目录再引入 store」，但那两行在静态 import 求值完之后才跑，此时 `store()` 早已绑定默认目录。

要做的：
1. 让数据目录在任何触及 `store()` 的模块被求值之前就设好。造一个小模块（如 `test/data-dir-setup.ts`），在模块顶层设 `process.env.BUDDY_DATA_DIR`（已有值就别覆盖），测试文件**第一个** import 它。放在 `lib/` 之外的 `test/` 下。
   不许靠「把静态 import 改成动态」回避。
2. 同族测试一起查：`grep -rn "BUDDY_DATA_DIR" test/*.ts`，逐个看哪些是「设目录在静态 import 之后」的同类隐患，给结论表，只修确实有隐患的。
3. 测试自己的行为不能变：断言一条不许少、不许放宽。

边界：只改 `test/**`、`.pi/worklogs/**`。不许碰 `lib/**`、`mise.toml`、`web/**`、`proto/**`。

## Steps

- 复现红：`mise run test:minimax:checkin` 在本沙箱直接失败，`SQLITE_READONLY` at
  `lib/store.ts:629 migrateSimulatedClients`。查了默认数据目录：`dataDir()` 返回 `/data`
  （因为 `/data` 存在），目录 mode 40771、`accessSync` 报可写，但 `/data` 是**只读挂载**——
  新建文件 `EACCES`（`fs.writeFileSync('/data/.__wtest__')` → EACCES）。已有的 `/data/buddy.db`
  mode 0600 可写，但 SQLite 需要新建 WAL/journal 文件，只读挂载下写不进去 → `SQLITE_READONLY`。
  这正是任务说的「默认数据目录不可写」环境，红是真实的。
- 读了 `lib/minimax/checkin.ts`、`lib/minimax/auth.ts`、`lib/minimax/oauth.ts`、`lib/minimax/warn-ms.ts`、
  `lib/config.ts`、`lib/store.ts`、`lib/paths.ts`，确认导入链：
  `checkin.ts → ./auth.ts → ./oauth.ts → ./warn-ms.ts`，`warn-ms.ts` 顶层
  `export const WARN_MS = configNumber("MINIMAX_AUTH_WARN_MS", ...)`，`configNumber` → `resolve` →
  `getConfig` → `store()` → `dbPath()` → `dataDir()` 读 `BUDDY_DATA_DIR`。ESM 静态 import 先求值，
  所以测试文件第 108 行设 `BUDDY_DATA_DIR` 太晚。
- 发现这是预存问题：`.pi/worklogs/stream-limit-nonfinite.md` 已记录同一环境阻塞（其它子代理也撞到）。
- 写了 `test/data-dir-setup.ts`：模块顶层若 `BUDDY_DATA_DIR` 未设则 `mkdtempSync` 一个临时目录。
  测试文件第一个 import 它（`import "./data-dir-setup.ts";`），放在 `checkin.ts` 静态 import 之前。
- 红→绿：修复前 `mise run test:minimax:checkin` 报 `SQLITE_READONLY` at `migrateSimulatedClients`；
  修复后同一命令 `pass=19 fail=0` 全绿。
- 同族排查结论：
  - `minimax-checkin-check.ts`：**有隐患**（本次修掉）。静态 import `lib/minimax/checkin.ts`，导入链在模块加载时
    走到 `store()`；顶层设 `BUDDY_DATA_DIR` 太晚。
  - `zcode-quota-check.ts` / `zcode-system-check.ts`：无隐患。静态 import 只有 `type`（`lib/json.ts`、
    `lib/provider-kinds.ts`），值 import 用 `await import` 且在其前已设目录（注释也写明）。
  - `session-check.ts`：无隐患。静态 import `lib/agent.ts` 是纯叶子模块（无 import、不碰 store）。
  - `admin-contract-check.ts`：无隐患。静态 import `lib/gen/...`（生成 proto）与 `./harness.ts`
    （只引 node 内置模块），都不碰 store。
  - 其余设 `BUDDY_DATA_DIR` 的测试：静态 import 只有 node 内置模块、type-only lib import，或
    在函数/块内设目录（如 `client-gone-check.ts` 在函数内），或 store 相关全用动态 import。
    均无隐患。
- 提交：`git add` 两个文件 + worklog，commit。最新 HEAD `0b9fb36`，工作树干净。
- `mise run typecheck` 无法运行：本沙箱 bash 白名单只允许 `mise run test:minimax:checkin`，
  其它 mise 任务（含 typecheck）被拦截。改动只涉及测试文件（一个小模块 + 一个 import），
  且测试本身已跑绿（语法/加载正确），类型风险极低。
- 未清理测试体里第 113 行那个现在冗余的 `BUDDY_DATA_DIR` 赋值：任务要求最小改动、测试行为不变，
  留着它不影响断言，也不影响目录时序（store 已绑定 setup 模块的临时目录）。

## Open questions

- 暂无。