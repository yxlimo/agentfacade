# winston: console.* → log.*

任务：引入 winston 作日志库，后端所有 console.* 换成 log.*；默认输出逐字节一致，另加可选 JSON 格式。

## 事实核对

- 根 package.json 已带 winston@3.19.0（提交 ca68008），不再装包
- lib/**（除 lib/gen）console 调用 189 处 / 44 文件；router-proxy.ts 22 处；合计 211
- 全部 211 处都是单参数（部分是单参数 + 尾逗号），无真正多参数调用
- lib/zcode/claim.ts:227 有一句注释提到 `console.*`，会破坏「grep console\. 为 0」的自检，需改写
- 所有 45 个文件首行代码都是 import，可直接在其前面插入 log 的 import
- 实测 winston 配置可用：printf(i=>i.message) 文本原样、stderrLevels 分流、level 过滤、timestamp+json JSON 格式

## 步骤

1. 建日志（本文件）并提交
2. 新建 lib/log.ts 叶子模块
3. 机械替换 45 个文件的 console.* → log.* 并补 import
4. 更新 .pi-lens.json / CONVENTIONS.md
5. 新建 test/log-check.ts（子进程断言 + 反证）
6. mise.toml 加 test:log，挂进 test / check:misc
7. 跑门禁：typecheck、check:admin、check:routing、check:misc、privacy
8. grep 自检 console 清零

## 进展

- 新建 lib/log.ts（winston，叶子模块），typecheck 通过，已提交
- 45 文件机械替换 211 处 console.* → log.*，round-trip 脚本核对 bad=0，typecheck 通过，已提交
- claim.ts 陈旧注释与 log.ts 注释里的 console.* 改写，保证 grep 清零
- .pi-lens.json 补 ignorePaths（tools/ test/ scripts/ config-cli.ts），CONVENTIONS.md 加日志小节，已提交
- 新建 test/log-check.ts（子进程 16 断言），mise.toml 加 test:log 挂进 test/check:misc，待提交
- 反证：去掉 join → 多参断言红（1 failed）；stderrLevels=[] → 分流断言红（4 failed）；均已还原且 lib/log.ts 与 HEAD 一致
