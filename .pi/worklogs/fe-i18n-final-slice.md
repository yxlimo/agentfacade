# i18n 收尾片
- 开工：范围为 balance / components / benefits / config / quota-plugins / accounts / errors / admin-errors / 其它 lib 零散，外加 open-platforms 与 models 的漏网残留
- 错误映射方案：describeError 已知类别返回 `errors.*` 词条键，未知/后端原话原样透传；渲染处统一 t()，透传行为靠 i18next 未知键原样返回
- 注释不迁，平台名/账号别名/模型 id/上游原话/错误码字面量不翻
- balance：生产文件用户可见串迁入 balance.*（约 78 条 zh/en），新增 balance-i18n.test.tsx（en 下空状态/表头/来源原样）；web 单测 10 files/59 tests 绿；全量 68 files/579 tests 绿，typecheck 绿
- errors：按主代理定的 C 方案，只导出 describeErrorText(err, t)，已知类别 t('errors.*', { detail })，未知/后端原话原样透传；admin-errors 的码表改为稳定词条键，注释写明为什么不在映射里 t()；全部 29 个调用点改用新函数；守门单测覆盖键存在、插值不留 {{、detail 原文、语言切换；全量 69 files/585 tests 绿，typecheck 绿
