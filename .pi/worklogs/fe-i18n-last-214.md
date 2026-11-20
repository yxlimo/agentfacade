# i18n 最后 214 处用户可见中文

- 开工：按派单清单迁移 config / upstreams / quota-plugins / provider-accounts / open-platforms / benefits / login / models / accounts 等文件；注释与平台名、模型 id、上游原话、错误码字面量不迁
- 每 2–3 个文件跑相关单测并提交一次；分支提交不推
- config 页 39 处用户可见串迁到 configPage.*，新增 config-i18n.test.tsx；配置目录 7 files/26 tests 绿
- 环境缺 web/.gen，跑过 mise run proto 生成（生成物未提交）
