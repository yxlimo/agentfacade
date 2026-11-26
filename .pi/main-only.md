# 主代理做事的地方

这份文件只注入主会话，子代理看不到。`CONVENTIONS.md` 写子代理必须遵守什么，这里写我派单、看护、收尾时要注意什么。

## 派单模板

子代理能读什么、能写什么、能跑什么，写在各角色自己的 `.pi/agents/<role>.md` 的 `extend:` 块里。派单只给三样：

```text
subagent(agent: "be-core-routing", model: "agentfacade/coder-subagent", task: "……")
```

```text
agent   角色名，与 .pi/agents/<role>.md 的 name 一致
model   agentfacade/<模型>，模型名不带前缀猜；写错会在起跑前报「Unknown model」
task    目标 + 硬约束 + 验收命令；不要逐条列文件行号，范围已经在 md 里
```

**派单一律用 `agentfacade/coder-subagent`。** 它发布在 5 个账号上（权重 5/4/3/2/1），策略是 `balance`：按会话键做加权一致性哈希，同一个会话固定落在同一个上游（保住上游缓存），不同会话按权重分摊。派单是它唯一的日常用法 —— 单子越多，分摊越接近权重；一个会话一个上游，不会中途换人。

不要把模型写回某个具体账号（`coder-d` 之类）：那是单账号的模型，分摊就没了。审核岗也一样，它们的区别在角色授权，不在模型。

`worktree` 默认由 md 给（实现岗 `true`、审核岗 `false`）；显式写会覆盖 md，所以只有确实要在主检出里跑时才写 `worktree: false`。其它 options 只在任务真的有特殊需要时才加：`timeoutMs`（长任务）、`name`（工作树分支名，别让 harness 从任务正文里猜）。

**范围写错时的症状是 `EACCES` 或「不在允许范围内」，且拒绝文案会点名是哪一份 md 判的。** 写范围在子代理启动那一刻固定，运行中无法放宽 —— 撞墙的子代理只能重派，不能打补丁。因此：

- 构建/测试类角色必须能在工具链产物目录里写：`web/.gen`（`copy-gen.mjs` 先 `rmSync` 再重建）、`web/.tanstack`（`tsr generate`）、`web/dist`（vite）、`.e2e`（e2e 报告）、`web/node_modules`（vite 缓存）。少任何一个，第一次跑门禁就死在 `EACCES`，而不是死在代码上。
- 要加测试就得能写 `test/**`、`tests/**`、`mise.toml`：`mise run test` 逐条列文件，不 glob，新用例不接线就永远不跑，而「加了 smoke 测试却没人记得给任务」已经让一次本地全绿变成 CI 红。

### 什么时候还要手写 `extensionBindings`

只有两种：**前台子代理**（`async: false`，此时环境扩展不加载，要在 md 的 `subagentOnlyExtensions` 里声明），或者一次性场景、没有对应角色 md。用法与字段拼写和 md 不同（`writeScope`、`maxDenies`），且它整体替换 md 那一层而不是合并 —— 传了 `bash` 就把 md 的整块白名单抹掉。项目里已经不再有 `.pi/subagent-bindings.json` 那种档位文件：新版本扩展不读它，留着等于假策略。

### 约束可能静默失效：先证明它在生效

授权失效时**不会报错**，子代理照常干活，只是什么也不拦。所以每个角色第一次上场、或改过它的 `extend:` 块之后，跑三条探针：

```text
1. 越界读     read /etc/hostname          → 必须被拒，文案点名 .pi/agents/<role>.md
2. 越界写     write lib/router/handle.ts  → 必须被拒（该角色没有这个写授权）
3. 下限       git commit --allow-empty    → 必须被拒（deny 里写死的）
```

三条都拒了，再加两条**必须放行**的，否则「全拒」也会让上面三条通过：

```text
4. 范围内的读   read <该角色的一个源文件>  → 成功
5. 门禁         mise run <该角色常跑的一组分> → 真跑出结果，不是 writable/依赖的拒绝
```

再看一眼 prompt 形态：`systemPromptMode: append` 下孩子应该还认得锚点编辑工具；`tools:` 一旦被写回去，孩子会在第一次请求前就死（`edit` 在 `pi-hashline-edit-pro` 宿主上不注册）。

## 审核类 agent 没有写工具

`be-review`、`fe-review`、`pr-review`、`privacy-review` 的角色定义是 `readOnly: true`：`write` 工具与锚点编辑工具族都被拒，bash 也只放了读命令（`git show` / `git diff` / `git log` 一类）。由此：

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

修法在钩子里，不在派单里：

`~/.pi/agent/extensions/subagent/config.json` 用 `worktreeSetupHook` 指向一个全局 shim，shim 转调仓库自己的 `.pi/worktree-setup.sh`（根与 `web/` 两个项目各装一次，装完各自校验 `node_modules/.bin`）。没有 `worktreeSetupHook` 这一项时钩子根本不跑 —— 工作树只有自动建的 `node_modules` 软链，`web/node_modules` 是空的。

**这份配置在 pi 启动时读进内存，改了要重启 pi 才生效**，改文件本身不会热加载。钩子没跑时的症状不是报错而是挂着：`mise run web:*` 停在「Verifying lockfile against supply-chain policies」，看着像卡死。判据一条：`ls <工作树>/web/node_modules/.bin`（有 `tsc`/`tsr` 才算装上了）。

钩子的两个契约，破一条就起不来：

```text
stdout   只能是一行 {"syntheticPaths": [...]}。项目脚本的 pnpm 输出若漏到 stdout
         （"✓ Lockfile is up to date" 这种），launch 直接报 invalid JSON。
退出码   0 = 成功；非 0 = 这单不启动。shim 把项目脚本的退出码原样传出去。
装之前   工作树已经有指回主检出的 node_modules 软链，install 前必须先删掉它，
         否则 pnpm 顺着链接装进主检出，工作树还是缺包。
```

钩子装好之后还有一类它管不到：「依赖装了，但与 lockfile 不同步」时 pnpm 会自己再 install 一次（`verify-deps-before-run`），沙箱里那一步没有网、store 也不可写，于是挂住。真遇到时给那一单的 dispatch 加 `bash.env: { pnpm_config_verify_deps_before_run: "false" }`，不要改仓库脚本。

`pnpm_config_trust_lockfile` 不要加。它会把 pnpm 的供应链校验关掉，那是安全决策，不该搭配置的便车。`pnpm_config_frozen_store` / `package_import_method=copy` 也不必写：依赖齐了就不会有 install。

修好之后同一个沙箱、同一个命令：三个症状全没，`pnpm install` 一步也不再出现。

教训：第一次遇到挂死，我把它当成了流程问题（「子代理别跑 mise」），那是错的。看到子代理跑不动，先拆根因，不要先改流程。

扩展侧的闸门（`bash.dependencyGate`，默认开）会在命令跑起来之前检查「有 lockfile 的目录出现过安装结果没有」—— `node_modules/.bin` 或 Yarn PnP 的 `.pnp.cjs` 都算。扫的是 cwd 往下两层，所以 `web/` 与 `apps/web/` 这种布局都在范围里。

它只管会去装依赖的那几类：写类命令（构建、测试）与包管理器本身（即使被写进 `read` 列）。`git` 与只读命令放行 —— git 不需要 `node_modules`，而「先落任务日志再提交」这种保树纪律恰好在依赖缺失时最要用得上。包装器（`sh -c`、`env`、`timeout 30 …`）会穿透到真正跑的那条命令上，所以 `sh -c "pnpm test"` 拦、`sh -c "rg pnpm"` 不拦。

它不知道判据的边界在哪里就不叫判据：`node build.mjs` 里写了什么，命令行看不出来。

真撞到了，子代理的出路是 `contact_supervisor`，不是重试：这类拒不计入任何预算，因为重试装不上任何东西。

闸门只判「没装」，不判「装了但与 lockfile 不同步」；后者是 pnpm 的 `verify-deps-before-run` 在沙箱里试图自我修复，判据要拿 `.modules.yaml` 与 lockfile 对账，那就是项目知识了，扩展不带 —— 所以「装了但与 lockfile 不同步」那种仍要单独处理一次。

## 这台机器就是生产机：不要碰 `/data`

`/data` 是指向 `/mnt/data/agents` 的符号链接，里面是生产数据库，而且生产网关容器（`buddy-router`）正在这台机器上跑。

- 不许挂载、改权限、绑定覆盖 `/data` 或 `/mnt/data`，即使在私有 mount namespace 里、即使只读。想造一个「目录写不进去」的环境，不该拿生产路径做道具。
- 不许在主目录建库。跑可能触及默认数据目录的测试，先把 `FACADE_DATA_DIR` 指到 `/tmp` 下的临时目录，跑完删掉。
- 测试与实验产生的一切垃圾（库、日志、临时目录、反证时拷出的旧版本文件）只能落在仓库目录或 `/tmp`，收尾清掉。
- 假上游只有两条固定入口：测试里 import `test/fake-upstream.ts` 的 `startFakeUpstream`；手动看探针用 `mise run probe -- --dry-run` / `--fake`。不许手写服务器文件用 `&` 起后台进程再 `sleep` + `wait` —— 那条命令永不返回，看起来像卡死。

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

### 让 diff 决定跑什么

全量 `check` 是六分钟，多数提交只该跑一两组。`mise run verify` 从 diff 算出来该跑哪几组（`--plan` 只打印计划），规则表在 `tools/verify-changes.ts`，基线默认取与 `main` 的 merge-base，含未提交改动。

```sh
mise run verify --plan --base HEAD~5   # 看会跑什么、为什么
mise run verify                        # 真跑
```

判据容易漏的三处，都踩过：面板 e2e 用例在仓库根的 `tests/`（不是 `web/e2e/`）；`test/**`（单数）与 `tests/**` 是两个目录，归属不同；不认识的路径一律拉全量 `check`，所以新增目录时要顺手补规则。

`mise run hooks:install` 把它挂成 pre-commit（`core.hooksPath=.githooks`）。hook 在环境不可用时放行并说明原因 —— 环境坏不该拦住提交，真正的漏洞在 CI 或全量 check 暴露。绕过用 `git commit --no-verify`，只在**明知**门禁环境坏掉时用。

### 子代理说「提交不了」时先看仓库本身

已经发生过一次：沙箱把 `GIT_DIR` / `GIT_WORK_TREE` 传给子进程，测试里在临时目录跑 `git init` + `commit` + `config user.email` 时，git 认的是继承来的仓库 —— 一次性提交串进了子代理的分支，主仓库的 `.git/config` 被写成 `core.bare = true` 并带上 `user.email = ci@example.com`，`git status` 报「must be run in a work tree」。

排查顺序：`git config --get core.bare`（必须是 `false` 或空）、`git config --get user.email`（不能是测试里的假身份）、`git status` 能不能跑。修完再核对提交作者是否被带歪（`git log --format='%an <%ae>'`），必要时用 `filter-branch` 改回。测试侧的防法写在 `CONVENTIONS.md` 的「在测试里跑 git 前先清环境」。
