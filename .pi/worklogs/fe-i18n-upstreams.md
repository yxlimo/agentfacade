# i18n 第二片（upstreams + e2e）
- 开工：2026-...
- 任务上下文文件不存在，按派单描述执行
- 已完成 upstreams 全部生产文件拉丁化文案入词典，state.ts 通过 languageChanged 重算导出表
- web 单测 66 files / 575 tests 全绿，typecheck 通过
- 已补 tests/panel-i18n.e2e.ts（EN、刷新、中文、html lang）和 upstreams-i18n.test.tsx
- 第二批：补齐 provider-alias.tsx 与 benefits.ts 的文案（首轮清点漏掉），check:web 再跑一次全绿
- e2e 第一次在提交钩子里跑到一半被工具超时截断，残留进程占用 6799；单独跑 check:panel 遇到 APP_ALREADY_RUNNING，等残留结束后重试
- 最终验证：mise run check:web 全绿；mise run check:panel 25 files/84 tests 全绿（含新增 panel-i18n.e2e.ts）；mise run typecheck 通过
- 新增 upstreams.* 词条 161 条（zh/en 各 161）；剩余各目录生产文件中文量：open-platforms 71、models 38、balance 32、config 22、benefits 14、login 9、quota-plugins 7、accounts 4、overview/auth/usage/errors 0
