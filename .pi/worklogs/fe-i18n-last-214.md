# i18n 最后 214 处用户可见中文

- 开工：按派单清单迁移 config / upstreams / quota-plugins / provider-accounts / open-platforms / benefits / login / models / accounts 等文件；注释与平台名、模型 id、上游原话、错误码字面量不迁
- 每 2–3 个文件跑相关单测并提交一次；分支提交不推
- config 页 39 处用户可见串迁到 configPage.*，新增 config-i18n.test.tsx；配置目录 7 files/26 tests 绿
- 环境缺 web/.gen，跑过 mise run proto 生成（生成物未提交）
- quota-plugins 页 16 处迁到 quotaPlugins.*，新增 quota-plugins-i18n.test.tsx；3 files/11 tests 绿
- 复核发现原派单计数的多数文件（upstreams/index、provider-accounts、platform-dialog、models 等）用户可见串已在前几片迁完，只剩 JSX 注释里的中文
- login/api 9 条、credential-kind 3 条、provider-key-fields 3 条、provider-keys-dialog 3 条迁入词典；新增 login-messages-i18n.test.tsx；6 files/32 tests 绿
- 404 页与语言菜单显示名迁入词典；新增 misc-i18n.test.tsx；typecheck 绿
- 收尾扫描：生产代码剩余中文只出现在注释、int-field 的内部问题码（渲染处已翻译）、React key 前缀、test/provider-kinds-data.ts 的后端样例数据
