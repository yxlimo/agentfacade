// lib/zcode/claim-manual.ts — 面板点一次「领取」的那条路。
//
// 与 lib/zcode/auto-claim.ts 是两件事：那边是定时器自己领（网关过不了阿里云
// 验证码，恒定落在 captcha 那一档），这边是人点的 —— 浏览器里跑一次无感
// 校验，把结果交回来，网关带着它去领。
//
// 这一条路上有三件事与定时那条不同：
//
//   1. 验证码由**浏览器**出。阿里云那个 SDK 要 DOM（画布、WebGL、字体、
//      事件模型），只有真浏览器跑得出来 —— 面板正好跑在浏览器里，于是
//      「缺 DOM」这件事由前端解决，网关只负责把结果原样带给上游。
//   2. 领之前要确认**此刻还有这个投放**。「有没有可领」由 marketing/touch
//      说了算（不是 billing/preview），所以这里先问一次投放；plan_id 不在
//      当前的投放里，就一个领取请求都不发（no_offer）。
//   3. 幂等靠 campaign_id + plan_id。同一个投放领过了就不再发一次 —— 上游
//      的投放会一直挂着（它不会说「这个已经领过了」），照着它 POST 就是
//      一天几十次重复写。
//
// 结论的语义照 lib/zcode/claim.ts 现有的 ZcodeClaimResult：
//   claimed          领到了（上游 code 0 且 data.plan 在）
//   already          上游说不能再领（终态码那一组）
//   captcha_rejected 上游把验证码判成无效（业务码 3007）
//   no_offer         当前的投放里没有这个 plan_id（请求都没发）
//   failed           问到了但没领成（网络、上游 5xx、其它业务码）
//
// 上游的业务码与 data.message 原样带回去：那一套映射是猜的，而猜错的话
// 面板会说错原因 —— 让面板念上游的原话。

import { log } from "../log.ts";
import { configNumber } from "../config.ts";
import { scrubForLog } from "../log-scrub.ts";
import { provider } from "../providers.ts";
import { ZCODE_BASE, loadSession } from "./auth.ts";
import { claimPlan, type ZcodeClaimResult } from "./claim.ts";
import { recordClaimSnapshot } from "./auto-claim.ts";
import { zcodeQuota } from "./credits.ts";
import { fetchTouch, offerKey } from "./marketing.ts";
import {
  ZCODE_CLAIM_APP_VERSION,
  ZCODE_CLIENT_PLATFORM,
  zcodePlatformApiHeaders,
} from "./transport.ts";
import { peekHealthSnapshot } from "../health-cache.ts";
import type { HealthSnapshot } from "../provider-kinds.ts";

/** 问一轮就收手（毫秒）。 */
const MANUAL_CLAIM_TIMEOUT_MS = configNumber("ZCODE_MANUAL_CLAIM_TIMEOUT_MS", 20_000);

/** 客户端配置接口的路径（验证码配置从那里来）。 */
const CLIENT_CONFIGS_PATH = "/api/v1/client/configs";

/* ------------------------------------------------------------------ *
 * 验证码配置
 * ------------------------------------------------------------------ */

/** 上游下发的验证码配置。 */
export interface ZcodeCaptchaConfig {
  /** 上游给了这一段配置没有。 */
  present: boolean;
  /** 上游说这次要不要验证码。 */
  enabled: boolean;
  /** 场景 id（阿里云 SDK 的 SceneId）。 */
  sceneId: string;
  /** 前缀（SDK 的 prefix）。 */
  prefix: string;
  /** 地域（SDK 的 region）。上游没给就是空串。 */
  region: string;
}

/** 拿验证码配置的结论。 */
export type ZcodeCaptchaConfigResult =
  | { state: "ok"; at: number; config: ZcodeCaptchaConfig }
  /** 本地没有会话，压根没问。 */
  | { state: "missing"; at: number }
  /** 上游拒了这把凭据。 */
  | { state: "unauthorized"; at: number; message: string }
  /** 问不到（网络、上游错误、答复不是 JSON）。 */
  | { state: "failed"; at: number; message: string };

/**
 * 读上游的客户端配置，取出 captcha 那一段。
 *
 * 面板要靠它初始化阿里云的验证码 SDK（SceneId / prefix / region），
 * 所以这一段要**原样**带到面板那边去 —— 上游给什么就是什么，网关不改写。
 *
 * 配置读不到与「配置里没有 captcha」是两件事：前者是问不到（面板不该
 * 显示按钮，那是「不知道」），后者是上游说这次不要验证码。
 */
export async function fetchCaptchaConfig(
  providerId: string,
): Promise<ZcodeCaptchaConfigResult> {
  const session = loadSession(providerId);
  if (!session) return { state: "missing", at: Date.now() };
  const url =
    `${ZCODE_BASE}${CLIENT_CONFIGS_PATH}` +
    `?app_version=${encodeURIComponent(ZCODE_CLAIM_APP_VERSION)}` +
    `&platform=${encodeURIComponent(ZCODE_CLIENT_PLATFORM)}`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        ...zcodePlatformApiHeaders(session),
        accept: "application/json",
      },
      signal: AbortSignal.timeout(MANUAL_CLAIM_TIMEOUT_MS),
    });
  } catch (e) {
    return {
      state: "failed",
      at: Date.now(),
      message: `问不到客户端配置：${(e as Error)?.message ?? String(e)}`,
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      state: "unauthorized",
      at: Date.now(),
      message: `上游拒绝了这把令牌（HTTP ${response.status}）`,
    };
  }
  if (!response.ok) {
    return { state: "failed", at: Date.now(), message: `上游答了 HTTP ${response.status}` };
  }
  const body: any = await response.json().catch(() => null);
  if (!body) return { state: "failed", at: Date.now(), message: "上游的答复不是 JSON" };
  if (body?.code !== undefined && body?.code !== null && Number(body.code) !== 0) {
    return {
      state: "failed",
      at: Date.now(),
      message: `上游报了业务错误 ${body?.code ?? "?"}：${String(body?.msg ?? "")}`,
    };
  }
  // configs.captcha 那一段。上游的键名大小写混着（sceneId / skip_model_request），
  // 两个写法都认。
  const captcha = body?.data?.configs?.captcha;
  if (!captcha || typeof captcha !== "object") {
    return {
      state: "ok",
      at: Date.now(),
      config: { present: false, enabled: false, sceneId: "", prefix: "", region: "" },
    };
  }
  return {
    state: "ok",
    at: Date.now(),
    config: {
      present: true,
      // enabled 缺省时当真（上游明说 enabled:false 才是「不要」）。
      enabled: captcha.enabled !== false,
      sceneId: String(captcha.sceneId ?? captcha.scene_id ?? ""),
      prefix: String(captcha.prefix ?? ""),
      region: String(captcha.region ?? ""),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 领取
 * ------------------------------------------------------------------ */

/** 手动领取的结论（面板看的那几格）。 */
export type ZcodeManualClaimOutcome =
  /** 领到了。 */
  | "claimed"
  /** 已经领过了（上游说不能再领，或同一个投放之前领成过）。 */
  | "already"
  /** 上游把验证码判成无效（业务码 3007）。 */
  | "captcha_rejected"
  /** 此刻没有这个可领的投放：一个领取请求都没发。 */
  | "no_offer"
  /** 问到了但没领成。 */
  | "failed";

/** 手动领取的答复。 */
export interface ZcodeManualClaimResult {
  outcome: ZcodeManualClaimOutcome;
  /** 上游的业务码（没有就 null）。 */
  code: number | null;
  /** 上游的原话（data.message，没有就空串）。 */
  upstreamMessage: string;
  /** 给面板看的一句话（本地的话，不冒充上游）。 */
  message: string;
  /** 领到的计划名（只有领到时才有）。 */
  planName?: string;
  /** 领到的计划什么时候开始算数（ISO）。 */
  effectiveAt?: string;
  /** 这次花了多久（毫秒）。 */
  durationMs: number;
}

/** 输入。 */
export interface ZcodeManualClaimInput {
  /** 要领的 plan_id。 */
  planId: string;
  /** 投放里的 campaign_id（幂等与留痕用）。 */
  campaignId: string;
  /** 浏览器里跑出来的阿里云无感校验结果（一次性）。 */
  captchaVerifyParam: string;
  /** 阿里云验证码的地域（可选：上游配置里有 region 才带）。 */
  captchaRegion?: string;
}

/**
 * 这个账号已经领成的投放（`campaign_id|plan_id`）。
 *
 * 只记**领成过**的：定时那条路把「要人工过验证码」也记成不再重试，那是它
 * 自己的记忆（那边永远过不了验证码，记着免得每天白问几十次）。手动这条
 * 路要问的是「这个投放是不是已经领到了」—— 两件事分开记，混起来会让手动
 * 领取被定时那条路的失败记忆挡住。
 */
const claimedOk = new Map<string, Set<string>>();

/** 领成的记忆（按账号）。 */
function claimedOkOf(providerId: string): Set<string> {
  let set = claimedOk.get(providerId);
  if (!set) {
    set = new Set<string>();
    claimedOk.set(providerId, set);
  }
  return set;
}

/**
 * 这个账号已经领成的投放（`campaign_id|plan_id`）。
 *
 * 面板拿它标出「这个已经领过了」（按钮不亮）。
 */
export function claimedOkKeys(providerId: string): string[] {
  return Array.from(claimedOkOf(providerId));
}

/**
 * 这个投放是不是已经领成了。
 *
 * 两处记忆：
 *
 *   · 这一层记的（手动领成的那些）
 *   · 现役快照里那一格结论是 claimed 且说的是同一个投放（定时那条路领成的，
 *     或者是上一次手动领成的 —— 快照是进程内存里那份，重启就没了）
 *
 * **不看**快照里的 claimedKeys 那一列：那一列混着定时那条路的「要人工过
 * 验证码」记忆（它把那种也记成不再重试）。拿它当「领过了」会把手动领取
 * 挡在门外 —— 而手动领取存在的意义正是补那次。
 */
function alreadyClaimed(providerId: string, campaignId: string, planId: string): boolean {
  if (claimedOkOf(providerId).has(`${campaignId}|${planId}`)) return true;
  const live = peekHealthSnapshot<HealthSnapshot>()?.data;
  const claim = live?.zcode?.[providerId]?.claim;
  return (
    claim?.state === "claimed" &&
    claim.planId === planId &&
    claim.campaignId === campaignId
  );
}

/**
 * 手动领一次。
 *
 * 顺序是固定的（每一步都能少发一个请求就少发）：
 *
 *   1. 没有会话 → failed（本地就没问）
 *   2. 没有验证码参数 → failed（上游要验证码时不带它必被 3007 拒；面板
 *      本来也不该在拿不到参数时点这个按钮）
 *   3. 问投放：plan_id 不在当前的投放里 → no_offer（**不发**领取请求）
 *   4. 这个投放领成过 → already（**不发**领取请求）
 *   5. 领。
 */
export async function claimZcodePlanManually(
  providerId: string,
  input: ZcodeManualClaimInput,
): Promise<ZcodeManualClaimResult> {
  const startedAt = Date.now();
  const planId = String(input.planId ?? "").trim();
  const campaignId = String(input.campaignId ?? "").trim();
  const captchaParam = String(input.captchaVerifyParam ?? "").trim();
  const captchaRegion = String(input.captchaRegion ?? "").trim();
  const finish = (
    outcome: ZcodeManualClaimOutcome,
    extra: Partial<ZcodeManualClaimResult> = {},
  ): ZcodeManualClaimResult => ({
    outcome,
    code: null,
    upstreamMessage: "",
    message: "",
    durationMs: Date.now() - startedAt,
    ...extra,
  });

  if (!planId) {
    return finish("failed", { message: "没有 plan_id：不知道要领什么" });
  }
  if (!loadSession(providerId)) {
    return finish("failed", { message: "本地没有会话（这个账号没登录）" });
  }
  if (!captchaParam) {
    return finish("failed", {
      message: "没有验证码参数：前端没有跑出阿里云的无感校验结果",
    });
  }

  // 「此刻还有没有这个投放」：问投放接口（不是 billing/preview）。
  const touch = await fetchTouch(providerId);
  if (touch.state !== "ok") {
    return finish("failed", {
      message:
        touch.state === "missing"
          ? "本地没有会话"
          : touch.state === "unauthorized"
            ? touch.message
            : `问不到投放：${touch.message}`,
    });
  }
  const offer = touch.offers.find((o) => o.planId === planId);
  if (!offer) {
    return finish("no_offer", {
      message: "此刻没有这个可领的投放（plan_id 不在上游当前的投放里）",
    });
  }
  // 幂等键用**上游当前**的 campaign_id：前端手里那个可能是上一轮的。
  const key = offerKey(offer);
  const currentCampaign = offer.campaignId || campaignId;
  if (alreadyClaimed(providerId, currentCampaign, planId)) {
    return finish("already", {
      message: "这个投放已经领过了，不再重复领取",
    });
  }

  const result = await claimPlan(providerId, planId, {
    captchaVerifyParam: captchaParam,
    captchaRegion: captchaRegion,
  });
  const [outcome, extra] = manualOutcomeOf(result, {
    key,
    providerId,
    campaignId: currentCampaign,
    offerName: offer.name,
  });
  const answer = finish(outcome, extra);
  // 留痕与快照都在这一层写（不是管理端那一层）：领是一次**上游写操作**，
  // 无论谁触发它都要留痕、都要让面板看得见。
  logManualClaim({
    providerId,
    platformId: providerPlatformId(providerId),
    campaignId: currentCampaign,
    planId,
    outcome: answer.outcome,
    code: answer.code,
    message: answer.message,
    durationMs: answer.durationMs,
    captchaParamLength: captchaParam.length,
  });
  await recordManualClaim(providerId, outcome, {
    campaignId: currentCampaign,
    planId,
    key,
  }, {
    code: answer.code,
    message: answer.message,
    ...(answer.planName ? { planName: answer.planName } : {}),
    ...(answer.effectiveAt ? { effectiveAt: answer.effectiveAt } : {}),
  });
  return answer;
}

/** claimPlan 的结论 → 手动领取的结论。 */
function manualOutcomeOf(
  result: ZcodeClaimResult,
  ctx: { key: string; providerId: string; campaignId: string; offerName: string | null },
): [ZcodeManualClaimOutcome, Partial<ZcodeManualClaimResult>] {
  if (result.state === "claimed") {
    claimedOkOf(ctx.providerId).add(ctx.key);
    const effectiveAt = result.plan.entitlements
      .map((e) => e.effectiveAt)
      .filter((t): t is string => Boolean(t))
      .sort()[0];
    return [
      "claimed",
      {
        code: 0,
        upstreamMessage: "",
        message: "领到了",
        planName: ctx.offerName || result.plan.planId,
        ...(effectiveAt ? { effectiveAt } : {}),
      },
    ];
  }
  if (result.state === "already") {
    return [
      "already",
      { code: result.code, upstreamMessage: result.message, message: result.message },
    ];
  }
  if (result.state === "captcha") {
    return [
      "captcha_rejected",
      {
        code: result.code,
        upstreamMessage: result.message,
        message: `上游把验证码判成无效：${result.message}`,
      },
    ];
  }
  if (result.state === "unauthorized") {
    return ["failed", { code: null, upstreamMessage: "", message: result.message }];
  }
  if (result.state === "missing") {
    return ["failed", { code: null, upstreamMessage: "", message: "本地没有会话" }];
  }
  return [
    "failed",
    { code: result.code, upstreamMessage: result.message, message: result.message },
  ];
}

/* ------------------------------------------------------------------ *
 * 留痕
 * ------------------------------------------------------------------ */

/** 账号所属的平台 id（zcode 账号名下的平台行就叫 zcode）。 */
function providerPlatformId(providerId: string): string {
  return provider(providerId)?.platform ?? "zcode";
}

/**
 * 写一行手动领取的日志。
 *
 * 一次手动领取要留痕：谁（provider）、哪个投放（campaign）、领哪个计划
 * （plan）、上游给了什么业务码、花了多久。
 *
 * **验证码参数的原值不进日志**：那是一次性的令牌，写进去等于把凭据抄一份
 * 到日志里（还会被日志收集器搬走）。只写它的长度。
 */
export function logManualClaim(fields: {
  providerId: string;
  platformId: string;
  campaignId: string;
  planId: string;
  outcome: ZcodeManualClaimOutcome;
  code?: number | null;
  message?: string;
  durationMs: number;
  captchaParamLength: number;
}): void {
  const parts = [
    `[ZCODE] manual claim account=${fields.providerId} platform=${fields.platformId}`,
    `campaign=${fields.campaignId}`,
    `plan=${fields.planId}`,
    `outcome=${fields.outcome}`,
  ];
  if (fields.code !== undefined && fields.code !== null) parts.push(`code=${fields.code}`);
  parts.push(`took=${fields.durationMs}ms`);
  // 验证码参数：只留长度，不留原值。
  parts.push(`captcha=len:${fields.captchaParamLength}`);
  const message = scrubForLog(String(fields.message ?? "").replace(/\s+/g, " ").trim(), 300);
  if (message) parts.push(`msg=「${message}」`);
  const line = parts.join(" ");
  if (fields.outcome === "failed") log.warn(line);
  else log.info(line);
}

/**
 * 把一次手动领取的结论写进现役的健康快照（面板从那儿读）。
 *
 * 跟定时那条路写的是同一格（zcode[provider].claim）：面板只有一格可读，
 * 两边各写一份的话面板会看到两个打架的结论。
 *
 * 「已经领过哪些投放」也记进去（campaign_id|plan_id）—— 于是定时那条路不会
 * 再对同一个投放重复 POST（上游的投放会一直挂着，它不会说「这个已经领过
 * 了」）。
 *
 * 额度也一起刷：领完之后上游的余额变了，缓存里的旧数不能留着（面板读的
 * 是快照里那一格）。
 */
export async function recordManualClaim(
  providerId: string,
  outcome: ZcodeManualClaimOutcome,
  input: { campaignId: string; planId: string; key: string },
  result: { code: number | null; message: string; planName?: string; effectiveAt?: string },
): Promise<void> {
  const snapshot = {
    at: Date.now(),
    state:
      outcome === "claimed"
        ? ("claimed" as const)
        : outcome === "already"
          ? ("already" as const)
          : outcome === "captcha_rejected"
            ? ("captcha" as const)
            : outcome === "no_offer"
              ? ("none" as const)
              : ("failed" as const),
    message: result.message,
    ...(result.planName ? { planName: result.planName } : {}),
    ...(result.effectiveAt ? { effectiveAt: result.effectiveAt } : {}),
    planId: input.planId,
    campaignId: input.campaignId,
    code: result.code,
    // 只记**领成过**的那一条：定时那条路把「要人工过验证码」也记成不再
    // 重试，那是它自己的记忆；混在一起会让「已经领过」变成「试过了」。
    ...(outcome === "claimed" ? { claimedKeys: [input.key] } : {}),
  };
  recordClaimSnapshot(providerId, snapshot);
  await refreshQuotaInSnapshot(providerId);
}

/**
 * 刷新这个账号的额度并写进现役快照。
 *
 * 面板读额度读的是快照里那一格（lib/admin/upstreams.ts 写的），所以这里
 * 直接改现役快照的那一格 —— 不造一份半份快照（读它的人会崩）。
 *
 * maxAge=0 = 强制重问一次：额度接口有五分钟的缓存（credits.ts），领完
 * 之后那一格还是旧数。
 */
async function refreshQuotaInSnapshot(providerId: string): Promise<void> {
  const live = peekHealthSnapshot<HealthSnapshot>()?.data;
  if (!live?.zcode) return;
  const probe = await zcodeQuota(0, providerId);
  live.zcode = { ...live.zcode };
  live.zcode[providerId] = {
    ...(live.zcode[providerId] ?? { quota: null }),
    quota: probe,
  };
}
