// lib/admin/service/platform-view.ts — 平台在面板上的整张卡片。
//
// 从 service.ts 上半原样搬来。平台有两处数据源（代码里的模板与表里的开放平台），
// 判定一次算齐：面板与路由看的必须是同一个答案（lib/admin/platform-state.ts）。

import { create } from "@bufbuild/protobuf";
import {
  CredentialStatusSchema,
  HeaderTemplateSchema,
  OpenPlatformSchema,
  QuotaPluginFieldSchema,
  UpstreamSchema,
} from "../../gen/agentfacade/admin/v1/admin_pb.ts";
import { breakerPanelState } from "../../upstream-breaker.ts";
import { isSimulatedClientKind } from "../../platform-catalog.ts";
import { quotaPluginOfAccount } from "../../quota-state.ts";
import { accountsOfPlatform } from "../../providers.ts";
import { listModelOverrides } from "../../model-overrides.ts";
import {
  listOpenPlatforms,
  type OpenPlatformRow,
} from "../../open-platforms.ts";
import {
  allPlatforms,
  platformOfAny,
  platformPolicies,
  type Platform,
} from "../../platforms.ts";
import { listAccounts, type AccountView } from "../accounts.ts";
import { platformAvailabilities, type PlatformAvailability } from "../platform-state.ts";
import {
  claimableAccounts,
  claimableLabel,
  upstreamAccountCount,
  upstreamBaseUrl,
  upstreamCooling,
  upstreamCredential,
  upstreamCredentialOf,
  upstreamModelCount,
  upstreamPolicy,
  upstreamQuota,
  upstreamRegion,
  upstreamState,
  upstreamStateOf,
} from "../upstreams.ts";
import { policyEnum } from "../policy.ts";
import { accountRowMessage } from "./account-view.ts";
import { quotaAnswerOf, quotaRowOfPlatform } from "./quota-view.ts";
import { modelOverrideMessage } from "./model-view.ts";
/**
 * 一个平台在面板上的样子。
 *
 * 平台有两处数据源：代码里的模板与表里的开放平台，所以这一条可能来自任意
 * 一处；它名下的账号是数据，有几个算几个 —— 一个没有就是空的账号列表。
 *
 * 平台的样子（名字、kind）由调用方给：它一次问齐了所有平台的样子，免得每个
 * 平台再查一遍库。判定也是一次算齐的：面板与路由看的必须是同一个答案
 * （lib/admin/platform-state.ts）。
 *
 * `fromRow` 是「表里有没有属于它的那一行」：有行的平台面板才能改与删。它与
 * `isOpenPlatform` 不是同一件事 —— 模拟客户端那一族有行，但地址与目录归代码，
 * 那几格在这一条上仍然是空的。
 */
function platformMessage(
  id: string,
  platform: Platform | null,
  availability: PlatformAvailability | null,
  accounts: Map<string, AccountView>,
  open: OpenPlatformRow | null,
  row: OpenPlatformRow | null,
) {
  // 表里有没有属于它的那一行：有行的平台面板才能改与删。不跟着 open 走 ——
  // 模拟客户端那一族有行，但它们不是开放平台。
  const fromRow = row !== null;
  const credential = availability ? upstreamCredentialOf(availability) : upstreamCredential(id);
  // 名下的账号行：判定那一份已经读过表了，没判定就现读。额度与账号两处都要它。
  const rows = availability ? availability.rows : accountsOfPlatform(id);
  const quota = upstreamQuota(id);
  // 冷却：路由绕开这个账号到什么时候，面板要看得见。
  const cooling = upstreamCooling(id);
  // 熔断：这个平台现在被跳过了没有。面板靠这两格画出「为什么这会儿不接」。
  // 这个平台的额度插件：判据只有一处（quotaPluginOfAccount）—— 平台行的 kind 得
  // 是通用开放平台那一族，地址要对上某家插件声明的地址。模板平台没有开放平台行
  // 可对，三格照空 —— 面板据此不显示额度区。
  //
  // 为什么不按地址单独认：地址只说这台机器是谁，不说这条链路能不能问额度 ——
  // anthropic 那一族的读侧永远返回空（lib/kinds/anthropic.ts 的 quotas: () => []），
  // 摆出额度区等于承诺一个不会到的答复。
  const quotaPlugin = quotaPluginOfAccount({ platform: id });
  const breaker = breakerPanelState(id);
  const enabled = availability ? availability.on > 0 : rows.some((row) => row.enabled);
  return create(UpstreamSchema, {
    id,
    // 平台的名字是模板里的那个（“Qoder（全球区）”）—— 账号的别名不能顶在这里：
    // 一个平台下有几个账号时，用哪个的别名都是错的。
    label: platform?.label ?? id,
    kind: platform?.kind ?? "",
    // 现在在生效的值：名下有没有开着的账号。平台自己没有开关，开关在账号上。
    enabled,
    // 名下的多个账号怎么选。策略在平台层。
    policy: upstreamPolicy(id),
    // 这个平台支持哪几个策略：面板只给它支持的那几个。
    policies: platformPolicies(id).map(policyEnum),
    // 名下有几个账号。面板用它判「策略有没有用」。
    accountCount: availability ? availability.accounts : upstreamAccountCount(id),
    // 名下有几个账号有可领的活动额度。只读快照，不给上游多打一个请求。
    claimableAccounts: claimableAccounts(rows),
    claimableLabel: claimableLabel(rows),
    // 名下有没有开着的账号 —— 跟 enabled 同一个答案，两个名字一个是给机器判
    // 断用的、一个是给面板画开关用的，别让它们各说各话。
    hasEnabledAccount: enabled,
    // 现在能不能接：额度用尽、正在登录这些面板自己拼不出来的事，后端知道。
    state: availability ? upstreamStateOf(availability) : upstreamState(id),
    modelCount: upstreamModelCount(id),
    // 凭据在账号上：这里报的是名下最好的那一份，要逐个看就在 accounts 里。
    credential: create(CredentialStatusSchema, {
      kind: credential.kind,
      status: credential.status,
      fingerprint: credential.fingerprint,
      expiresAt: BigInt(credential.expiresAt),
      remainingSec: BigInt(credential.remainingSec),
      warning: credential.warning,
      detail: credential.detail,
      generation: credential.generation,
    }),
    quota: quotaAnswerOf(quota, quotaRowOfPlatform(rows, quota)),
    // 地址：开放平台的在平台行里，模板平台的从名下一个账号的 kind 算。
    //
    // 开放平台必须报平台行里那份：平台刚建好还没加账号时，名下没有账号，
    // 从账号那一头算地址只能算出一个空串 —— 面板上编辑这样一个平台时地址框
    // 是空的，整单提交带空串，写入侧就以「得有个地址」把这一单挡掉，于是
    // 加账号之前什么都存不进去。
    baseUrl: open ? open.baseUrl : upstreamBaseUrl(id),
    region: upstreamRegion(id),
    // 模型目录：只有开放平台有这几格（模板平台是空目录）。
    // 共性表那个开关（面板上的一个勾）：模拟客户端那一族的行也有，所以照表里的
    // 那一行报，不跟着 open（open 把那一族滤掉了）。
    traitsFromCommon: row?.traitsFromCommon ?? false,
    // 额度插件三格：id 空 = 这个平台没有额度接口，面板不显示额度区、凭据里
    // 也不加插件那几段。地址匹配与路由同一个答案，面板不再自己算。
    quotaPluginId: quotaPlugin?.id ?? "",
    quotaPluginLabel: quotaPlugin?.label ?? "",
    quotaPluginFields: (quotaPlugin?.fields ?? []).map((field) =>
      create(QuotaPluginFieldSchema, {
        name: field.name,
        label: field.label,
        secret: field.secret,
      })
    ),
    // 模型目录两格：目录本身与上次拉的时刻。模板平台没有这一份目录，所以是
    // 空与 0（0 的意思是「没拉过」，不是「没有模型」）。
    models: open?.models.items ?? [],
    modelsFetchedAtMs: BigInt(open?.models.fetchedAt ?? 0),
    // 人给这些模型写的元数据：模板平台也有（目录是代码的，人写的那一层同样是
    // 人写的那一层），所以不跟着 open 走。
    modelOverrides: listModelOverrides(id).map(modelOverrideMessage),
    // 这是不是一个开放平台：表里的那一行，不是代码里的模板。
    isOpenPlatform: open !== null,
    // 表里有没有属于它的那一行：有行的平台面板才能改与删。模拟客户端那一族
    // 有行（isOpenPlatform 是 false，地址与目录归代码），所以它与上面那格
    // 分开报 —— 面板拿 isOpenPlatform 当判据时，入口就少了一整族。
    fromRow,
    // 冷却：名下最早到期的那个账号、最早能再接的时刻、机器词。
    cooldownUntilMs: BigInt(cooling.cooldownUntilMs),
    cooldownReason: cooling.cooldownReason,
    // 最早能再接的时刻：面板自己的那个（0 = 算不出来，不猜）。
    //
    // 判定那边也有一个时刻（untilMs），但那是路由用的「最早能试的时刻」：算不
    // 出来时它会给一个固定时长，而面板的契约说 0 是「算不出来」。两处的口径
    // 不一样，记在交付记录里。
    recoversAtMs: BigInt(cooling.recoversAtMs),
    // 名下账号的计数与额度恢复时刻：只给事实，文案在面板。
    enabledAccounts: cooling.enabledAccounts,
    coolingAccounts: cooling.coolingAccounts,
    exhaustedAccounts: cooling.exhaustedAccounts,
    creditsRecoverAtMs: BigInt(cooling.creditsRecoverAtMs),
    // 熔断：面板靠这两格画出「已跳过，恢复到几点」。
    breakerSkipped: breaker.tripped,
    breakerUntilMs: BigInt(breaker.untilMs ?? 0),
    accounts: (availability ? availability.rows : rows).flatMap((row) => {
      // 账号视图是外面算好的那一份：这里再读一遍凭据的话，一个平台下的每个
      // 账号都要把全部账号的凭据读一遍（面板打开一次就是 O(N²)）。
      const account = accounts.get(row.id);
      return account ? [accountRowMessage(account)] : [];
    }),
  });
}
/**
 * 平台：模板与表里的开放平台，面板看的那一层。
 *
 * 两处数据源都在列：代码里的模板与表里的开放平台（allPlatforms）。开放平台的
 * kind 已经接进注册表（lib/kinds/openai.ts），列出来不是一行接不了请求的东西。
 */
export function platformMessages() {
  // 平台的样子一次问齐（platformOfAny），别每个平台再查一遍库。
  const platforms = allPlatforms();
  const known = new Map(platforms.map((p) => [p.id, platformOfAny(p.id)]));
  // 判定也一次算齐：面板与路由看的必须是同一个答案。
  const availabilities = platformAvailabilities(platforms);
  // 账号视图也一次算齐：每个账号行自己去读凭据的话，平台一多就是 O(N²)。
  const accounts = new Map(listAccounts().map((a) => [a.id, a]));
  // 平台行：那几格（额度插件、自动拉、目录）只有开放平台有。模拟客户端那一族
  // 的行长得一样，但它们不是开放平台 —— 判别按 kind，不按「在不在代码模板里」
  // （模板名单已经空了）。
  //
  // 全部行另存一份：openRows 已经把模拟客户端滤掉了，而「有没有行」与共性表
  // 那个开关问的是表里的那一行，不分族。两件事一张 map 说不完。
  const allRows = listOpenPlatforms();
  const rowById = new Map(allRows.map((row) => [row.id, row]));
  const openRows = new Map(
    allRows.filter((row) => !isSimulatedClientKind(row.kind)).map((row) => [row.id, row]),
  );
  return platforms.flatMap((platform) => {
    const message = platformMessage(
      platform.id,
      known.get(platform.id) ?? null,
      availabilities.get(platform.id) ?? null,
      accounts,
      openRows.get(platform.id) ?? null,
      rowById.get(platform.id) ?? null,
    );
    return message ? [message] : [];
  });
}
/**
 * 一个开放平台，面板看的形状。
 *
 * 只报表里那一行：模板平台不是开放平台，它们没有这一行可报。
 */
export function openPlatformMessage(row: OpenPlatformRow) {
  return create(OpenPlatformSchema, {
    id: row.id,
    label: row.label,
    baseUrl: row.baseUrl,
    models: row.models.items,
    modelsFetchedAtMs: BigInt(row.models.fetchedAt),
    // 建的时候定下的那一类：面板靠它决定这一排平台能用哪些凭据格子、要不要
    // 显示「刷新模型目录」。
    kind: row.kind,
    // 模板原样回给面板：它能显示、也能再保存（没配就是空列表）。
    headers: row.headers.map((h) => create(HeaderTemplateSchema, { name: h.name, value: h.value })),
  });
}
