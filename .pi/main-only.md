# 主代理做事的地方

这份文件只注入主会话，子代理看不到。`CONVENTIONS.md` 写子代理必须遵守什么，这里写我派单、看护、收尾时要注意什么。

## 派单模板

子代理的读范围、写范围与 bash 白名单在启动那一刻固定，之后无法放宽；撞墙的子代理只能换掉，不能打补丁。所以照抄模板，不要凭记忆写 —— 一晚上有四单失败在记忆上（漏 `scope`、把 `lib/router/**` 写成通配、漏 `git switch`、漏 `pnpm-lock.yaml`）。

```js
options: {
  timeoutMs: 3_600_000,
  extensionBindings: {
    "pi-subagent-extend/1": {
      scope: [
        ...,                              // 本任务要改的那几个目录，写纯目录，不写 dir/**
        ".pi/worklogs",                   // 任务日志是交付物，永远要让它写
        "mise.toml",                      // 加测试要接线：mise run test 逐条列文件，不 glob
        "package.json", "pnpm-lock.yaml", // 动依赖才要
      ],
      writeScope: ["<同上的目录>"],       // edit/write 单独一份；不写等于 scope
      maxDenies: 0,                     // 默认 3 会把一个笔误变成死单
      bash: {
        read: ["git status", "git diff", "git log", "git show", "mise run typecheck"],
        write: ["git add", "git commit", "mise run test"],
        writable: true,                  // 没有它，web/.gen 与生成物目录写不进去
        writablePaths: ["~/.pi/worktrees"],
      },
    },
  },
}
```

三层授权各管各的，不要混：

| 层 | 字段 | 管什么 |
| --- | --- | --- |
| 读 | `scope` | `read`、`grep`、`find`、`ls` |
| 写（工具） | `writeScope` | `edit`、`write` |
| 写（进程） | `bash.writablePaths` 配 `writable` | bash 子进程的 Landlock |

- `.git` 不要放进 `writeScope`。沙箱自己会给 git 需要写的那部分；放进去等于让子代理改 `hooks` 和 `config`，而父代理之后会执行它们。
- `writeScope` 不写等于 `scope`；`readOnly: true` 等于空写范围。
- 审核岗是「读整个仓库、只写报告」：`scope: ["."]`、`writeScope: [".pi/reviews"]`。
- 写被拒有独立预算 `maxWriteDenies`（默认 2），与读预算分开。一直想写说明用法错了，出路是让它交报告。

**任务正文里出现的每个路径，都要落在对应那一层。** 派单前对着正文数一遍。

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
2. 给沙箱里的 pnpm 一份只读、离线、允许拷贝的配置。

```js
bash: {
  env: {
    pnpm_config_verify_deps_before_run: "false",  // pnpm 自己的 WARN 就建议这么写
    pnpm_config_offline: "true",
    pnpm_config_frozen_store: "true",             // 只读 store，允许它不写 store
    pnpm_config_trust_lockfile: "true",           // 跳过供应链策略校验，离线验不了
    pnpm_config_package_import_method: "copy",    // 硬链接不了就拷贝
  },
  writable: true,
  writablePaths: ["~/.pi/worktrees"],
}
```

两个 flag 的用途取自 `pnpm install --help`：`--frozen-store` 是 "Open the store read-only and skip all store writes. For installing against a store on a read-only filesystem"，`--trust-lockfile` 是 "Skip verifying the lockfile against supply-chain policies"。

修好之后同一个沙箱、同一个命令：三个症状全没，`pnpm install` 一步也不再出现。

教训：第一次遇到挂死，我把它当成了流程问题（「子代理别跑 mise」），那是错的。看到子代理跑不动，先拆根因，不要先改流程。

## 这台机器就是生产机：不要碰 `/data`

`/data` 是指向 `/mnt/data/agents` 的符号链接，里面是生产数据库，而且生产网关容器（`buddy-router`）正在这台机器上跑。

- 不许挂载、改权限、绑定覆盖 `/data` 或 `/mnt/data`，即使在私有 mount namespace 里、即使只读。想造一个「目录写不进去」的环境，不该拿生产路径做道具。
- 不许在主目录建库。跑可能触及默认数据目录的测试，先把 `BUDDY_DATA_DIR` 指到 `/tmp` 下的临时目录，跑完删掉。
- 测试与实验产生的一切垃圾（库、日志、临时目录、反证时拷出的旧版本文件）只能落在仓库目录或 `/tmp`，收尾清掉。

教训：为了复现「默认数据目录不可写」，我挂载过 `/mnt/data`（错），后来又没挡住回落，跑修复前版本的测试时在主目录留下了 `~/.buddy-proxy/buddy.db`（也错）。复现这类缺陷不需要只读、也不需要挂载：缺陷是「库开错地方」，看那个地方有没有多出文件就够了 —— 用 `BUDDY_DATA_DIR=/tmp/…` 把默认位置换掉，观察文件落在哪里。

## 在本机起第二个实例的前提

可以用自己的 `BUDDY_DATA_DIR` 起一个实例，前提是它不持有 NAS 那些账号的会话 —— 同一份会话被两个进程轮流用会把令牌用废（2026-10-25 的事故）。不要拿生产库的副本起第二个网关。

## steer 时不要让子代理重复跑同一条命令

原地打转探测按整轮累计，同一条命令第三次就停。我在 steer 里写「再确认一下 `git status --short`」，把一单直接送走了。要问状态就换成没跑过的读法，比如 `git log --oneline -3`。

## worktree 的交付与清理

- 交付物是 patch，不是目录。`cleanup.complete` 时工作树与分支都会被删，子代理报告里的分支名和短 sha 之后就解析不到了；按 sha cherry-pick 可行，按分支名交付不可行。
- `groups[].children[].patch` 的 `diffStat` 与文件大小是「做了多少」最可信的凭据，比子代理自述可靠。0 字节就是什么都没写。
- 有活且 patch 校验通过时会连分支一起删；写了日志、`git add` 过也一样被删。脏树不保证保留。
- 子代理报「改了但提交不了」时，直接去它的工作树把文件抄进主树，验证后由我提交。

## 提交前的门禁顺序

`mise run privacy` 先过（便宜，撞上就是有真东西进来了），再跑全量 `mise run check`。隐私扫描的结论要能写成可核对的事实，不是「看起来是假的」。
