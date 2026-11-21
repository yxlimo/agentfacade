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

## 门禁冲突与决策（走 A）

- check:admin/check:routing 首轮红：5 个既有测试靠 monkeypatch console.log/warn 抓日志，winston 走 console._stdout.write 绕过 patch。产品输出逐字节一致（原始 stdout 里 9 条删平台日志都在）。
- 实测无任何 winston 配置项（含 forceConsole:true）能让事后 console.log patch 抓到输出。
- 问主代理 → 选 A：只改这 5 个测试文件的抓取口，产品代码不动。
- 新建共享 test/log-capture.ts（patch log.* 的稳定对象、按方法/全局顺序收行、forward、restore），注释写明两层分工：这里抓「代码打算说什么」，传输层由 test/log-check.ts 子进程钉住。
- 5 个测试只换抓取口：断言文本/条数/顺序/否断言全部原样。open-platform-admin 抓 info+forward；periodic-off 抓 info；policy 抓 info 并只留 [ROUTE] 行其余转发；zcode-claim/manual 抓 info+warn。
- typecheck 绿；5 个测试单跑全绿（242/—/—/98/35 项）。
