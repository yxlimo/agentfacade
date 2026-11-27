// lib/zcode/claim.ts — ZCode 的活动免费额度：领的那一下。
//
// 判据在 lib/zcode/marketing.ts（投放接口）：**有没有可领**是投放接口说的，
// 不是 billing/preview 说的。preview 在「没有可领」时答 {code:0, msg:"",
// logid}（没有 data 字段），客户端把它当错误而不是当「没有可领」——
// 拿它当判据就是把「没有可领」与「问错了接口」混成一件事。这里因此不再调
// preview（省一次上游请求）。
//
// 领取本身（实测形状，2026-11 在容器里真打过）：
//
//   POST {ZCODE_BASE}/api/v1/zcode-plan/billing/claim
//        body: {"plan_id": "<投放里的 plan_id>"}
//        → 成功：code===0 且 data.plan 存在
//        → 失败：透传 code 与 data.message（服务端给中文，别自己映射）
//
// 三件容易踩的事，这里都踩过了：
//
//   · Authorization 头**不能自己加**：zcodePlatformHeaders() 已经带了（外加
//     x-api-key 与那套客户端标识头）。叠一份会让上游回 401 空正文。
//   · 1001–1005 在官方客户端里是**终态**（不重试）；缺阿里云验证码时是 3007
//     （文案含「验证码校验失败」）—— 网关过不了验证码，那要落成一个独立状态，
//     不许伪装成别的。
//   · 网关过不了阿里云验证码（真客户端由闭源版的头走人工验证码弹窗取得，
//     开源版那一段是空实现桩）—— 所以 3007 的结论要写明「需在官方客户端点
//     一次领取」，而不是含糊的「失败」。
//
// 领取与每日签到是两件事：这里只有领取。定时器那一步也单开（lib/periodic.ts
// 的 `claim` 步进），不塞进 benefits —— 签到页不该说成签到。

import { log } from "../log.ts";
import { configNumber } from "../config.ts";
import { scrubForLog } from "../log-scrub.ts";
import { ZCODE_BASE, loadSession } from "./auth.ts";
import { ZCODE_CLAIM_APP_VERSION, zcodePlatformApiHeaders } from "./transport.ts";

/**
 * 账单域（领取与投放）用的客户端版本。
 *
 * 与 ZCODE_VERSION 分开：那个是**模型请求**的指纹（动了会被上游当异常活动），
 * 这个是账单计划接口的版本（旧版本号下投放回 0 条，见 transport.ts 的注释）。
 *
 * 值本身住在 transport.ts（领取的头要用它，而头在那里）。这里再导出一次：
 * 从 claim.ts 导入的调用（marketing.ts、测试）照旧能用。
 */
export { ZCODE_CLAIM_APP_VERSION };

/** 问一轮就收手（毫秒）。 */
const CLAIM_TIMEOUT_MS = configNumber("ZCODE_CLAIM_TIMEOUT_MS", 20_000);

/**
 * 客户端当终态处理的那组业务码。
 *
 * 官方客户端碰到这组就不重试了。它**没有**说这一组里哪一条是「已经领过了」，
 * 所以这里整组当一个终态（`already`），不猜具体含义 —— 服务端的中文原话
 * 一起传上去，面板念原话，人才看得出到底哪一条。
 */
const ZCODE_CLAIM_TERMINAL_CODES = [1001, 1002, 1003, 1004, 1005];

/** 需要人工过验证码时上游给的业务码。 */
const CAPTCHA_CODE = 3007;

/** 服务端文案里出现这串，就是「要验证码」。 */
const CAPTCHA_TEXT = "验证码校验失败";

/* ------------------------------------------------------------------ *
 * 形状
 * ------------------------------------------------------------------ */

/** 计划里的一项权益。 */
interface ZcodeClaimEntitlement {
  entitlementId: string;
  showName: string;
  meter: string;
  unitType: string;
  capabilities: string[];
  grantUnits: number;
  period: string;
  priority: number;
  /** 什么时候开始算数（ISO）。null = 上游没给。 */
  effectiveAt: string | null;
}

/** 领到的一个计划。 */
interface ZcodeClaimedPlan {
  planId: string;
  userPlanId: string;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
  entitlements: ZcodeClaimEntitlement[];
}

/**
 * 领取的结论。
 *
 * 六种，缺一不可：
 *
 *   claimed      领到了（code 0 且 data.plan 存在）
 *   already      终态（1001–1005 那组）：服务端说不能再领了，本轮不再试
 *   captcha      要人工过验证码：网关过不了，人得自己去过
 *   unauthorized 上游拒了这把凭据（401/403）—— 要人重新登录
 *   failed       问到了但没领成（5xx、超时、其它业务码）：下一轮还会再试
 *   missing      本地就没有会话，压根没问
 *
 * `already` 与 `captcha` 是终态：`failed` 不是 —— 它下一轮还会再试。
 */
export type ZcodeClaimResult =
  | { state: "claimed"; at: number; plan: ZcodeClaimedPlan }
  | { state: "already"; at: number; code: number; message: string }
  | { state: "captcha"; at: number; code: number; message: string }
  | { state: "unauthorized"; at: number; message: string }
  | { state: "failed"; at: number; code: number | null; message: string }
  | { state: "missing"; at: number };

/* ------------------------------------------------------------------ *
 * 读答复
 * ------------------------------------------------------------------ */

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 上游给的是 unix 秒，别的模块按 ISO 字符串收。
 *
 * 数字直接当毫秒算会差出一千年：上游的 `effective_at` 是秒（见
 * lib/zcode/credits.ts 的同一处处理）。
 */
function isoOf(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value === 0) return null;
    return new Date(value * 1000).toISOString();
  }
  const raw = String(value);
  if (/^-?\d+$/.test(raw)) {
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds === 0) return null;
    return new Date(seconds * 1000).toISOString();
  }
  const at = Date.parse(raw);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function entitlementsOf(rows: unknown): ZcodeClaimEntitlement[] {
  return (Array.isArray(rows) ? rows : []).map((row: any) => ({
    entitlementId: String(row?.entitlement_id ?? ""),
    showName: String(row?.show_name ?? ""),
    meter: String(row?.meter ?? ""),
    unitType: String(row?.unit_type ?? ""),
    capabilities: (Array.isArray(row?.capabilities) ? row.capabilities : []).map((c: any) => String(c)),
    grantUnits: num(row?.grant_units),
    period: String(row?.period ?? ""),
    priority: num(row?.priority),
    effectiveAt: isoOf(row?.effective_at),
  }));
}

/* ------------------------------------------------------------------ *
 * 日志
 * ------------------------------------------------------------------ */

/** 一次领取尝试要记的那几样。 */
export interface ZcodeClaimLogFields {
  /** 账号 id。 */
  accountId: string;
  /** 平台 id（账号行上那个）。 */
  platformId: string;
  /** 投放里有几个可领的；null = 问不到（不知道几个）。 */
  offers: number | null;
  /** 做了什么（领了哪个计划，或没领）。 */
  action: string;
  /** 结论状态。 */
  state: string;
  /** 上游的原话（有就带上 —— 排查上游行为最有用的就是它）。 */
  message?: string;
  /** 领到时的生效时刻（ISO）。 */
  effectiveAt?: string | null;
  /** 领的那个计划的 plan_id。 */
  planId?: string;
  /** 投放的 id（与 plan_id 一起构成幂等键）。 */
  campaignId?: string;
  /** 上游给的业务码。 */
  code?: number | null;
}

/** plan_id 在日志里截断：整串 id 没必要进日志，够认出来就行。 */
function shortPlanId(planId: string): string {
  const id = String(planId ?? "");
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/**
 * 打一行领取日志。
 *
 * 每次尝试一行：成功、终态、没有可领、失败都要有 —— 这一步每天要打一次上游
 * 的写接口，属于会改账号状态的后台动作，不留痕就分不清「跑过没有」与
 * 「跑成了没有」。
 *
 * 一行说完，不打多行 JSON（人 grep 一行就够）：账号、平台、投放的结论、
 * 做了什么、结论状态、plan_id 与业务码、上游原话、成功时的生效时刻。
 *
 * `failed` 用 warn（这一轮没成，要看见），其余用 log。
 */
export function logClaimAttempt(fields: ZcodeClaimLogFields): void {
  let offers: string;
  if (fields.offers === null) offers = "unknown";
  else if (fields.offers === 0) offers = "0（没有可领）";
  else offers = String(fields.offers);
  const parts = [
    `[ZCODE] claim account=${fields.accountId} platform=${fields.platformId}`,
    `offers=${offers}`,
    `action=${fields.action}`,
    `state=${fields.state}`,
  ];
  // plan_id 与业务码：查「为什么没领到」就靠这两个（尤其 3007 那种要人工
  // 过验证码的终态 —— 光看 state 看不出是哪一次投放）。
  if (fields.planId) parts.push(`plan=${fields.planId}`);
  if (fields.campaignId) parts.push(`campaign=${fields.campaignId}`);
  if (fields.code !== undefined && fields.code !== null) parts.push(`code=${fields.code}`);
  // 上游原话进日志前先抹一遍：上游正文里偶尔回显账号标识。
  const message = scrubForLog(String(fields.message ?? "").replace(/\s+/g, " ").trim(), 300);
  if (message) parts.push(`msg=「${message}」`);
  const effective = fields.effectiveAt ? String(fields.effectiveAt) : "";
  if (effective) parts.push(`effective=${effective}`);
  const line = parts.join(" ");
  // log.* 在这里是刻意的：这一行就是本仓库的日志出口（上游正文要能进
  // 日志），不是漏掉的调试打印。
  if (fields.state === "failed") log.warn(line);
  else log.info(line);
}

/** 领的那个计划在日志里怎么说：名字 + 截断的 plan_id。 */
export function describeClaimedPlan(name: string, planId: string): string {
  const label = String(name ?? "").trim() || shortPlanId(planId);
  return `claim ${label}(${shortPlanId(planId)})`;
}

/* ------------------------------------------------------------------ *
 * 问上游
 * ------------------------------------------------------------------ */

/** 领取时的可选参数。 */
export interface ZcodeClaimOptions {
  /**
   * 浏览器里跑出来的阿里云无感校验结果（一次性）。
   *
   * 没有它上游答 3007（captcha verify failed）—— 定时那条路恒定落在那里，
   * 手动那条路（lib/zcode/claim-manual.ts）把它带来。
   */
  captchaVerifyParam?: string;
  /** 阿里云验证码的地域（上游配置里有 region 才带）。 */
  captchaRegion?: string;
}

/**
 * 领一个计划。
 *
 * 成功：code===0 且 `data.plan` 存在。
 * 失败：把服务端的 code 与中文原话原样带回来 —— 不自己映射错误码（那一套
 * 映射是猜的，而猜错的话面板会说错原因）。
 *
 * 头用 zcodePlatformApiHeaders：官方客户端的 claim 请求**不带**模型请求的
 * 那些头（x-api-key、anthropic-version、x-zcode-agent、x-zcode-session-type、
 * x-zcode-trace-id、x-query-id、x-zcode-query-source）—— 那是模型请求专用的
 * 归因头，平台 API 走另一套。Authorization 只有一份（叠了上游回 401 空正文）。
 */
export async function claimPlan(
  providerId: string,
  planId: string,
  options: ZcodeClaimOptions = {},
): Promise<ZcodeClaimResult> {
  const session = loadSession(providerId);
  if (!session) return { state: "missing", at: Date.now() };
  let r: Response;
  try {
    r = await fetch(`${ZCODE_BASE}/api/v1/zcode-plan/billing/claim`, {
      method: "POST",
      headers: {
        ...zcodePlatformApiHeaders(session, {
          captchaVerifyParam: options.captchaVerifyParam,
          captchaRegion: options.captchaRegion,
        }),
      },
      body: JSON.stringify({ plan_id: planId }),
      signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
    });
  } catch (e) {
    return {
      state: "failed",
      at: Date.now(),
      code: null,
      message: `领不到：${(e as Error)?.message ?? String(e)}`,
    };
  }
  if (r.status === 401 || r.status === 403) {
    return {
      state: "unauthorized",
      at: Date.now(),
      message: `上游拒绝了这把令牌（HTTP ${r.status}）`,
    };
  }
  if (!r.ok) {
    return { state: "failed", at: Date.now(), code: null, message: `上游答了 HTTP ${r.status}` };
  }
  const body: any = await r.json().catch(() => null);
  if (!body) {
    return { state: "failed", at: Date.now(), code: null, message: "上游的答复不是 JSON" };
  }
  const code = Number.isFinite(Number(body?.code)) ? Number(body?.code) : null;
  if (code === 0) {
    const plan = body?.data?.plan;
    if (!plan) {
      return { state: "failed", at: Date.now(), code, message: "上游说成功但没给计划" };
    }
    return {
      state: "claimed",
      at: Date.now(),
      plan: {
        planId: String(plan?.plan_id ?? planId),
        userPlanId: String(plan?.user_plan_id ?? ""),
        status: String(plan?.status ?? ""),
        startsAt: isoOf(plan?.starts_at),
        endsAt: isoOf(plan?.ends_at),
        entitlements: entitlementsOf(plan?.entitlements),
      },
    };
  }
  // 失败：服务端的中文原话（data.message，没有就 msg）。
  const message = String(body?.data?.message ?? body?.msg ?? "");
  // 验证码先判：文案兜底是为「上游换了码」准备的，而终态组里也可能带着验证码
  // 文案 —— 先判终态的话，那种答复会被说成「已领过」，人就不会去解验证码了。
  if ((code !== null && code === CAPTCHA_CODE) || message.includes(CAPTCHA_TEXT)) {
    return { state: "captcha", at: Date.now(), code: code ?? CAPTCHA_CODE, message };
  }
  if (code !== null && ZCODE_CLAIM_TERMINAL_CODES.includes(code)) {
    return { state: "already", at: Date.now(), code, message };
  }
  return { state: "failed", at: Date.now(), code, message };
}
