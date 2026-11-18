# 主代理做事的地方

这份文件只注入主会话，子代理看不到。`CONVENTIONS.md` 写子代理必须遵守什么，这里写我派单、看护、收尾时要注意什么。

## 派单模板

子代理的读范围、写范围与 bash 白名单在启动那一刻固定，之后无法放宽；撞墙的子代理只能换掉，不能打补丁。所以照抄模板，不要凭记忆写 —— 一晚上有四单失败在记忆上（漏 `scope`、把 `lib/router/**` 写成通配、漏 `git switch`、漏 `pnpm-lock.yaml`）。

bash 白名单、环境变量、拒绝预算现在由项目档位（`.pi/subagent-bindings.json`）给，派单只写这一个任务独有的两个范围：

```js
options: {
  timeoutMs: 3_600_000,
  extensionBindings: {
    "pi-subagents-extend/1": {
      scope: [
        ...,                              // 本任务要改的那几个目录，写纯目录，不写 dir/**
        ".pi/worklogs",                   // 任务日志是交付物，永远要让它写
        "mise.toml",                      // 加测试要接线：mise run test 逐条列文件，不 glob
        "package.json", "pnpm-lock.yaml", // 动依赖才要
      ],
      writeScope: ["<同上的目录>"],       // edit/write 单独一份；不写等于 scope
    },
  },
}
```

派单时**不要**顺手传 `bash` —— 它按整块替换（数组不合并），会把档位里那套环境变量与白名单全部抹掉。真需要额外命令时，把整块重写一遍。

| 层 | 字段 | 管什么 | 谁给 |
| --- | --- | --- | --- |
| 读 | `scope` | `read`、`grep`、`find`、`ls` | 派单 |
| 写（工具） | `writeScope` | `edit`、`write` | 派单 |
| 写（进程） | `bash.writablePaths` 配 `writable` | bash 子进程的 Landlock | 档位 |

- `.git` 不要放进 `writeScope`。沙箱自己会给 git 需要写的那部分；放进去等于让子代理改 `hooks` 和 `config`，而父代理之后会执行它们。
- `writeScope` 不写等于 `scope`；`readOnly: true` 等于空写范围。
- 审核岗的 `scope: ["."]` 与 `writeScope: ["web/.gen"]` 写在 `review` 档里 —— 它们没有 `write` 工具，那份写范围只给 bash 开 `web/.gen`。
- 写被拒有独立预算 `maxWriteDenies`（默认 2），与读预算分开。一直想写说明用法错了，出路是让它交报告。
- `bash.deny` 是并集、调用方不能放宽：`git stash`、`git checkout`、`git restore`、`git switch`、`git reset`、`git clean`、`rm -rf` 都写在 `default` 档里，对每个子代理结构性禁掉。
- 档位文件不存在、JSON 错、或名字不在表里 —— 全部拒绝（fail closed），不是不限。
- `coder` 档里没有 `scope`：这是有意的，读范围每个任务不一样。代价是派单忘了写 `scope` 时，文件访问全被拒（会响，不静默）。

**任务正文里出现的每个路径，都要落在对应那一层。** 派单前对着正文数一遍。

### 约束可能静默失效：两种情况都发生过

授权失效时**不会报错**，子代理照常干活，只是什么也不拦。发现方式只有一条：定期派一单跑一条**必须被拒**的命令，看拒绝文案里的 `source:` 是否点名了档位。允许跑通不算证据。

已踩过两次：

- **namespace 写错**。扩展只认 `<包名>/<版本>` 并且包名是复数（`pi-subagents-extend/1`）。写成单数、或写对名字但不带版本号，扩展判定「这条绑定是给别的扩展的」，直接忽略。
- **档位载入口断链**。`~/.pi/agent-profiles/{coder,review}.ts` 里 `import` 的是绝对路径，包改名后那行指向不存在的目录，导入失败使整个扩展不加载。改这个扩展的名字或位置之后，两个载入口都要跟着改，然后重跑一次必须被拒的探针。

探针模板（两个档位各一次）：review 岗跑 `curl`、coder 岗跑 `git stash list`。两条都必须被拒，且文案里 `source:` 分别点名 `profile review` 与 `profile coder`。

## 审核类 agent 没有写工具

`be-review`、`fe-review`、`pr-review`、`privacy-review` 的 agent 定义里 `tools` 是 `read, grep, find, ls, bash`，没有 `write` 与 `edit`。由此：

- 不要让它们把报告写进 `.pi/reviews/`。它们做不到，会反复试，然后被判原地打转终止 —— 有一单因此烧掉四十分钟。
- 它们的完整报告由运行时落到 `…/subagent-artifacts/<run>-<agent>_output.md`，实测 20 KB 的报告能完整保存。截断只发生在单次回复超出模型输出上限时。
- 大范围审核要拆小（一次一个子系统），或者明确要求「每节给结论、控制篇幅」。
- 想让审核岗逐段落盘，得先给它的角色定义加 `write`，那是改角色，单独决定。

## 让子代理真的能跑 `mise run`

子代理应该跑 mise task，不要绕过它直接调 `pnpm exec`。它会挂死，但病根不在 mise，也不在「要不要联网」—— 依赖都在全局 store 里，离线安装实测 90ms。真正的原因是工作树里少装了一个项目。

`web/` 是独立的 pnpm 项目（自己的 `pnpm-workspace.yaml` 与 `pnpm-lock.yaml`），不是根的 workspace 成员。setup 只装根时，`web/node_modules` 不存在，pnpm 只好在沙箱里现装：

```text
mise run web:typecheck
└─ cd web && pnpm typecheck
   └─ pnpm install --verify-deps-before-run-install   ← 挂 4 分钟，CPU 时间 00:00:00
```

沙箱里的三个症状是同一件事：

```text
[WARN] The store at ~/.local/share/pnpm/store/v11 is not used because packages cannot
       be hard linked from it into this project.        ← 工作树与总 store 不同文件系统
✗ Lockfile failed supply-chain policy check (378 entries)   ← 孤立缓存里没有验过的记录
sh: line 1: tsr: command not found                          ← web/node_modules/.bin 不存在
```

修法两半，缺一半都不行：

1. setup 把两个项目都装上（`931dd60`）。趁还有真 store 和网络时装；实测 web 一次离线安装 90ms，之后 `web:typecheck` 5.3 秒、`web:test` 527 项 25 秒。
2. 派单时给 `bash.env` 一条 `pnpm_config_verify_deps_before_run=false` —— 让 pnpm 不要在校验之后自己 install。

```js
bash: {
  env: { pnpm_config_verify_deps_before_run: "false" },
  writable: true,          // web:typecheck 会重写 web/.gen
  writablePaths: ["~/.pi/worktrees"],
}
```

第二半挡的是「依赖装了但与 lockfile 不同步时 pnpm 自己 install」这一种，闸门管不到它。

`pnpm_config_trust_lockfile` 不要加。它会把 pnpm 的供应链校验关掉，那是安全决策，不该搭配置的便车。`pnpm_config_frozen_store` / `package_import_method=copy` 也不必写：依赖齐了就不会有 install。

修好之后同一个沙箱、同一个命令：三个症状全没，`pnpm install` 一步也不再出现。

教训：第一次遇到挂死，我把它当成了流程问题（「子代理别跑 mise」），那是错的。看到子代理跑不动，先拆根因，不要先改流程。

扩展侧的闸门（`bash.dependencyGate`，默认开）会在命令跑起来之前检查「有 lockfile 的目录出现过安装结果没有」—— `node_modules/.bin` 或 Yarn PnP 的 `.pnp.cjs` 都算。扫的是 cwd 往下两层，所以 `web/` 与 `apps/web/` 这种布局都在范围里。

它只管会去装依赖的那几类：写类命令（构建、测试）与包管理器本身（即使被写进 `read` 列）。`git` 与只读命令放行 —— git 不需要 `node_modules`，而「先落任务日志再提交」这种保树纪律恰好在依赖缺失时最要用得上。包装器（`sh -c`、`env`、`timeout 30 …`）会穿透到真正跑的那条命令上，所以 `sh -c "pnpm test"` 拦、`sh -c "rg pnpm"` 不拦。

它不知道判据的边界在哪里就不叫判据：`node build.mjs` 里写了什么，命令行看不出来。

真撞到了，子代理的出路是 `contact_supervisor`，不是重试：这类拒不计入任何预算，因为重试装不上任何东西。

闸门只判「没装」，不判「装了但与 lockfile 不同步」；后者是 pnpm 的 `verify-deps-before-run` 在沙箱里试图自我修复，判据要拿 `.modules.yaml` 与 lockfile 对账，那就是项目知识了，扩展不带 —— 所以上面那条 `verify_deps_before_run=false` 仍然需要。

## 这台机器就是生产机：不要碰 `/data`

`/data` 是指向 `/mnt/data/agents` 的符号链接，里面是生产数据库，而且生产网关容器（`buddy-router`）正在这台机器上跑。

- 不许挂载、改权限、绑定覆盖 `/data` 或 `/mnt/data`，即使在私有 mount namespace 里、即使只读。想造一个「目录写不进去」的环境，不该拿生产路径做道具。
- 不许在主目录建库。跑可能触及默认数据目录的测试，先把 `FACADE_DATA_DIR` 指到 `/tmp` 下的临时目录，跑完删掉。
- 测试与实验产生的一切垃圾（库、日志、临时目录、反证时拷出的旧版本文件）只能落在仓库目录或 `/tmp`，收尾清掉。

教训：为了复现「默认数据目录不可写」，我挂载过 `/mnt/data`（错），后来又没挡住回落，跑修复前版本的测试时在主目录留下了 `~/.agentfacade/agentfacade.db`（也错）。复现这类缺陷不需要只读、也不需要挂载：缺陷是「库开错地方」，看那个地方有没有多出文件就够了 —— 用 `FACADE_DATA_DIR=/tmp/…` 把默认位置换掉，观察文件落在哪里。

## 在本机起第二个实例的前提

可以用自己的 `FACADE_DATA_DIR` 起一个实例，前提是它不持有 NAS 那些账号的会话 —— 同一份会话被两个进程轮流用会把令牌用废（2026-10-25 的事故）。不要拿生产库的副本起第二个网关。

## 排查上游不要手写探针

主代理自己也一样：不要 `node -e` 拼 URL、拼头、`fetch`。手写探针很容易重复叠一个凭据头，错误长得像上游的错（2026-10-28 那次 401 误判就是这么来的）。直接 `mise run probe`（头只从白名单函数来、写操作必须 `--yes-write`），要新请求就往 `tools/probes/<platform>.json` 加一条配置（配置里只写常量名 `$const.X`，不写版本号/平台字面量，写死会与网关真实发的头/参数漂移）；不方便自己跑时派单去跑。

## steer 时不要让子代理重复跑同一条命令

原地打转探测按整轮累计，同一条命令第三次就停。我在 steer 里写「再确认一下 `git status --short`」，把一单直接送走了。要问状态就换成没跑过的读法，比如 `git log --oneline -3`。

## worktree 的交付与清理

- 交付物是 patch，不是目录。`cleanup.complete` 时工作树与分支都会被删，子代理报告里的分支名和短 sha 之后就解析不到了；按 sha cherry-pick 可行，按分支名交付不可行。
- `groups[].children[].patch` 的 `diffStat` 与文件大小是「做了多少」最可信的凭据，比子代理自述可靠。0 字节就是什么都没写。
- 有活且 patch 校验通过时会连分支一起删；写了日志、`git add` 过也一样被删。脏树不保证保留。
- 子代理报「改了但提交不了」时，直接去它的工作树把文件抄进主树，验证后由我提交。

## 提交前的门禁顺序

`mise run privacy` 先过（便宜，撞上就是有真东西进来了），再跑全量 `mise run check`。隐私扫描的结论要能写成可核对的事实，不是「看起来是假的」。
