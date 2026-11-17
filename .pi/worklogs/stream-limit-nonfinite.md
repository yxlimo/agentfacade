# stream-limit-nonfinite

## What I was asked to do

Review 查出的缺陷：`lib/router/stream-limits.ts` 的 `clampStreamLimit` 对**非有限值原样放行**
（`if (!Number.isFinite(value)) return value;`），`Infinity` 会穿过去。实测 Node 会把 `setTimeout`
的超界延迟钳到 1ms —— 若 `Infinity` 进 `idleGates`，中途闸会在 1ms 后误判「上游安静」并掐断流，
比 300 秒超时糟得多。

要做的：
1. 夹取函数处理所有非有限值：`Infinity` → 夹到上限；`-Infinity` → 按「闸门关」（≤ 0）；`NaN` → 不自己
   发明，选一种语义（交回调用方回落默认值并 warn，或改签名 `{ value, reason }`），报告里说明为什么。
2. `idleGates` 里也防一次（`??` 只挡 null/undefined），被挡时 `console.warn` 说清用了哪个值。
3. 注释与实现对齐。
4. 测试先红后绿：`Infinity` → 等于上限且 `streamLimitWasCapped(Infinity)` 为真；`-Infinity` → 表示关；
   `NaN` → 按选定的语义断言；守门断言「返回值永远不是 Infinity」。反证：撤掉修复后新增用例必须红。

边界：只改 `lib/router/stream-limits.ts`、`lib/router/deliver.ts`（若需要）、`test/stream-limits-check.ts`。
不许碰 `mise.toml`、`web/**`、`tests/**`、`proto/**`、`lib/gen/**`。

## Steps

- 读了 `lib/router/stream-limits.ts`、`lib/router/deliver.ts`（`idleGates`/`withStreamIdle`/
  `withIteratorIdle`）、`lib/config.ts`（`configNumber`）、`lib/admin/config.ts` 的夹取用法。
  值流：`configNumber` 永远返回有限值（非有限回落 fallback），所以非有限只可能来自调用方传给
  `idleGates` 的 `limits.firstFrameMs`/`limits.idleMs`（目前没有调用方传）。`setTimeout` 收到
  `waitMs`（首帧 `firstDeadline - Date.now()`，中途 `idleMs`）。`NaN` 到 `setTimeout` 会被当 0 → 1ms。
- 选 `NaN` 语义：`clampStreamLimit(NaN)` 返回 `NaN`，把责任交回调用方；`idleGates` 里显式回落默认值
  并 `console.warn`。理由见交付记录。
- 改了 `lib/router/stream-limits.ts`：`Infinity` → 夹到上限；`-Infinity` → 关闸；`NaN` → 原样交回。
  `streamLimitWasCapped` 让 `Infinity` 判真（确实被夹了）。
- 改了 `lib/router/deliver.ts` 的 `idleGates`：NaN 回落默认值并 `console.warn`（`??` 挡不住 NaN）。
- 在 `test/stream-limits-check.ts` 加了非有限值的用例与守门断言（返回值永远不是 Infinity）。
- `mise run typecheck` 通过。
- **环境阻塞**：`mise run test` 全量跑在 `test:minimax:checkin` 处确定性失败：
  `attempt to write a readonly database`（SQLITE_READONLY）。根因：`test:minimax:checkin.ts` 顶部
  静态 import `lib/minimax/checkin.ts`，其导入链（`auth.ts` → `oauth.ts` → `warn-ms.ts` →
  `configNumber` → `store()`）在测试体第 108 行设置 `BUDDY_DATA_DIR` **之前**就执行了 `store()`，
  于是写到默认数据目录（本沙箱里只读），迁移 INSERT 时报 readonly。这是**预先存在的测试/环境问题**，
  与本次改动无关（本次只碰 stream-limits/deliver/stream-limits-check）。由于 bash 只允许
  `mise run test`，无法单独跑 `test:stream:limits`，全量又在此处中断，所以拿不到该测试的
  红/绿输出。

## Open questions

- 环境阻塞：`mise run test` 因 `test:minimax:checkin` 的 readonly DB 问题无法跑完，`test:stream:limits`
  在其之后因此没跑到。需要主代理决定如何解除阻塞（例如允许单独跑 `test:stream:limits`，或修这个
  预存在的测试/环境问题）。