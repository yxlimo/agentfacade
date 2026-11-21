# 开放平台注入头 —— 面板前端

任务分支：`pi-subagents/fe-OpenPlatform.headers-...`

范围：`web/src/**` 与仓库根 `tests/`（面板 e2e）。后端契约已定稿（`OpenPlatform.headers` /
`AddPlatformRequest.headers` / `UpdatePlatformRequest.headers`），不碰 `lib/**`、`proto/**`、
`web/.gen`。

计划：
1. `mise run proto` 生成本 worktree 的 `web/.gen`（gitignore，不入库）。
2. 对话框加注入头编辑区（有序行、加一条、删除、上下移动尽量），轻同步校验 + 服务端机器码翻人话。
3. 列表/详情显示行数 + 头名，没配不显示。
4. 七个 `PLATFORM_HEADERS_*` 机器码 zh/en 词条，走既有 `describeErrorText(err, t)`。
5. `templates.json` 的 `opencode-go` 加 headers，`PlatformTemplate` 类型加可选 headers。
6. 单测 + 面板 e2e。
7. 两次反证（模板去掉 headers、清空改为不发这一格），贴红点。
8. 门禁：`mise run web:typecheck`、`mise run check:web`、`mise run check:panel`、`mise run privacy`。

## 进度

- 开工前读约定与任务；无 `docs/tasks/**/context.md`，任务以派单正文为准。
