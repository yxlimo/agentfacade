# pi 项目配置

这个目录放 pi 与 pi-subagents 的项目配置。技能正文不在 `.pi/` 里，而在 `.agents/skills/`——OpenCode 与 pi 都读那个位置。

## 目录里有什么

| 路径 | 作用 |
| --- | --- |
| `.pi/agents/` | 14 个 agent 定义，权限写在各文件自己的 `extend:` 块里（读范围、写范围、bash 白名单、拒绝预算、默认工作树）。实现岗带 `write`，审核岗 `readOnly`。派单只传 `agent` + `model` + `task`。 |
| `.pi/main-only.md` | 只注入主会话的操作手册：派单模板、审批边界、生产机边界。子代理看不到。 |
| `.pi/worklogs/` | 子代理的任务日志，随任务提交；形状见该目录的 `README.md`。 |
| `.pi/worktree-setup.sh` | pi-subagents 建工作树后的安装钩子，根与 `web/` 两个项目都装、各自校验 `node_modules/.bin`。 |
| `.pi/check-subagent-only-skill.mjs` | 不调模型的回归检查：技能只出现在子代理提示词里（见文末）。 |
| `.pi/reviews/` | 审核报告的本机落点，用 `.git/info/exclude` 排除，不入库。 |

## 技能放哪

`.agents/skills/` 是唯一一份技能正文，两个客户端都读这个位置：

| 宿主 | 依据 |
| --- | --- |
| OpenCode | 项目 agent 兼容目录 `.agents/skills/<name>/SKILL.md`（从当前目录往 git 根走） |
| pi | 项目 agent 兼容目录 `<cwd>/.agents/skills/<name>/SKILL.md`（要项目被信任） |
| pi-subagents | 子代理按名字解析技能时扫 `<cwd>/.agents/skills` |

不需要软链。目录里现有 `hello-js-reverse-skill`（正文在本仓库），以及 `pnpm-e2e-e2e`——后者由 pnpm 的 `permissions.e2e.skills: true` 链接进来，指向本机 store，技能名是 `e2e`。

这份技能只对指定子代理可见，靠 agent 定义里的三行：

```yaml
inheritSkills: false
skills: e2e            # 或 hello-js-reverse-skill
skillPath: ../../.agents/skills
```

## 扩展装在哪

项目级扩展目录 `.pi/extensions/` 在 `08eb421` 之后不再使用；现在扩展装在用户目录，本机是软链：

```text
~/.pi/agent/extensions/pi-subagents-extend -> ~/extensions/pi-subagents-extend/packages/pi-plugin
~/.pi/agent/extensions/pi-wake            -> ~/extensions/pi-wake/packages/pi-plugin
```

`pi-subagents-extend` 一个包管三件事，入口不同：

- `src/index.ts`：权限范围与 bash 白名单，也由 agent 定义在 `subagentOnlyExtensions` 里声明。
- `src/main-context.ts`：主会话注入 `.pi/main-only.md`；后台子代理里剥掉 `AGENTS.md` 的 `<!-- main-agent-only -->` 段落。
- `src/child-context.ts`：只由 agent 定义的 `subagentOnlyExtensions` 声明，让前台子代理也剥标记。三个入口的分工见该包自带的 `skills/pi-subagents-extend-context`。

## 子代理的权限从哪来

权限写在 `.pi/agents/<role>.md` 的 `extend:` 块里，扩展是 `pi-subagents-extend`（`npm:pi-subagents-extend`，在 `~/.pi/agent/settings.json` 的 `packages` 里，后台子代理按环境自动加载）。派单只写 `agent` + `model` + `task`：

```text
subagent(agent: "fe", model: "agentfacade/coder-d", task: "……")
```

`extend` 块里四个字段决定这孩子能干什么：

| 字段 | 含义 |
| --- | --- |
| `permissions.scope` | 能读哪儿（`read`/`grep`/`find`/`ls`）。写 `["."]` = 整个仓库可读。 |
| `permissions.write` | 能写哪儿（`write` 与锚点工具族都算写）。工具链产物目录（`web/.gen`、`web/.tanstack`、`web/dist`、`.e2e`）必须逐个列出来，否则构建与 e2e 在 `EACCES` 上停住。 |
| `permissions.bash.allow` | 能跑哪些命令，按 token 前缀匹配（`mise run` 覆盖所有任务名，`git status` 覆盖 `git status --short`）。 |
| `permissions.bash.deny` | 拒绝下限，`allow` 再宽也压不住它。九条写死搬一遍（`git commit`/`push`/`rebase`/`merge`/`reset`/`clean`/`checkout`/`restore`/`switch`、`rm -rf`），外加本项目的 `mise run deploy`、`mise run proto`、`podman`、`docker`、`systemctl`、`gh`。 |

另外三条现在的规矩，都是从踩过的坑里来的：

- **不要写 `tools:`**。那是严格的已注册名单。锚点编辑工具由 `pi-hashline-edit-pro` 提供，`edit` 在某些宿主上根本不存在，写进去子代理起不来。工具边界靠 `scope`/`write` 收，不靠 `tools:`。
- **`systemPromptMode: append`**。`replace` 会把角色正文当成整个系统提示词，孩子丢掉标准工具用法那一套。
- **新加一个角色** = 复制一个 `.md`，改 `name`/`description`/`scope`/`write`/`bash.allow`，别在派单里手传 `extensionBindings`（那条只在单次派单或 `async: false` 的前台子里用，且会被写范围在启动瞬间锁死）。

`pi-wake` 只装在这里，没写进 `.pi/agents/*.md` 的 `subagentOnlyExtensions`：子代理是等结果返回的，自己排定时唤醒没有意义；需要定时续做的场景在主会话里。

主 agent 那一侧的技能过滤也不在本仓库：扩展装在用户目录，按 skill 文件自己的 `subagent-only: true` 标记决定隐藏谁。

```text
~/extensions/subagent-only-skills/          # 独立仓库，有自己的 HANDOFF.md
  └─ packages/pi-plugin/src/index.ts        # before_agent_start 里剔除带标记的 skill
~/.pi/agent/extensions/pi-subagent-only-skills -> 上面那个包目录（软链）
```

## 为什么不靠 SKILL.md 的 `disable-model-invocation`

pi 与 pi-subagents 都按这个字段过滤：`disable-model-invocation: true` 会让 pi-subagents 的 `buildSkillInjection` 把它一起剔掉，子代理也就拿不到了。要「主 agent 不可见、子代理可用」，只能在主 agent 那一侧拦，也就是扩展改提示词选项。

pi 的 skill 列表进提示词的路径：`loadSkills` → `systemPromptOptions.skills` → `buildSystemPromptSections` → `formatSkillsForPrompt`。扩展在 `before_agent_start` 里改的是同一个对象（pi 的 ExtensionRunner 把同一个 `currentOptions` 传给所有 handler），所以改动直接反映到本轮提示词。

## 边界

- 子代理拿技能靠 pi-subagents 把技能注入子代理提示词文本；子代理的 pi 级 skill 目录是关掉的（`noSkills: !inheritSkills`），扩展在子代理里是空操作。
- 想让别的 subagent 也用某个技能：在对应 agent 定义里加 `skills:`（+ `skillPath`），或在调用 subagent 工具时传 `skill:`。
- 人工仍可显式加载：`/skill:hello-js-reverse-skill`。
- 扩展是全局的：所有 pi 项目都加载它，是否隐藏看每个 skill 自己的标记。

## 校验

```bash
node .pi/check-subagent-only-skill.mjs
```

覆盖：pi 启动时发现技能、加载扩展、扩展剔除它、pi 渲染后的提示词不含它、pi-subagents 发现 `js-reverse` agent 并按 `skills` + `skillPath` 解析到同一个技能、技能进入子代理提示词。

本机没有 pi / pi-subagents / 扩展安装时脚本直接跳过。
