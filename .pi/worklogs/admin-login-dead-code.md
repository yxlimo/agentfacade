# 清掉 lib/admin/login.ts 的 pi-lens 死代码

## 任务
清掉 `lib/admin/login.ts` 里 pi-lens 报的既有残留死代码：两个未用的 login-flow import 符号、两个未用的 type import、`contextOf()` 函数及其 JSDoc。既有残留，不是新引入。

## 授权范围
只允许改 `lib/admin/login.ts`。不动行为、不改其它告警（console 语句是模块日志）、不用 `as any`、不碰 `web/**` `proto/**` `test/**`。

## 开工前核对（全部确认无引用）
- `submitLogin`、`submitLoginResult`：仅出现在第 29 行 import
- `SenseNovaLogin`：仅第 36 行
- `InternAiLogin`：仅第 39 行
- `contextOf`：仅第 550 行定义，全仓无调用
- 保留：`ProviderRow`（第 610 行 accountFor 仍用）、`LoginContext`（多处仍用）、`beginLoginFlow`/`driveLogin`/`LoginMethod`/`LoginTicket`（均在用）

## 改动（lib/admin/login.ts）
- 第 29 行 import：删 `submitLogin`、`submitLoginResult`，保留 `beginLoginFlow`/`driveLogin`/`LoginContext`/`LoginMethod`/`LoginTicket`
- 第 36 行：删整行 `import type { SenseNovaLogin } ...`
- 第 39 行：删整行 `import type { InternAiLogin } ...`
- 第 542–550 行：删 `contextOf()` 函数及其上方 JSDoc 注释块
- diff：1 insertion(+), 12 deletions(-)

## 进度
- [x] 核对死代码与保留符号
- [x] 应用改动（git apply 补丁；本 harness 未暴露锚点编辑工具）
- [ ] 门禁：typecheck / check:admin / check:routing / privacy
- [ ] 自查 grep
- [ ] 提交
