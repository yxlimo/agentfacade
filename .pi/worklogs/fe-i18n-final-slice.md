# i18n 收尾片
- 开工：范围为 balance / components / benefits / config / quota-plugins / accounts / errors / admin-errors / 其它 lib 零散，外加 open-platforms 与 models 的漏网残留
- 错误映射方案：describeError 已知类别返回 `errors.*` 词条键，未知/后端原话原样透传；渲染处统一 t()，透传行为靠 i18next 未知键原样返回
- 注释不迁，平台名/账号别名/模型 id/上游原话/错误码字面量不翻
