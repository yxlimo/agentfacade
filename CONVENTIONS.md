# Subagent conventions

Rules for any subagent working in this repository. The main agent dispatched you for a
bounded task; this file is what applies to you, and `AGENTS.md` is what applies to the
main agent.

## What to read, and what to skip

Read `AGENTS.md` for the domain vocabulary (agent / simulated client / upstream / provider),
how the project is laid out, and the non-negotiable safety rules. **Skip every section
wrapped in `<!-- main-agent-only:start -->` … `<!-- main-agent-only:end -->`:** dispatch
discipline and the pre-commit privacy review are the main agent's job, not yours.

Your own role file (`.pi/agents/<role>.md`) wins over both when they disagree about scope.

## You do not ship

- Do not `git commit`, do not deploy, do not push. Stop when the change and its tests are
  done and report.
- Do not widen the scope you were given. If the work genuinely requires touching a file
  outside it, say so and stop rather than editing it.

## Tests: run the group that covers your change

`mise run check` is the full gate the main agent runs before committing (about six minutes).
While developing, run only the group covering what you touched:

| Group | Covers |
| --- | --- |
| `mise run check:admin` | panel backend: accounts, credentials, platforms, model catalogue (`lib/admin`, `lib/provider-kinds.ts`, `lib/platforms*`, `lib/model-catalog*`) |
| `mise run check:routing` | account selection, fallback, cooldown, health, usage, timer jobs (`lib/router`, `lib/cooldown*`, `lib/session*`, `lib/periodic*`) |
| `mise run check:deliver` | response delivery: frames, backpressure, dialects, client gone, log scrubbing (`lib/router/handle.ts`, `lib/dialect`, `lib/log-scrub*`) |
| `mise run check:kinds` | the upstream kinds, simulated clients and open platforms (`lib/kinds`, `lib/minimax`, `lib/qoder`, `lib/workbuddy`, `lib/zcode`, `lib/tokenrhythm`, `lib/intern-ai`, `lib/qiniu`, `lib/xinghuo`, `lib/sensenova`) |
| `mise run check:misc` | catalogue parity, cleanup rules, helper scripts, the privacy scanner's own test, the offline matrix |
| `mise run check:web` | panel frontend, no browser (`web/src`) |
| `mise run check:panel` | panel end-to-end suite in a real browser (needs system chromium, about 90 seconds) |

Touched `proto/**`? Run `mise run proto` yourself and commit nothing until both
generated copies (`lib/gen` and `web/.gen`) are in place.

The main agent runs `mise run privacy` first, then the full `mise run check` before
committing. You do not commit, so you only need the group above — but do not leave real
identities, credentials or internal addresses behind for that scan to find.

## When the main agent gives you a worktree

Some tasks arrive isolated in their own worktree (`subagent({worktree: true})`). Inside one
the rule is different in exactly one way: **commit there, in that branch.** Do not commit on
`main`, do not merge, do not push.

Your work has to survive being killed — a timeout, an upstream error, a closed terminal. The
only thing that survives is what is committed, so:

0. **Dependencies are already installed.** The worktree setup hook (`/.pi/worktree-setup.sh`)
   runs `pnpm install` before you start, so `node_modules` is a real directory, not a symlink
   into the main checkout. Do not install anything yourself.

0b. **You do not need to create a branch.** The worktree already sits on its own branch. Commit
   there directly; do not `git switch -c` (the sandbox cannot write `refs/heads/*.lock`).

0c. **A dirty worktree is what keeps it alive.** A managed worktree is only deleted when you
   left nothing behind (`git status` empty). Writing your task log counts as a change, so the
   first thing you do — before code — is create `.pi/worklogs/<task-name>.md` and commit it.
   From then on the tree survives even if your run is killed.

1. **Write your task log first, then work.**
   ```sh
   mkdir -p .pi/worklogs && $EDITOR .pi/worklogs/<task-name>.md   # then: git add -A && git commit
   ```
   The log is `.pi/worklogs/<task-name>.md` (tracked; `docs/` is not). It is not a summary you
   write at the end — it is the running state of the task.

2. **Update the log as you go, and commit both together.** After each step that you could
   describe to someone else — a file changed, a test now red, a cause found — append what
   you did and what you learned, then `git add -A && git commit -m "wip: <step>"`. Small
   `wip:` commits in your own branch are correct here; nobody reads this branch's history as
   prose.

3. **Commit before any command you expect to take minutes** (`mise run check`, the full test
   sweep, an e2e run, a long probe). If the harness stops you mid-command, an uncommitted
   hour is gone and an uncommitted half-hour is worse than a rough one — the next reader
   cannot tell a finished edit from a half-written one.

4. **A file you did not finish is a trap.** Prefer leaving a change in a state that compiles
   and commit it, over a larger change that half-applies. If you must stop mid-edit, say so
   in the log's last line.

### What your final report must contain

So the work can be recovered without you:

- the branch name and the latest commit sha (`git log --oneline -1` on your branch)
- `git status --short` — empty means everything you did is committed; if not empty, list what
  is uncommitted and where it stands
- the path of your task log, and one paragraph naming the open questions left in it

The main agent cherry-picks your commits into `main`. Work that exists only in a worktree
directory — or only in a worktree the harness has already deleted — is work that was thrown
away; that has happened here before.

## Delegation bindings (the main agent writes these, the child lives inside them)

A child's scope and bash allowlist are fixed when it launches — they cannot be widened
afterwards, and a child that hits the wall has to be replaced, not patched. So the main agent
copies a template instead of writing one from memory; three tickets tonight failed on
remembered bindings (no `scope`, `lib/router/**` mis-parsed, `git switch` missing):

```js
options: {
  timeoutMs: 3_600_000,
  extensionBindings: {
    "pi-subagent-extend/1": {
      scope: [
        ...,                              // ← 本任务要改的那几个目录（纯目录，不写 dir/**）
        ".pi/worklogs",                   // 任务日志是交付物，永远是它写的
        "mise.toml",                      // 加测试要接线：mise run test 逐条列文件，不 glob
        "package.json", "pnpm-lock.yaml", // 动依赖就要
      ],
      writeScope: ["<同上的目录>"],       // 写（edit/write）单独一份；不写 = 等于 scope
      maxDenies: 0,                     // the latch turns a mistake into a dead run
      bash: {
        read: ["git status", "git diff", "git log", "git show", "mise run typecheck"],
        write: ["git add", "git commit", "mise run test"],
        writable: true,                  // 没有它，web/.gen、生成物目录写不进去
        writablePaths: ["~/.pi/worktrees"],
      },
    },
  },
}
```

三层授权各管各的，别混：

| 层 | 字段 | 管什么 |
| --- | --- | --- |
| 读 | `scope` | `read` / `grep` / `find` / `ls` |
| 写（工具） | `writeScope` | `edit` / `write` |
| 写（进程） | `bash.writablePaths`（配 `writable`） | bash 子进程的 Landlock |

- **`.git` 不要放进 `writeScope`**：沙箱自己会给 git 要写的那部分，放进去等于让子代理改 `hooks`/`config`，而父代理之后会执行它们。
- `writeScope` 不写 = 等于 `scope`；`readOnly: true` = 空写范围。
- 审核岗就是「读整个仓库、只写报告」：`scope: ["."]`、`writeScope: [".pi/reviews"]`。
- 写被拒有**独立预算** `maxWriteDenies`（默认 2），跟读预算分开 —— 一直想写是用法错，正确出路是交报告。

**任务正文里出现的每个路径，都必须落在对应那一层里。** 派单前对着任务正文数一遍。
今晚四次失败全是这一条没做：漏 `scope`、写 `lib/router/**`、漏 `git switch`、漏 `pnpm-lock.yaml`。

### 审核类 agent 没有写工具

`be-review` / `fe-review` / `pr-review` / `privacy-review` 的 agent 定义里 `tools` 是
`read, grep, find, ls, bash` —— **没有 `write`/`edit`**。所以：

- 不要让它们「把报告写进 `.pi/reviews/`」。它们做不到，会反复试然后被判原地打转。
- 它们的完整报告由运行时自动落盘到 `…/subagent-artifacts/<run>-<agent>_output.md`，
  大报告（实测 20 KB）也能完整保存；截断只发生在「单次回复超出模型输出上限」时。
- 所以大范围审核要**拆小**（一次一个子系统），或者明确要求「每节给结论，篇幅控制」。
  想要逐段落盘，只能先给审核 agent 加 `write` 工具——那是改角色定义，得单独决定。

Rules that came out of those failures:

- **Write scope entries as plain directories**, not `dir/**` — the glob form has been
  mis-parsed (a file under `lib/router/**` was reported as `"lib" not in scope`).
- **A worktree's dependencies are installed for you.** `.pi/worktree-setup.sh` runs
  `pnpm install` before the child starts, so the child never runs `pnpm install` itself; it
  only needs `mise run …` in `bash.read` / `bash.write`.
- **A worktree keeps itself alive while it is dirty.** The child creates
  `.pi/worklogs/<task>.md` first and commits it, then the tree survives a kill. Nobody needs
  `git switch -c`: the worktree already sits on its own branch.
- **`maxDenies: 0` unless you want the run to die.** The default latch (3) stops the whole
  run on repeated denials — including the tools the child still needs for its report.
- `mise.toml` belongs in scope whenever the task adds a test: the new file has to be wired
  into a task, and `mise run test` enumerates files rather than globbing.
- The child runs in a sandbox that cannot bind `127.0.0.1`, so harness tests
  (`test:catalog-parity` and friends) fail there. Let it write, and run those gates yourself.

### 让子代理真的能跑 `mise run …`

子代理**应该**跑 mise task，而不是绕过它去直接调 `pnpm exec`。它会挂死，但病根不在
mise，也不在「要不要联网」—— 依赖早就在全局 store 里了，离线安装实测只要 90ms。
真正的原因是**工作树里少装了一个项目**：

```text
mise run web:typecheck
└─ cd web && pnpm typecheck
   └─ pnpm install --verify-deps-before-run-install   ← 挂 4 分钟，CPU 时间 00:00:00
```

`web/` 是**独立的 pnpm 项目**（自己的 `pnpm-workspace.yaml` 与 `pnpm-lock.yaml`），
不是根的 workspace 成员。`.pi/worktree-setup.sh` 以前只装了根，`web/node_modules` 就不存在，
pnpm 只好在沙箱里现装 —— 那里 store 不可写、网络被切断，于是挂在锁上。沙箱里的三个症状
都是同一件事：

```text
[WARN] The store at ~/.local/share/pnpm/store/v11 is not used because packages cannot
       be hard linked from it into this project.      ← 工作树与总 store 不同文件系统
✗ Lockfile failed supply-chain policy check (378 entries)   ← 孤立缓存里没有验过的记录
sh: line 1: tsr: command not found                        ← web/node_modules/.bin 不存在
```

**修法有两半，缺一半都不行**：

1. **setup 把两个项目都装上**（`931dd60`）：趁还有真 store 和网络时装。实测 web 一次
   离线安装 90ms，之后 `web:typecheck` 5.3 秒、`web:test` 527 项 25 秒。
2. **给沙箱里的 pnpm 一份只读、离线、允许拷贝的配置**：

```js
bash: {
  env: {
    pnpm_config_verify_deps_before_run: "false",  // pnpm 自己的 WARN 就建议这么写
    pnpm_config_offline: "true",
    pnpm_config_frozen_store: "true",             // 只读 store，允许它不写 store
    pnpm_config_trust_lockfile: "true",           // 跳过供应链策略校验（离线验不了）
    pnpm_config_package_import_method: "copy",    // 硬链接不了就拷贝
  },
  writable: true,          // web:typecheck 会重写 web/.gen
  writablePaths: ["~/.pi/worktrees"],
}
```

两个 flag 的用途不是我编的，`pnpm install --help` 里原话：`--frozen-store` 是“Open the
store read-only and skip all store writes. For installing against a store on a read-only
filesystem”，`--trust-lockfile` 是“Skip verifying the lockfile against supply-chain
policies”。

**修好之后的证据**（同一个沙箱，同一个命令）：三个症状全没，`pnpm install` 一步也不再出现。

> 教训：第一次遇到挂死，我把它当成了流程问题（“子代理别跑 mise”）。那是错的 —— 是环境
> 没配好。看到子代理跑不动时，先去拆根因，不要先改流程。

### 面板测试要用面板自己的配置跑

`web` 的 vitest 配置里有 `@/` 别名，**在仓库根直接 `npx vitest` 会报 `Cannot find package
'@/gen/…'`，整个文件 0 test**（看起来像测试坏了，其实只是跑错地方）。要在 `web/` 里跑：

```sh
cd web && pnpm exec vitest run src/features/x.test.tsx
```

> 子代理被杀在“原地打转”上时，先看是不是**主代理让它重复跑了它已经跑过的命令**。
> 探测按整轮累计，同一条命令第三次就停 —— 我在 steer 里写「再确认一下 `git status --short`」，
> 直接把一单送走了。要问状态就用 `git log --oneline -3` 之类没跑过的读法。

## Never reach into someone else's files

Parallel subagents may share a checkout (the main agent decides). Either way these are
forbidden, because they take other people's uncommitted work with them:

```sh
git stash        git checkout -- <file>        git restore <file>
```

To see what a file looked like before your change, read `git show HEAD:<path>` or open a
throwaway worktree of your own (`git worktree add /tmp/base HEAD`). That answers the same
question without touching the shared tree.

## Facts that cost someone an afternoon

- Upstream response bodies belong in the log, not just the status code. When hunting an
  upstream's behaviour, record one real response, then replay it against a local fake.
- The panel shows a platform green only when it can actually serve a request today.
- Out-of-credits, out-of-balance and queueing are different states; do not map one onto
  another.

## Local experiments

You may start another instance on this machine only if it uses its **own** `BUDDY_DATA_DIR`
and holds **no session** that the NAS accounts use — sharing one session between two
processes burns the token (that is the 2026-10-25 incident). Never start a second gateway
on a copy of the production database.

## Test samples

Fabricated credentials and upstream responses go in tests as obviously fake values
(`sk-TESTONLY…`, `example.com`, `probe.example`). When the shape itself is what the test
must preserve, mark that single line:

```ts
api_key: "sk-TESTONLY0000000000", // privacy:allow — fabricated sample
```

The marker covers one line only, and never a real value. This repository is public.
