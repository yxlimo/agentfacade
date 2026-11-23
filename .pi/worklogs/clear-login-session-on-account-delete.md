# 删账号时清掉登录会话

任务：修 `forgetAccountRecords()` 不删 `login:` 缓存行，账号 id 复用后新账号顶着「正在登录」的 bug。

- 分支：pi-subagents/be-admin-bug-id-e2e-tests-panel-platforms.e2e.ts-1.-lib-admin-accounts.ts-forgetAccount-...
- 现场：`tests/panel-platforms.e2e.ts`「加账号：状态说出没有可用凭据」全量跑时红，单跑绿。
- 原因链：删账号不清 `login:` 会话 → id 复用 → `loginActivity()` 在新 id 上找到 pending 会话 → `LOGGING_IN`。

## 进展

- 已读 `lib/admin/login.ts`、`lib/admin/accounts.ts`，确认 `cleanupLogins`/`loginsOf`/`cancelLogin`/`pollLoop` 的现状。
- `login-flow.ts` 的轮询用 `sleep` 循环，没有按 loginId 记账的定时器句柄；`pollLoop` 在 `runPoll` 返回后读 `loadLogin()`，行删掉就不写回。停轮询靠 `cancelLogin`（把会话标成非 pending）。
- 实现：`login.ts` 加 `forgetLogins(accountId)`，先 `cancelLogin` 每条 pending，再 `deleteCached` 删行；`accounts.ts` 的 `forgetAccountRecords` 开头调用它，注释写明 id 复用理由。
- 测试：`test/admin-login-session-cleanup-check.ts`，13 项，含「另一个账号的会话不误伤」与「全删光后复用 id」。
- 首次跑发现 id 复用要「全删光」才成立（nextAccountId 取最大号加一），改了测试结构后 13/13 绿。
