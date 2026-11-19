# pi-models-plugin

让 pi 自己从网关拿模型清单，不再靠手工跑 `helper/buddy_sync.py` 改
`~/.pi/agent/models.json`。

这是一个 pi 扩展（`package.json` 的 `pi.extensions` 指向 `index.ts`）。pi 启动时
它拉一次 `GET {gateway}/v1/models`，映射成 provider `buddy` 注册进去；pi 需要刷新
模型目录时再拉一次（`refreshModels`），所以网关改了主路由之后不用重跑脚本、
也不用重启 pi（`/buddy-models refresh` 立刻生效）。

## 装

pi 的扩展发现位置有三种，选一种：

```bash
# 只在这一次启动里用（验证最快，不写入任何配置）
pi -e /path/to/buddy-proxy/tools/pi-models-plugin --list-models

# 装成常驻：软链到 pi 的扩展目录
ln -s /path/to/buddy-proxy/tools/pi-models-plugin ~/.pi/agent/extensions/pi-models-plugin

# 或者交给 pi 记进 settings.json（见下面的坑）
pi install /path/to/buddy-proxy/tools/pi-models-plugin
```

**坑：`pi install` 在「settings 由外部管理」的机器上会被回滚。** 若 pi 是被
home-manager / nix 之类的 wrapper 启动的，那个 wrapper 通常每次启动都会拿一份
生成的 settings 去覆盖 `~/.pi/agent/settings.json`（数组是整段替换，不是合并），
于是 `pi install` 写进去的条目下次启动就没了 —— 现象是「今天好使，重启静默失效」。
这种机器用软链，别用 `pi install`。

注意 pi 不扫当前目录，在仓库里直接跑 `pi` 不会加载它。
## 网关地址从哪来

四级，前三级与 `helper/common.py` 的 `resolve_gateway()` 一致，第四级是本插件为了让
它能开箱用而加的：

1. `PI_BUDDY_GATEWAY`
2. `FACADE_GATEWAY`
3. `~/.config/buddy-helper/config.json` 的 `gateway` 字段
4. `http://127.0.0.1:6450` —— 本插件自己的兜底（网关一般就跑在本机）。

```json
{ "gateway": "http://gateway.example:6450" }
```

前三级都没有时就用第四级，插件开箱能用。只试这一个地址，不做局域网扫描：扫描要花时间
且没把握，而扩展工厂在 pi 的启动路径上被 await。`helper/buddy_sync.py` 没有这级兜底
（不给地址直接报错退出），所以「脚本能跑」并不代表「地址配好了」——反过来说也一样。

默认值连不上就打一行警告（带地址）、不注册 provider，models.json 那条继续生效。
环境变量或配置文件里的地址写错成非 http(s) 也**不注册**、直接报错 —— 拿去请求只会得到
一句看不懂的 `fetch failed`，不如当场说清楚。

## 与 models.json、与脚本的关系

`helper/buddy_sync.py` 仍然负责 opencode 那两份配置，也仍然能写
`~/.pi/agent/models.json`。两者同时在时**插件赢**（2026-11-19 实测：同一个 provider
名 `buddy` 既在 `models.json` 又在 legacy 形式的 `registerProvider` 里时，模型清单
与 `baseUrl` 都取插件的值，`models.json` 那条整条不生效）。

所以不需要手动删 `models.json` 里的 `buddy` 条目。留着它反而有用：网关拉不到时本
插件**不注册**，pi 就继续用那份旧清单，会话照常能开。

拉不到、拉回来是空清单、或者网关答的不是 JSON —— 都只留一行警告，不注册，
**绝不注册一个空的 models 列表**：legacy 形式的 `models` 是替换语义，注册空数组
会把用户已有的模型清空。

## 字段映射（与 `buddy_sync.pi_provider()` 逐字一致）

| pi | 网关 |
| --- | --- |
| `baseUrl` | 网关根地址（pi 走 Anthropic 方言，自己拼 `/v1/messages`） |
| `api` | 固定 `anthropic-messages` |
| `apiKey` | 固定 `public`（网关跑 public 模式时不校验） |
| `compat` | `forceAdaptiveThinking` + `sendSessionAffinityHeaders` 都开 |
| `models[].id` / `name` | `id` / `display_name`（缺了用 `id`） |
| `models[].reasoning` | `reasoning`，缺了按 `true`（不知道不等于不支持） |
| `models[].input` | 固定 `["text","image"]` |
| `models[].contextWindow` | `context_window`，缺了 200000 |
| `models[].maxTokens` | `max_output_tokens`，缺了 4096 |
| `models[].thinkingLevelMap` | `effort_options` 按 `level_map()` 的规则（往下取，不往上取；只有 `off` 的模型每一格都是 `off`） |
| `models[].cost` | 固定全 0（网关不报价），**每条都要有**，见下一节 |
| `models[].compat` | 固定两项都开，**每条都要有**，见下一节 |

两条路算出来的东西必须一样，否则「靠插件」和「靠脚本」的思考档位会对不上。
测试拿 `buddy_sync.pi_provider()` 的输出当期望值钉住这件事。

**已知的照抄行为**：网关报的档位里出现 `default`（pi 没有这一档）时，它排在已知
档位之后，于是 pi 的 `max` 会映到 `default`（录制里的 `model-02` 就是这样）。这不是
插件的选择，是脚本现在就这么算的 —— 要改得两边一起改。

## `cost` 与 `compat` 为什么写在每条模型上

不是啰嗦：pi 对两条注册路的归一化程度不一样（1.5.2，`dist/core/provider-composer.js`）。

- `models.json` 那一路：`modelFromJson()` 补 `cost` 默认值，`applyModelsJson()` 再用
  `mergeCompat` 把 provider 级 `compat` 并进每条模型。
- 扩展注册那一路：`extensionModelFromDefinition()` 只是把定义展开，provider 级的
  `cost`/`compat` 一个都不下发。

同一个 provider 名一旦被插件接管，models.json 那份就整条不生效了 —— 于是「靠 pi 补上」
这条路也没了。缺了会怎样（都在 pi 1.5.2 上实测）：

| 缺什么 | 现象 |
| --- | --- |
| `cost` | 请求在第一个 SSE 事件上抛 `Cannot read properties of undefined (reading 'tiers')`（`calculateCost` 读 `model.cost.tiers`），每次请求必炸 |
| `compat.sendSessionAffinityHeaders` | 不发 `x-session-id`，网关认不出会话：`502 upstream HTTP 400 MissingSessionID` |
| `compat.forceAdaptiveThinking` | pi 不发 `output_config.effort`，改发 `thinking.budget_tokens` —— 上面那张 `thinkingLevelMap` 整条被绕过 |

所以 `pi_provider()` 与 `toPiModel()` 都给每条模型写上这两格（`cost` 全 0 = 不计价，
与 pi 自己补的默认值相同）。parity 用例把它们也纳入逐字比对：删掉任一条就会红。

## 命令

```
/buddy-models          当前注册了几条模型、来自哪个网关、最后一次刷新时间
/buddy-models refresh  立刻重拉一次，并替换已注册的清单
```

启动时网关不可达（`/buddy-models` 会显示 `NOT registered`）也不要紧：网关起来之后
跑一次 `/buddy-models refresh`，provider 就补注册上了。

## 超时与启动开销

所有请求带超时：默认 1500ms（`DEFAULT_TIMEOUT_MS`），失败就放弃本次注册。pi 的扩展
工厂是 async 且被启动路径 await，所以这个数字直接等于「网关挂掉时 pi 多等多久」。
实测（本机，pi 启动基线 1352ms）：

| 情况 | 墙钟 | 结果 |
| --- | --- | --- |
| 网关可达 | 1573ms | 注册 17 条 |
| 网关不可达（关着的端口） | 1347ms | 不注册，退回 models.json 那 16 条 |
| 网关黑洞（不回包） | 1500ms 后放弃 | 不注册 |

不可达那两行分别走两条路：连接被拒是立即返回的（不等超时），只有「连得上但不回话」才
会吃满 1500ms。所以最坏情况是 pi 启动多等 1.5 秒，正常情况几乎不增加开销。

## 测

```bash
mise run test:pi-models
```

离线：假网关是 `test/fake-upstream.ts` 起的 127.0.0.1 随机端口，响应是
`fixtures/gateway-v1-models.json`（2026-11-19 从真网关录的一次 `/v1/models`，**id 与
显示名已换成合成的 `model-NN`/`Model NN`**：真实目录属于内部信息，而这个公开仓库只需要
那 17 条的**形状** —— `off` 单独一档、四档齐全但夹着 `default`/`none`、`midium` 这种
拼错的档位、只有 `off` 的模型，这些组合才是映射逻辑要覆盖的东西）。
`fixtures/expected-provider-config.json` 是 `buddy_sync.pi_provider()` 对同一份录制
算出来的期望配置，parity 用例逐字比对 —— 所以录制里那两条 `cost`/`compat` 也在比对范围内，
删掉任何一条 parity 就红。

重新录 / 重新生成期望值（需要网关可达；期望值那份要 Python）：

```bash
curl -s {gateway}/v1/models | python3 -m json.tool > tools/pi-models-plugin/fixtures/gateway-v1-models.json
python3 - <<'PY'
import json, sys
sys.path.insert(0, "helper")
import buddy_sync as bs

raw = json.load(open("tools/pi-models-plugin/fixtures/gateway-v1-models.json"))
models = []
for m in raw.get("data", []):
    mid = m.get("id") or ""
    if not mid:
        continue
    efforts = m.get("effort_options")
    if not isinstance(efforts, list) or not efforts:
        efforts = None
    reasoning = m.get("reasoning")
    if not isinstance(reasoning, bool):
        reasoning = None
    models.append((mid, m.get("display_name") or mid, efforts,
                   int(m.get("context_window") or 200000),
                   int(m.get("max_output_tokens") or 4096), reasoning))

bs.GATEWAY = "http://gateway.example:6450"
bs.API_KEY = "public"
print(json.dumps(bs.pi_provider(models, "", "Buddy (main route)"), ensure_ascii=False, indent=2))
PY
```

录制里不要带真实地址、凭据或会话 —— 这份文件是公开仓库的一部分。
