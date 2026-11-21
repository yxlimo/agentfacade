# 任务：根路由 balance 策略（按会话加权一致性哈希）

状态：开工。计划：
1. `lib/router/selection.ts`：`SelectionStrategy` 加 `balance`；select 对 balance 不做 byWeight 排序（保留传入顺序）；HRW（weighted rendezvous，sha256）的确定性排序函数放这里。
2. 新 `lib/router/session-key.ts`：头优先（6 个内置头 + SESSION_HEADER 追加在末尾）、body 兜底（prompt_cache_key / metadata.user_id 两种形态）、卫生判据（空/空白/>256/控制字符当作没有）、返回 `{id, source}`。
3. `lib/router/handle.ts`：balance 时先取会话键，取不到 400（AuthError status 400，正文提到 SESSION_HEADER），不记上游失败；取到则按 HRW 排序 candidates。
4. `lib/aggregate.ts` / `lib/router/catalog.ts` 的 strategy 类型加 `balance`（handle 的 select 签名需要）。
5. `lib/admin/models.ts` 接受 balance；`lib/admin/config.ts` 登记 SESSION_HEADER（热设置、USER_FACING、描述、标签）。
6. `proto` 注释改三个值（不跑 proto）。
7. `test/session-balance-check.ts` + mise 任务 `test:router:session-balance`，挂进 `test` 与 `check:routing`。反证三次。
