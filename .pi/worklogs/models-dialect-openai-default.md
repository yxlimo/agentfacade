# /v1/models 的默认形状翻成 OpenAI

## 任务

`GET /v1/models` 的默认形状从 Anthropic 翻成 OpenAI；Anthropic 形状要显式
`?dialect=anthropic`（或按请求头判）。两种形状里「规范之外的字段」向
opencode-go 靠拢：`created` 稳定下来，Anthropic 的 `created_at` 变成 RFC 3339
字符串、`capabilities` 发 `null`，OpenAI 补 `limit` / `capabilities` /
`modalities` / `cost`。

## 做了什么

1. **形状翻转**（`lib/router/catalog-routes.ts`）
   - `?dialect=openai` / `?dialect=anthropic` 各自生效；别的一律 400
     （不静默回落成另一种形状）。
   - 没有 query 时看请求头：`anthropic-version` / `anthropic-beta` 在 →
     anthropic；`x-api-key` 在且没有 `authorization` → anthropic；其余
     openai。判据只写在一处（`dialectOf`），注释里写了为什么这样判。

2. **条目的形状搬到一个新模块**（`lib/router/catalog-entry.ts`）
   - `openAIEntry` / `anthropicEntry` / `costOf` / `createdOf` 都在那里。
   - `lib/router/catalog.ts` 只剩「有哪些模型」那一层（原来会把文件推过
     400 行）。

3. **`created` / `created_at` 稳定**
   - 取该模型所属平台的目录抓取时刻（`platform.models.fetchedAt`）；拿不到
     就用**进程启动时刻**。绝不逐请求取 `Date.now()`。

4. **Anthropic 形状**
   - `created_at` 是 RFC 3339 字符串（`new Date(秒*1000).toISOString()`）。
   - `capabilities: null`：规范里那是 `ModelCapabilities | null`，里面每个
     键都是 required，我们只知道一部分，发半份对象会让强类型 SDK 校验失败；
     `{supported:false}` 也不对（那是把「不知道」写成「没有」）。

5. **OpenAI 形状向 opencode-go 靠拢**
   - `limit`（context / output）、`capabilities`（tools / reasoning + effort）、
     `modalities`、`cost`（`cost.text.input.price` / `cost.text.output.price` /
     `cost.text.input.cache.read`）。
   - 只在知道时才发：不知道就整个键不出现，绝不发 `0` / `false` / 空数组。
   - `cost` 不发 multipliers：我们只留了 `factor`、丢了 `when` 条件，发一半
     是说谎（注释里写明了）。

6. **模态是新解析的**（`lib/open-platform-catalog.ts` + `lib/open-platforms.ts`
   + `lib/catalog-models.ts`）
   - 上游报 `modalities.input` / `modalities.output` 才解析；没报的平台没有
     这一格。

## 踩到的坑

- **默认形状翻了以后，`test/e2e.sh` 的 metadata 那条用例红了**：它按
  Anthropic 形状读 `max_output_tokens` / `context_window`，新默认里这两个数
  在 `limit` 下面。改成两种形状都验（默认查 `limit`，`?dialect=anthropic`
  查平铺字段），语义没削弱。
- **`test/smoke.sh` 在失败时 `tail` 一个不存在的日志**，又多一条报错，把现场
  搞成一团。加了兜底（打印「(router 日志不存在)」），退出码不动。
- **另外两处按 Anthropic 形状读字段的测试**：`test/catalog-parity-check.ts`
  与 `test/sensenova-intern-ai-check.ts` 改成显式 `?dialect=anthropic`，
  断言强度不变（只是换了个取形状的方式）。
- **`lib/router/catalog.ts` 一度涨到 472 行**，过了仓库的 400 行线：把条目
  形状那部分搬进 `lib/router/catalog-entry.ts`。

## 验证

- 新测试 `test/models-dialect-check.ts`：46 项全过。
  反证：把默认形状临时改回 anthropic → 7 项真红（`object: list` 那几条、
  `created` 那几条、根路由默认形状那条），改回来又全绿。
- `mise run typecheck`：过。
- `mise run check:routing`（80s）、`mise run check:admin`（42s）、
  `mise run check:misc`（20s）：全过。
- `mise run test`：全量三轮全过（exit=0）。
- `mise run privacy`：0 命中。

## 未决

- `buddy_sync`（`helper/buddy_sync.py`）按 Anthropic 形状读 `/v1/models`
  （`display_name` / `context_window` / `effort_options`）。默认形状翻了以后
  它读到的字段会少一截 —— 任务里明说不要动这个脚本（用户在用插件替代它），
  所以这里只记下来：插件接上之前，它写进客户端配置的那几格可能不准。
