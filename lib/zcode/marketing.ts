// lib/zcode/marketing.ts — ZCode 的投放接口（marketing/touch）。
//
// 「有没有可领的活动额度」这件事，客户端是问**投放接口**的，不是问
// billing/preview 的：
//
//   GET {ZCODE_BASE}/api/v1/marketing/touch?seq=<n>
//     头：zcodePlatformHeaders + X-Client-Language + X-ZCode-App-Version
//         （X-Device-Mid 来自会话的 deviceId）
//     → {code:0, data:{server_time, language, deliveries:[…]}}
//
// 投放里带一个按钮，按钮的 action 是 {type:"claim_zcode_plan", args:{plan_id}}
// —— 那就是「现在有可领的」。官方客户端只认这一个 action 类型
// （packages/ui/src/components/marketing-touch/marketingTouchController.ts），
// 其余按钮（close 之类）不算数。
//
// 而 billing/preview 那条接口在「没有可领」时答的是 {code:0, msg:"", logid}
// —— **没有 data 字段**。客户端把它当错误（`throw new Error(payload.msg ||
// "manual_claim_preview_missing_data")`），不是当「没有可领」。所以拿它当
// 判据就是把「没有可领」与「问错了接口」混成一件事。
//
// 坏投放（缺 plan_id 之类）按客户端的做法丢弃并计数，不崩。

import { configNumber } from "../config.ts";
import { ZCODE_BASE, loadSession, type ZcodeSession } from "./auth.ts";
import { ZCODE_CLAIM_APP_VERSION } from "./claim.ts";
import { ZCODE_CLIENT_LANGUAGE, zcodePlatformHeaders } from "./transport.ts";

/** 投放接口的路径。探针配置里的那条「可领」判据必须指向它（见 test/probe-check.ts）。 */
export const ZCODE_MARKETING_TOUCH_PATH = "/api/v1/marketing/touch";

/** 投放接口的完整 URL。 */
export const ZCODE_MARKETING_TOUCH_URL = `${ZCODE_BASE}${ZCODE_MARKETING_TOUCH_PATH}`;

/** 问一轮就收手（毫秒）。 */
const TOUCH_TIMEOUT_MS = configNumber("ZCODE_MARKETING_TIMEOUT_MS", 20_000);

/**
 * 客户端的投放序号（进程内自增，从 0 开始）。
 *
 * 客户端每次问投放都带一个自增的 seq（同一个进程里单调递增）。我们照做：
 * 序号只在进程内有意义，重启归零无害。
 */
let touchSeq = 0;

/** 下一个投放序号。 */
export function nextTouchSeq(): number {
  return touchSeq++;
}

/**
 * 投放接口的头。
 *
 * 与平台那些接口（额度、领取）同一套平台头，多两处：
 *
 *   · X-ZCode-App-Version 用**账单那一版**（ZCODE_CLAIM_APP_VERSION），不是
 *     模型请求那一版 —— 投放是账单域的接口，客户端在这里报的就是账单版本。
 *   · X-Client-Language：投放按语言渲染，语言跟界面一致。
 *
 * X-Device-Mid 由 zcodePlatformHeaders 带来（会话里的 deviceId）。没有
 * device id 的老会话发不了这个请求（见 fetchTouch）。
 */
export function zcodeMarketingHeaders(session: ZcodeSession): Record<string, string> {
  return {
    ...zcodePlatformHeaders(session),
    "X-ZCode-App-Version": ZCODE_CLAIM_APP_VERSION,
    "X-Client-Language": ZCODE_CLIENT_LANGUAGE,
  };
}

/** 一个可领的投放（banner 上的「领取」按钮指向的计划）。 */
export interface ZcodeMarketingOffer {
  /** 投放的 id。与 plan_id 一起构成幂等键。 */
  campaignId: string;
  /** 要领的计划。 */
  planId: string;
  /** 展示名。上游没给就是 null（不编默认名）。 */
  name: string | null;
  /** 投放的优先级：大的先领。 */
  priority: number;
  /** 计划的开始/结束时刻（ISO）。上游没给就是 null。 */
  startsAt: string | null;
  endsAt: string | null;
  /** 各项权益给的额度。上游没给就是空数组。 */
  grantUnits: number[];
  /** 最早生效的时刻（ISO）。上游没给就是 null。 */
  effectiveAt: string | null;
}

/** 问投放的结论。 */
export type ZcodeTouchResult =
  | { state: "ok"; at: number; offers: ZcodeMarketingOffer[]; invalid: number }
  /** 会话里没有 device id（老会话）：发不了这个请求，也**不是**「没有可领」。 */
  | { state: "missing_device"; at: number; message: string }
  /** 本地没有会话。 */
  | { state: "missing"; at: number }
  /** 上游拒了这把凭据。 */
  | { state: "unauthorized"; at: number; message: string }
  /** 问不到（网络、上游错误、答复不是 JSON）。 */
  | { state: "failed"; at: number; message: string };

/* ------------------------------------------------------------------ *
 * 解析
 * ------------------------------------------------------------------ */

/** unix 秒 → ISO。上游给的是秒（当成毫秒会差出一千年）。 */
function isoOfSeconds(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds === 0) return null;
  return new Date(seconds * 1000).toISOString();
}

/**
 * 从 deliveries 里找出可领的投放。
 *
 * 判据与客户端一致：resource_position 是 banner，按钮里有
 * action.type === "claim_zcode_plan"，按钮的 args 里有 plan_id。
 *
 * 坏投放（缺 plan_id）被丢弃并计数 —— 客户端也是这么做的（zod 校验整条
 * deliveries[]，坏的那条被丢掉），不崩。
 */
export function parseTouchDeliveries(deliveries: unknown): {
  offers: ZcodeMarketingOffer[];
  invalid: number;
} {
  const offers: ZcodeMarketingOffer[] = [];
  let invalid = 0;
  const rows = Array.isArray(deliveries) ? deliveries : [];
  for (const row of rows) {
    const delivery = row as Record<string, unknown> | null;
    if (!delivery || typeof delivery !== "object") {
      invalid++;
      continue;
    }
    if (String(delivery.resource_position ?? "") !== "banner") continue;
    const banner = delivery.banner as Record<string, unknown> | undefined;
    const buttons = Array.isArray(banner?.buttons) ? banner.buttons : [];
    let action: Record<string, unknown> | null = null;
    for (const button of buttons) {
      const candidate = (button as Record<string, unknown> | undefined)?.action as
        | Record<string, unknown>
        | undefined;
      if (candidate && typeof candidate === "object" && String(candidate.type) === "claim_zcode_plan") {
        action = candidate as Record<string, unknown>;
        break;
      }
    }
    if (!action) continue;
    const args = (action.args ?? {}) as Record<string, unknown>;
    const planId = String(args.plan_id ?? "").trim();
    if (!planId) {
      // 坏投放：按钮说「可领」却没有 plan_id。丢掉它，但记着有这么一条。
      invalid++;
      continue;
    }
    const background = banner?.background as Record<string, unknown> | undefined;
    const bgArgs = (background?.args ?? {}) as Record<string, unknown>;
    const plan = (bgArgs.zcode_plan ?? {}) as Record<string, unknown>;
    const entitlements = Array.isArray(plan.entitlements) ? plan.entitlements : [];
    const effectiveTimes = entitlements
      .map((e) => isoOfSeconds((e as Record<string, unknown>)?.effective_at))
      .filter((t): t is string => Boolean(t));
    // 这些是 ISO-8601 字符串，字典序即时间序，所以最早的那条就是字典序最小的
    // 那条 —— 写显式比较，别靠 sort() 的默认行为（入参一换成 epoch 数字或别的
    // 格式，sort 的默认比较就静默错）。
    let effectiveAt: string | null = null;
    for (const t of effectiveTimes) {
      if (effectiveAt === null || t < effectiveAt) effectiveAt = t;
    }
    offers.push({
      campaignId: String(delivery.campaign_id ?? ""),
      planId,
      name: plan.name ? String(plan.name) : null,
      priority: Number(delivery.priority ?? 0) || 0,
      startsAt: isoOfSeconds(plan.starts_at),
      endsAt: isoOfSeconds(plan.ends_at),
      grantUnits: entitlements
        .map((e) => Number((e as Record<string, unknown>)?.grant_units ?? 0))
        .filter((n) => Number.isFinite(n) && n > 0),
      effectiveAt,
    });
  }
  return { offers, invalid };
}

/* ------------------------------------------------------------------ *
 * 问上游
 * ------------------------------------------------------------------ */

/**
 * 问一轮投放（只读）。
 *
 * 没有 device id 的会话**不发**这个请求：X-Device-Mid 是投放接口认的设备
 * 标识，缺了它上游只给参数错误，而「问不到」与「没有可领」是两件事 ——
 * 结论里分开说（missing_device）。
 */
export async function fetchTouch(providerId = "zcode"): Promise<ZcodeTouchResult> {
  const session = loadSession(providerId);
  if (!session) return { state: "missing", at: Date.now() };
  const deviceId = String(session.deviceId ?? "").trim();
  if (!deviceId) {
    return {
      state: "missing_device",
      at: Date.now(),
      message: "会话里没有设备标识（X-Device-Mid），发不了投放请求",
    };
  }
  let response: Response;
  try {
    response = await fetch(`${ZCODE_MARKETING_TOUCH_URL}?seq=${nextTouchSeq()}`, {
      headers: {
        ...zcodeMarketingHeaders(session),
        accept: "application/json",
      },
      signal: AbortSignal.timeout(TOUCH_TIMEOUT_MS),
    });
  } catch (e) {
    return {
      state: "failed",
      at: Date.now(),
      message: `问不到投放：${(e as Error)?.message ?? String(e)}`,
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
  if (body?.code !== 0) {
    return {
      state: "failed",
      at: Date.now(),
      message: `上游报了业务错误 ${body?.code ?? "?"}：${String(body?.msg ?? "")}`,
    };
  }
  const parsed = parseTouchDeliveries(body?.data?.deliveries);
  return { state: "ok", at: Date.now(), offers: parsed.offers, invalid: parsed.invalid };
}

/**
 * 幂等键：同一个投放的同一个计划算同一件事。
 *
 * 只按 plan_id 不够：上游换了一个活动但复用了计划名，那就不是同一件事了。
 */
export function offerKey(offer: { campaignId: string; planId: string }): string {
  return `${offer.campaignId}|${offer.planId}`;
}
