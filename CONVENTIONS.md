# 子代理约定

这份文件写给在本仓库干活的所有子代理。主代理派你来做一件范围有限的事，这里是你要遵守的规则。

`AGENTS.md` 写领域词汇（agent、模拟端、upstream、provider）、项目结构与不可退让的安全规则；其中被 `<!-- main-agent-only:start -->` 与 `<!-- main-agent-only:end -->` 包住的段落是主代理的职责，跳过即可。角色定义 `.pi/agents/<role>.md` 与这份文件冲突时，以角色定义为准。

## 读什么，跳过什么

- 需要领域词汇、目录结构、安全规则：读 `AGENTS.md`，跳过 main-agent-only 段落。
- 需要知道改哪一组、怎么验证：看下面的「测试只跑覆盖你改动的那一组」。
- 派单消息里给了精确路径与硬约束：以派单消息为准。

## 不要部署、不要推送

- 不部署、不推送、不合并、不改 `main`。
- 共享工作区里 `git commit` 会把别人未提交的活一起带走，所以不要提交；只有在独立 worktree 里才提交，见下一节。
- 不自行扩大范围。确实需要动范围外的文件时，停下来报告，由主代理决定。

## 测试只跑覆盖你改动的那一组

**统一跑 `mise run verify`。** 它按 diff 算出你改了哪些路径、该跑哪几组门禁，然后顺序跑（`--plan` 只打印计划，`--base <rev>` 指定基线）。不用人记下面的表 —— 表留作案头参考，改了表格也要同步改 `tools/verify-changes.ts` 的规则。

`mise run check` 是主代理提交前的全量门禁，约六分钟。开发过程中只跑覆盖你改动的那一组：

| 任务 | 覆盖 |
| --- | --- |
| `mise run check:admin` | 面板后端：账号、凭据、平台、模型目录（`lib/admin`、`lib/provider-kinds.ts`、`lib/platforms*`、`lib/model-catalog*`） |
| `mise run check:routing` | 选号、降级、冷却、健康、用量、定时任务（`lib/router`、`lib/cooldown*`、`lib/session*`、`lib/periodic*`） |
| `mise run check:deliver` | 响应投递：帧、背压、方言、客户端离开、日志脱敏（`lib/router/handle.ts`、`lib/dialect`、`lib/log-scrub*`） |
| `mise run check:kinds` | 上游 kind、模拟端与开放平台（`lib/kinds`、`lib/minimax`、`lib/qoder`、`lib/workbuddy`、`lib/zcode`、`lib/tokenrhythm`、`lib/intern-ai`、`lib/qiniu`、`lib/xinghuo`、`lib/sensenova`） |
| `mise run check:misc` | 目录一致性、清理规则、辅助脚本、隐私扫描器自身的测试、离线矩阵（`test/`、仓库根配置如 `.gitignore`） |
| `mise run check:web` | 面板前端，不启浏览器（`web/src`） |
| `mise run check:panel` | 面板端到端，真浏览器（仓库根的 `tests/` 用例与 `web/e2e`，需要系统 chromium，约三分钟） |

改动 `proto/**` 时自己跑 `mise run proto`，两份生成物（`lib/gen` 与 `web/.gen`）都就位才算做完。
改动了 `web/**` 里的用户可见文案或渲染条件时，`check:web` 不够：它只跑单测。文案在 e2e 里也有断言，跑一次 `mise run check:panel`（真浏览器，约三分钟），否则单测全绿、面板 e2e 红，主代理要重来一轮。

你不提交，但也不要留下真实身份、凭据或内网地址 —— 主代理提交前会跑 `mise run privacy` 扫这些。

## 在 worktree 里干活

有些任务在独立 worktree 里开工（`subagent({worktree: true})`）。规则只有一处不同：**在这个分支里提交**。不要在 `main` 上提交，不要合并，不要推送。

你的活要能在被杀之后活下来 —— 超时、上游报错、终端关掉。只有已提交的东西能活下来，所以：

1. **依赖已经装好。** setup 钩子（`.pi/worktree-setup.sh`）在你启动前装了根与 `web/` 两个项目，`node_modules` 是真目录而不是指向主仓的符号链接。不要自己再装。
2. **不用建分支。** worktree 已经在自己那条分支上，直接提交；`git switch -c` 会失败（沙箱写不了 `refs/heads/*.lock`）。
3. **先写任务日志，再写代码。** 第一件事是建 `.pi/worklogs/<任务名>.md` 并提交。它同时是「树是脏的」这个信号 —— 管理型 worktree 只有在什么都没留下时才会被删掉。
4. **边做边写日志，日志和改动一起提交。** 每跨过一个能向别人描述的步骤（改了文件、测试变红、找到了原因），就追加一句做了什么、学到什么，然后 `git add -A && git commit -m "wip: <步骤>"`。自己分支上的 `wip:` 提交是正确的，没人会把它当正式历史读。
5. **跑长命令之前先提交。** `mise run check`、全量测试、e2e、长时间的探针都算。中途被停掉时，未提交的一小时就没了；未提交的半小时比粗糙的半小时更糟 —— 下一个读的人分不清哪句写完了。
6. **半成品是陷阱。** 宁可提交一个能编译的改动，也不要留一个只应用了一半的大改动。必须停在半路时，在日志最后一行写明停在哪。

任务日志不是最后的总结，而是任务的状态。

### bash 被拒时说依赖缺失

文案里有 `has a lockfile but no node_modules/.bin` 时，是某个目录的依赖没装好 —— 环境问题，不是你的用法问题。重试不会变好，这类拒绝也不计入你的拒绝预算。用 `contact_supervisor` 说明缺哪个目录，等主代理处理。

同一类拒绝的文案也可能写成 `no node_modules/.bin or .pnp.cjs`，那是 Yarn PnP 项目里的同一种情况，处置方式一样。

被拦的是构建、测试与包管理器这几类；`git` 与只读命令照常可用，所以写日志、提交、看状态都不受影响。依赖缺失时该做的，正是先把日志和已完成的改动提交掉。

### 交付报告要写清四样

工作要能脱离你被接手：

- 分支名与最新提交 sha（`git log --oneline -1`）
- `git status --short`：空表示全部已提交；不空就说明哪些没提交、停在哪
- 任务日志路径
- 未决问题一段

主代理会把你的提交 cherry-pick 回主树。只存在于 worktree 目录里的活等于被扔掉，这里出过这种事。

## 不要碰别人的文件

并行子代理可能共用同一个工作树（由主代理决定）。无论哪种情况，下面三个命令都禁用，它们会把别人未提交的活一起带走：

```sh
git stash        git checkout -- <file>        git restore <file>
```

要看某个文件改之前长什么样，用 `git show HEAD:<path>`，或者自己开一个临时 worktree（`git worktree add /tmp/base HEAD`）。同样能回答那个问题，而且不碰共享树。

## 几个踩过的领域事实

- 上游响应正文要进日志，不只是状态码。排查上游行为时，先录一次真实响应，之后对着假上游重放。
- 面板把平台显示成绿色，必须表示「最近真的发得出去」。
- 额度用尽、余额不足、排队是三种不同状态，不要把一种映射成另一种。
- 拿推理模型当探针时，`max_tokens` 给 256：正文与思考共用同一份预算，给太小（32）思考就吃光了、正文是空的（`finish_reason` 也可能是 `stop`），看起来像「模型不工作」。给太大只是白花钱。
- 排查上游**不要手写一次性脚本**（`node -e` 拼 URL、拼头、`fetch`）：手写时很容易重复叠一个凭据头，两个大小写不同的键让 `fetch` 拼成非法值，上游一律 401 —— 错误长得像「令牌过期」，其实是探针自己的错（2026-10-28 那次就是这么误判的）。用 `mise run probe`：要新请求就往 `tools/probes/<platform>.json` 加一条配置，头只从白名单函数来，写操作必须 `--yes-write`；**配置里只写常量名（`$const.X`，登记在 `tools/probe.ts` 的 `CONSTS`），不写版本号/平台字面量** —— 写死一份必与网关真实发的头/参数漂移，问出去的是另一个客户端身份的问题。

## 测试样例

编造的凭据与上游响应写成一眼能看出是假的（`sk-TESTONLY…`、`example.com`、`probe.example`）。测试要验证的正是那个形状时，在那一行上标：

```ts
api_key: "sk-TESTONLY0000000000", // privacy:allow — fabricated sample
```

标记只覆盖那一行，永远不覆盖真值。这个仓库是公开的。

## 临时文件落在仓库目录或 `/tmp`

测试与实验产生的库、日志、临时目录都放在本仓库目录或 `/tmp` 下，收尾时删掉。不要在用户主目录里建任何东西。

默认数据目录的回落顺序是 `FACADE_DATA_DIR` → `/data`（存在就优先）→ `$HOME/.agentfacade`。跑可能触及默认目录的测试时，先把 `FACADE_DATA_DIR` 指到 `/tmp` 下的临时目录。

## 假上游只有两条固定入口

- 测试里：`import { startFakeUpstream } from "./fake-upstream.ts"`（`test/fake-upstream.ts`）。端口随机、请求按序记录、`close()` 会真的关掉 keep-alive 连接。
- 手动看探针会发什么：`mise run probe -- … --dry-run`（不发送）或 `--fake`（发到进程内假上游，打印「发出」与「收到」两侧）。

**不许**在 bash 里手写服务器文件、用 `&` 起后台进程再 `sleep` + `wait`：那条命令永不返回，看起来像卡死（已经有人这么把自己挂死过几分钟）。也别自己 `http.createServer` 再起一套 —— 收口在这两个入口里，keep-alive 挂死这类坑才不用每个用例重新踩一遍。

## 面板的测试用面板自己的配置跑

`web` 的 vitest 配置里有 `@/` 别名。在仓库根直接 `npx vitest` 会报 `Cannot find package '@/gen/…'`、整个文件 0 test —— 看起来像测试坏了，其实只是跑错了地方。要在 `web/` 里跑：

```sh
cd web && pnpm exec vitest run src/features/x.test.tsx
```
