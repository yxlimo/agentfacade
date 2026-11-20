# 任务：把「凭据被上游拒绝」在其它厂商 kind 上也变成可见的结论

2026-11-20 开始。任务上下文 `docs/tasks/68/context.md` 不存在，以派单消息为准。

- 参照 `lib/zcode/credits.ts` 的四态结论与 `lib/kinds/zcode.ts` 的读取写法
- 待办：找出 minimax / qoder / workbuddy 等 kind 的探测折成 null 的位置，改成四态结论
- 不改 zcode、不碰 web、不改契约（除非缺字段）
- 改了三个 kind 的探测函数返回 `VendorProbe`（minimax 的余额与套餐、qoder 的额度、workbuddy 的签到与账本）
- 快照新增结论字段，kind 侧按结论显示：unauthorized 报 ERROR + 「令牌被上游拒绝，需重新登录」，非 ok 不摆 0 卡；判据带登录时刻，重登即失效
- 更新受影响的旧测试；`mise run typecheck`、`check:kinds`、`check:admin`、`check:misc` 均通过
- 加了离线测试 test/vendor-quota-conclusion-check.ts（每家 401/500/ok、凭据视图/额度区、重登失效），进 mise.toml 矩阵 test:vendor:quota:conclusion
- 反证：把 qoder 的 401 从 unauthorized 改回 failed，4 条断言真红（pass=20 fail=4），已恢复
- 最终验证：typecheck / check:kinds / check:admin / privacy --all（808 文件 0 命中）/ 新测试 24/24 全过；全量 `mise run test` 有 test:unreachable 12 项超时失败（unreachable.invalid 连接超时 10s ×2，环境网络行为，与本次改动无关）
