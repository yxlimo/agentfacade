// lib/kinds/openai.ts — 开放平台（用户自己加的平台）是什么，写成一段声明。
//
// 开放平台不是代码里的平台，是用户在面板上加的一行：地址、key、模型目录都在
// 表里（lib/open-platforms.ts）。所以这一类上游没有自己的传输层 —— 请求是
// OpenAI 形状原样过去，答案原样回来，鉴权是一把 API key 作 Bearer，与别的
// 开放平台完全一样（lib/router/openai-platform.ts）。
//
// 这一段声明只回答三件事：地址从哪来、key 从哪来、目录里有哪些模型。
//
// 额度是开放平台唯一自己给不出来的东西：它是数据，不是代码，所以额度插件按
// 平台行的地址认（lib/quota-plugin-registry.ts 的 quotaPluginForBaseUrl），插件
// 回答「怎么问」与「怎么读」。对不上插件、快照里没有这个账号的那一份 —— 两种
// 都是「不知道」，而「不知道」跟 0 不是一回事。

import { tokenFingerprint } from "../credential.ts";
import { declareNoLoginFlow } from "../login-flow.ts";
import { openPlatformKeyOf } from "../open-platform-credentials.ts";
// 开放平台的 kind 名字住在 lib/open-platforms.ts（那一层不引 lib/platforms.ts）。
// 从那里取而不是从 lib/platforms.ts 转出来：环上的模块不能在求值期读别人的
// 常量，转出来等于把环用回来了，现在能跑只靠依赖求值顺序。
import { openPlatformOf, OPEN_PLATFORM_KIND_NAME } from "../open-platforms.ts";
// 引用即登记：开放平台按地址认插件，认的是登记表（lib/quota-plugin-registry.ts
// 的 map）。登记的副作用集中在 hub（lib/quota-plugins.ts）：以前靠各家插件文件
// 反向 import 额度端点函数被顺带加载，那函数退场后没人拉它了 —— 不在这里引
// 一把，登记表在只走 kind 链的进程里是空的，按地址解析认不出任何插件。
import "../quota-plugins.ts";
import { fromUpstreamStatus } from "../provider-kinds.ts";
import { openPlatformPlan } from "./shared.ts";
import { outOfCreditsOf, quotaPluginIdOf, quotaViewsOf, recoverAtOf } from "../quota-state.ts";
import { registerCompatiblePlatform } from "../router/compatible-platform.ts";
import { catalogModelsFromRow, type CatalogModel } from "../catalog-models.ts";
import type { ProviderRow } from "../providers.ts";

/**
 * 这个平台的模型目录。
 *
 * 目录是**平台**的，不是账号的：同一个平台下两个账号服务同一批模型。所以目录
 * 从平台那一行取，账号只决定谁来付钱。
 *
 * 这一类没有代码里的目录表，所以只给名字：上游没报上下文长度与能力，那几项就
 * 不写 —— 填一个猜的数等于对客户端撒谎（客户端会拿它当承诺）。行读不到时就
 * 是空数组：这一层本来就没有可退回的代码目录（不猜）。
 */
function openPlatformCatalogModels(provider: ProviderRow): CatalogModel[] {
  return catalogModelsFromRow(provider, () => []);
}

/**
 * 面板上看到的凭据状态。
 *
 * 干活的是那把 key：没有它，一个请求也发不出去。所以状态只看它。
 */
function openPlatformStatus(provider: ProviderRow): Record<string, unknown> {
  const key = openPlatformKeyOf(provider.id);
  return {
    status: key ? "usable" : "missing",
    fingerprint: key ? tokenFingerprint(key.apiKey) : "",
    expiresAt: "",
    remainingSec: 0,
    warning: false,
    detail: key ? "有推理用的 API key" : "账号上没有推理用的 API key",
  };
}

export const openaiKind = registerCompatiblePlatform({
  kind: OPEN_PLATFORM_KIND_NAME,
  label: "开放平台（OpenAI 兼容）",
  // 面板上填一把 key 就行：没有登录这一说。
  login: "api_key",
  // 那一把 key 既是推理凭据，也是这个账号唯一的凭据。
  inferWith: "api_key",
  // 凭据形状与 Anthropic 那个方言的一模一样：一把推理 key，加上平台所选额度
  // 插件要的那几段。
  credentials: openPlatformPlan(),
  // 地址是表里那一行的。拿不到时返回空串，不抛：抛出去会让「平台列表」这类
  // 只读路径也炸。地址为空的话转发层只会看到一个笼统的上游错误（fetch 一个
  // 空地址会 TypeError，转发层把它当成上游 5xx），所以空地址在写入侧就被
  // checkBaseUrl 挡住了（lib/open-platforms.ts）。
  baseUrl: (provider) => openPlatformOf(provider.platform)?.baseUrl ?? "",
  // The key is per account: the policy picks the account, the account has the key.
  keyOf: (provider, accountId) => openPlatformKeyOf(accountId ?? provider.id)?.apiKey ?? "",
  // 目录那一个端点收 Bearer，与推理一样。
  catalogAuth: (key) => ({ Authorization: `Bearer ${key}` }),
  credential: (provider) => fromUpstreamStatus(openPlatformStatus(provider), "api_key"),
  models: openPlatformCatalogModels,
  // 没有插件、或者快照里没有这个账号的那一份：额度是「未知」。空数组不是 0 ——
  // 0 说的是「一点不剩」，那是在替一个根本没问过的平台撒谎。
  quotas: (provider, snapshot) => quotaViewsOf(provider, snapshot, quotaPluginIdOf(provider)),
  // 不知道就不该断路：问不到的平台还是能接请求的平台。
  outOfCredits: (provider, snapshot) => outOfCreditsOf(provider, snapshot, quotaPluginIdOf(provider)),
  // 没人知道它什么时候回来：null，不猜。
  recoverAt: (provider, snapshot) => recoverAtOf(provider, snapshot, quotaPluginIdOf(provider)),
});

// 只有一把 API Key：没有会话，也没有额度接口要登。
declareNoLoginFlow(OPEN_PLATFORM_KIND_NAME, "开放平台用 API Key，没有会话登录");
