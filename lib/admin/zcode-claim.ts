// lib/admin/zcode-claim.ts — 面板点一次「领取」的管理端那一半。
//
// 这一层只做一件事：把契约里的形状与 lib/zcode/claim-manual.ts 的结论
// 对上。判断（有没有可领、领没领成、上游说了什么）都在 lib/zcode/ 里，
// 这里不重做 —— 两处各判一次的话，面板会看到两个打架的结论。
//
// 两条 RPC：
//
//   GetZcodeClaimStatus  此刻有什么可领的（投放里的 campaign + plan），
//                        外加上游的验证码配置（面板靠它初始化阿里云 SDK）。
//   ClaimZcodePlan       领一个。浏览器把跑出来的无感校验结果交回来，
//                        网关带着它去领。

import { create } from "@bufbuild/protobuf";
import {
  ClaimZcodePlanResponseSchema,
  GetZcodeClaimStatusResponseSchema,
  ZcodeClaimOfferSchema,
  ZcodeClaimOutcome,
  type ClaimZcodePlanResponse,
  type GetZcodeClaimStatusResponse,
} from "../gen/agentfacade/admin/v1/admin_pb.ts";
import { provider } from "../providers.ts";
import {
  claimZcodePlanManually,
  claimedOkKeys,
  fetchCaptchaConfig,
  type ZcodeManualClaimOutcome,
} from "../zcode/claim-manual.ts";
import { fetchTouch, offerKey } from "../zcode/marketing.ts";

/** 账号 id → 它的平台 id（不是 zcode 的账号给空串）。 */
function platformOf(accountId: string): string {
  const row = provider(accountId);
  if (!row || row.kind !== "zcode") return "";
  return row.platform;
}

/** 这个账号是不是一个 zcode 账号（别的种类的账号没有活动额度可领）。 */
function isZcodeAccount(accountId: string): boolean {
  return platformOf(accountId) !== "";
}

/** 结论 → 契约里的枚举。 */
function outcomeEnum(outcome: ZcodeManualClaimOutcome): ZcodeClaimOutcome {
  switch (outcome) {
    case "claimed":
      return ZcodeClaimOutcome.CLAIMED;
    case "already":
      return ZcodeClaimOutcome.ALREADY;
    case "captcha_rejected":
      return ZcodeClaimOutcome.CAPTCHA_REJECTED;
    case "no_offer":
      return ZcodeClaimOutcome.NO_OFFER;
    default:
      return ZcodeClaimOutcome.FAILED;
  }
}

/**
 * 此刻的可领状态：可领的投放 + 验证码配置。
 *
 * 两样都要：投放那一头告诉面板「有哪些 plan 可以领」（plan_id 与 campaign_id
 * 是领的时候要带的），验证码配置那一头告诉面板「能不能跑无感校验」——
 * 配置拿不到时前端**不该**显示领取按钮（那不是「不需要验证码」，是「不知道」）。
 */
export async function getZcodeClaimStatus(
  accountId: string,
): Promise<GetZcodeClaimStatusResponse> {
  if (!isZcodeAccount(accountId)) {
    return create(GetZcodeClaimStatusResponseSchema, {
      ok: false,
      message: "这个账号不是 zcode 账号，没有活动额度可领",
      captcha: { present: false, enabled: false, sceneId: "", prefix: "", region: "" },
      offers: [],
      captchaAvailable: false,
    });
  }
  const config = await fetchCaptchaConfig(accountId);
  if (config.state !== "ok") {
    return create(GetZcodeClaimStatusResponseSchema, {
      ok: false,
      message:
        config.state === "missing"
          ? "本地没有会话（这个账号没登录）"
          : config.state === "unauthorized"
            ? config.message
            : config.message,
      captcha: { present: false, enabled: false, sceneId: "", prefix: "", region: "" },
      offers: [],
      captchaAvailable: false,
    });
  }
  // 投放：有没有可领的由它说了算（不是 billing/preview）。
  const touch = await fetchTouch(accountId);
  if (touch.state !== "ok") {
    return create(GetZcodeClaimStatusResponseSchema, {
      ok: false,
      message:
        touch.state === "missing"
          ? "本地没有会话"
          : touch.state === "unauthorized"
            ? touch.message
            : `问不到投放：${touch.message}`,
      captcha: {
        present: config.config.present,
        enabled: config.config.enabled,
        sceneId: config.config.sceneId,
        prefix: config.config.prefix,
        region: config.config.region,
      },
      offers: [],
      captchaAvailable: false,
    });
  }
  const captchaAvailable =
    config.config.present && config.config.enabled && config.config.sceneId !== "";
  return create(GetZcodeClaimStatusResponseSchema, {
    ok: true,
    // captchaAvailable 为 false 时说清楚为什么：面板据此**不显示**领取按钮。
    // 「上游没给验证码配置」与「上游说这次不要验证码」是两件事，都不是
    // 「可以领」—— 面板不能把它们当成可领（那只是安静地不做事）。
    message: captchaAvailable
      ? ""
      : config.config.present
        ? "上游说这次不要验证码：这一路领不了"
        : "上游没有下发验证码配置：这一路领不了",
    captcha: {
      present: config.config.present,
      enabled: config.config.enabled,
      sceneId: config.config.sceneId,
      prefix: config.config.prefix,
      region: config.config.region,
    },
    offers: touch.offers.map((offer) =>
      create(ZcodeClaimOfferSchema, {
        campaignId: offer.campaignId,
        planId: offer.planId,
        name: offer.name ?? "",
        priority: offer.priority,
        alreadyClaimed: claimedOkKeys(accountId).includes(offerKey(offer)),
      }),
    ),
    // 配置齐了（present && enabled && scene_id）面板才能初始化 SDK 并跑出
    // 一次无感校验；缺一样就老老实实说不行，面板据此不显示按钮。
    captchaAvailable,
  });
}

/**
 * 领一个投放里的套餐。
 *
 * 浏览器那边跑出来的无感校验结果（captcha_verify_param）是**一次性**的：
 * 带着它打一次上游，用完就没了（上游会核销）。所以这里不缓存它，也绝不
 * 写进日志（日志只留它的长度）。
 */
export async function claimZcodePlan(request: {
  accountId: string;
  planId: string;
  campaignId: string;
  captchaVerifyParam: string;
  captchaRegion?: string;
}): Promise<ClaimZcodePlanResponse> {
  const accountId = String(request.accountId ?? "").trim();
  const platformId = platformOf(accountId);
  if (!platformId) {
    return create(ClaimZcodePlanResponseSchema, {
      ok: false,
      message: "这个账号不是 zcode 账号，没有活动额度可领",
      outcome: ZcodeClaimOutcome.FAILED,
      code: 0,
      upstreamMessage: "",
      planId: String(request.planId ?? ""),
      campaignId: String(request.campaignId ?? ""),
      planName: "",
      effectiveAtMs: BigInt(0),
    });
  }
  const result = await claimZcodePlanManually(accountId, {
    planId: String(request.planId ?? ""),
    campaignId: String(request.campaignId ?? ""),
    captchaVerifyParam: String(request.captchaVerifyParam ?? ""),
    captchaRegion: request.captchaRegion,
  });
  // 留痕与快照的写在 lib/zcode/claim-manual.ts 那一层（领是一次**上游写
  // 操作**，无论谁触发它都要留痕、都要让面板看得见）。这一层只负责把结论
  // 摆成契约里的形状。
  return create(ClaimZcodePlanResponseSchema, {
    ok: result.outcome === "claimed",
    message: result.message,
    outcome: outcomeEnum(result.outcome),
    code: result.code ?? 0,
    upstreamMessage: result.upstreamMessage,
    planId: String(request.planId ?? ""),
    campaignId: String(request.campaignId ?? ""),
    planName: result.planName ?? "",
    effectiveAtMs: result.effectiveAt ? BigInt(Date.parse(result.effectiveAt)) : BigInt(0),
  });
}

/** 幂等键（与 lib/zcode/marketing.ts 同一份）。导出给测试用。 */
export { offerKey };
