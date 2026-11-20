[English](README.md) | 中文

# AgentFacade

一个立面，十一个平台。调用方只看到一张模型清单；平台、账号、方言、冷却、配额都在立面之后。OpenAI 与 Anthropic 两种方言用同一个端口。

## 你能得到什么

- **一个 URL 接十一个平台。**
  MiniMax Code、ZCode、Qoder（国际与国内）、WorkBuddy（国内与国际）、
  TokenRhythm、SenseNova、书生·端砚、七牛云、讯飞星火。
  根路由提供一张发布的模型清单；每个平台另有自己的路由与模型名。
- **两种方言，流式与非流式都过。**
  OpenAI 的 `/v1/chat/completions` 与 Anthropic 的 `/v1/messages`
  在根路由和各平台路由都可用；工具调用与思考通道双向转换。
- **同一平台多个账号。**
  权重决定先试谁。降级平台上，当前账号失败、额度见底或进入冷却时自动换人；
  响应里写明不可用账号的恢复时间。账号花光额度不会删掉模型。
- **模拟客户端。**
  只认自家桌面客户端的平台，我们在请求指纹上与该平台客户端对齐，
  使平台愿意响应。这不是绕过认证：账号仍需合法登录与有效凭据。
- **一张发布的模型清单。**
  一个发布出去的模型名可以指向多个上游；面板显示当前由谁服务、流量怎么分。
  不能服务的上游会带着原因从清单里消失，而不是返回 404。
- **面板看所有数字。**
  每个账号的额度、积分、余额，逐条请求的用量，账号、发布模型与登录入口。
  套餐额度是周期百分比，积分是点数，余额是钱；三者不合并。
- **每日额度自动签到与领取。**
  对签到发额度的平台，启动时签到一次，之后每小时一次；同一天重复签到无效。

## 快速开始

Docker（镜像里带面板）：


```bash
docker run -d --name agentfacade \
  -p 6450:6450 \
  -v "$PWD/data:/data" \
  shaylulimo/agentfacade:latest
```

node：

```bash
mise install      # 项目期望的工具版本
pnpm install
mise run serve    # node router-proxy.ts，监听 http://localhost:6450
```

网关地址 `http://<host>:6450`，面板在 `http://<host>:6450/admin/`。
用 `<FACADE_DATA_DIR>/admin-token` 里的 token 登录，首次启动时写入。
初始没有启用的账号，先在面板的「上游」页添加一个账号再发请求。
面板持有凭据，请只放在内网或 HTTPS 之后。

服务保存的一切都在 `FACADE_DATA_DIR`：默认是 `~/.agentfacade`
（Docker 里是 `/data`），库文件名 `agentfacade.db`。
重启时保留这个目录，会话存在里面；目录丢了就得重新登录。
环境变量一律用 `FACADE_*` 前缀。

## 对接客户端

**根路由**把平台放进模型名：

```text
base url : http://<host>:6450/v1
model    : qoder-cn/glm-5.3
```

**平台路由**用平台自己的模型名，且不受根路由发布内容影响：

```text
base url : http://<host>:6450/qoder-cn/v1
model    : glm-5.3
```

两种 SDK 的 base url，各一行：

```text
OpenAI    : base_url = "http://<host>:6450/v1"
Anthropic : base_url = "http://<host>:6450"   # SDK 会补 /v1/messages
```

OpenAI 方言用 `Authorization: Bearer <key>`，Anthropic 方言用 `x-api-key: <key>`。新装实例默认不校验 key，除非部署方要求。

```bash
# OpenAI 方言
curl http://localhost:6450/v1/chat/completions \
  -H "Authorization: Bearer <key>" -H "Content-Type: application/json" \
  -d '{"model":"qoder-cn/glm-5.3","messages":[{"role":"user","content":"hi"}]}'

# Anthropic 方言
curl http://localhost:6450/v1/messages \
  -H "x-api-key: <key>" -H "Content-Type: application/json" \
  -d '{"model":"qoder-cn/glm-5.3","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'
```

`GET /v1/models` 返回根路由发布的模型；`GET /{platform}/v1/models`
返回该平台自己的目录；`GET /health` 返回各已启用平台的状态。

**默认是 OpenAI 形状**。
`?dialect=anthropic` 切成 Anthropic 形状，`?dialect=openai` 是显式默认，
其它值返回 400，不会静默换成另一种形状。
没有 query 时看请求头：带 `anthropic-version`、`anthropic-beta`，
或只带 `x-api-key` 而无 `authorization` 的，按 Anthropic 形状；
其余按 OpenAI 形状。

## 插件：让客户端模型清单自动跟上

仓库：https://github.com/yxlimo/agentfacade-extensions

安装：

```text
pi                  pi install npm:pi-agentfacade
OpenCode (2.x)      opencode.jsonc 的 plugins 里加 "opencode-agentfacade@latest"
DeepSeek Harness    dsh plugin --profile <profile> add dsh-agentfacade
```

插件做什么：启动时拉一次 `GET {gateway}/v1/models`，之后每 5 分钟一次；
只有清单有增删才重新注册并记一行日志，重排不算变化。
拉不到就保留上一份，不会把用户的模型注册成空。

它**不写 agent 自己的配置文件**（`models.json`、`opencode.jsonc`、`cordis.patch.yml` 都是用户家产），只走 agent 的运行时注册 API。provider 名固定 `agentfacade`，与用户已有的 provider 各走各的。

连到哪台网关：

- 默认 `http://127.0.0.1:6450`。
- `/agentfacade connect <host[:port]>` 写进 `~/.config/agentfacade/config.json`；也可以直接改那份 JSON。
- 环境变量优先：`FACADE_GATEWAY`，或各自的 `PI_FACADE_GATEWAY` / `OPENCODE_FACADE_GATEWAY` / `DSH_FACADE_GATEWAY`。
- 网关要密钥时：用 `FACADE_API_KEY` 或各自的 `*_FACADE_API_KEY`，或 `~/.config/agentfacade/auth.json`；面板/CLI 写入不回显密钥。
- pi 另有 `/agentfacade` 看当前网关与注册了几条模型，
  `/agentfacade probe` 是可选的探活，结果仅供参考，不是派单闸门。

**两边的联动关系：**

```text
网关：平台、账号、切换、冷却、额度、请求指纹 —— 全在立面之后，客户端看不到
            ↓  一张模型清单（/v1/models）
插件：把清单装进 pi / OpenCode / DeepSeek Harness
```

在面板里加了模型或换了主路由，客户端不用改任何配置，最多 5 分钟自己跟上。上游账号的凭据永远不出网关，客户端只拿网关自己的 key。边界很清楚：网关不认识任何客户端，插件不认识任何上游 —— 中间只有那张清单。

## 升级

旧版用 `BUDDY_*` 环境变量前缀和 `buddy.db` 库文件。
旧名字不再读取，也没有回退兼容；漏掉改名等于用空库启动。
启动新版前先改名：

```bash
mv /data/buddy.db /data/agentfacade.db
```

再把 `BUDDY_DATA_DIR` 改成 `FACADE_DATA_DIR`；非 Docker 部署把 `~/.buddy-proxy` 改成 `~/.agentfacade`。

## 文档

- [`docs/reference/`](docs/reference/) —— 架构说明、约定、部署与评审流程。
- [`CONVENTIONS.md`](CONVENTIONS.md) —— 仓库的编码约定。
