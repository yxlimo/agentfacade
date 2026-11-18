// lib/zcode/claim.ts — ZCode 的活动免费额度：看有没有可领的，有就领。
//
// 两个端点（实测形状，2026-11 在容器里真打过）：
//
//   GET  {ZCODE_BASE}/api/v1/zcode-plan/billing/preview
//        ?app_version=<版本>&platform=win32-x64
//        → 有可领：{code:0, data:{server_time, plans:[…]}}
//        → 没有可领：{code:0, msg:"", logid:"…"}（**没有 data 字段**）
//        → 其它（非 200 / code 非 0）：失败
//
//   POST {ZCODE_BASE}/api/v1/zcode-plan/billing/claim
//        body: {"plan_id": "<preview 里的 plan_id>"}
//        → 成功：code===0 且 data.plan 存在
//        → 失败：透传 code 与 data.message（服务端给中文，别自己映射）
//
// 三件容易踩的事，这里都踩过了：
//
//   · Authorization 头**不能自己加**：zcodePlatformHeaders() 已经带了（外加
//     x-api-key 与那套客户端标识头）。叠一份会让上游回 401 空正文。
//   · 「没有可领」是 HTTP 200 + code 0 + 没有 data 字段，不是失败。把它当成
//     失败，就会在面板上显示成「问不到」，而真相是「今天没有可领的」。
//   · 1001–1005 在官方客户端里是**终态**（不重试）；缺阿里云验证码时是 3007
//     （文案含「验证码校验失败」）—— 网关过不了验证码，那要落成一个独立状态，
//     不许伪装成别的。
//
// 领取与每日签到是两件事：这里只有领取。定时器那一步也单开（lib/periodic.ts
// 的 `claim` 步进），不塞进 benefits —— 签到页不该说成签到。

import { configFlag, configNumber, configString } from "../config.ts";
import { scrubForLog } from "../log-scrub.ts";
import {
  vendorFailed,
  vendorMissing,
  vendorOk,
  vendorUnauthorized,
  type VendorProbe,
} from "../provider-kinds.ts";
import { ZCODE_BASE, loadSession } from "./auth.ts";
import { ZCODE_CLIENT_PLATFORM, zcodePlatformHeaders } from "./transport.ts";

/**
 * 领取与 preview 这两个端点用的客户端版本。
 *
 * 与 ZCODE_VERSION 分开：那个是**模型请求**的指纹（动了会被上游当异常活动），
 * 这两个是账单计划接口的版本。实测这两个端点报的是 3.18.2。
 */
export const ZCODE_CLAIM_APP_VERSION = configString("ZCODE_CLAIM_APP_VERSION", "3.18.2");

/** 问一轮就收手（毫秒）。 */
const CLAIM_TIMEOUT_MS = configNumber("ZCODE_CLAIM_TIMEOUT_MS", 20_000);

/**
 * 客户端当终态处理的那组业务码。
 *
 * 官方客户端碰到这组就不重试了。它**没有**说这一组里哪一条是「已经领过了」，
 * 所以这里整组当一个终态（`already`），不猜具体含义 —— 服务端的中文原话
 * 一起传上去，面板念原话，人才看得出到底哪一条。
 */
export const ZCODE_CLAIM_TERMINAL_CODES = [1001, 1002, 1003, 1004, 1005];

/** 需要人工过验证码时上游给的业务码。 */
const CAPTCHA_CODE = 3007;

/** 服务端文案里出现这串，就是「要验证码」。 */
const CAPTCHA_TEXT = "验证码校验失败";

/* ------------------------------------------------------------------ *
 * 形状
 * ------------------------------------------------------------------ */

/** 计划里的一项权益。 */
export interface ZcodeClaimEntitlement {
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

/** preview 里的一份可领计划。 */
export interface ZcodeClaimPlan {
  planId: string;
  name: string;
  description: string;
  /** 数字越大越先领。同优先级按列表顺序。 */
  priority: number;
  entitlements: ZcodeClaimEntitlement[];
}

/** preview 的答复。 */
export interface ZcodeClaimPreview {
  /** 可领的计划。空数组 = 现在没有可领的（不是失败）。 */
  plans: ZcodeClaimPlan[];
  /** 上游的服务器时间（ISO）。 */
  serverTime: string | null;
}

/** 领到的一个计划。 */
export interface ZcodeClaimedPlan {
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

function plansOf(rows: unknown): ZcodeClaimPlan[] {
  return (Array.isArray(rows) ? rows : []).map((row: any) => ({
    planId: String(row?.plan_id ?? ""),
    name: String(row?.name ?? ""),
    description: String(row?.description ?? ""),
    priority: num(row?.priority),
    entitlements: entitlementsOf(row?.entitlements),
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
  /** preview 看到几个可领的；null = 问不到（不知道几个）。 */
  claimable: number | null;
  /** 做了什么（领了哪个计划，或没领）。 */
  action: string;
  /** 结论状态。 */
  state: string;
  /** 上游的原话（有就带上 —— 排查上游行为最有用的就是它）。 */
  message?: string;
  /** 领到时的生效时刻（ISO）。 */
  effectiveAt?: string | null;
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
 * 一行说完，不打多行 JSON（人 grep 一行就够）：账号、平台、preview 的结论、
 * 做了什么、结论状态、上游原话、成功时的生效时刻。
 *
 * `failed` 用 warn（这一轮没成，要看见），其余用 log。
 */
export function logClaimAttempt(fields: ZcodeClaimLogFields): void {
  const preview =
    fields.claimable === null
      ? "unknown"
      : fields.claimable === 0
        ? "0（没有可领）"
        : String(fields.claimable);
  const parts = [
    `[ZCODE] claim account=${fields.accountId} platform=${fields.platformId}`,
    `preview=${preview}`,
    `action=${fields.action}`,
    `state=${fields.state}`,
  ];
  // 上游原话进日志前先抹一遍：上游正文里偶尔回显账号标识。
  const message = scrubForLog(String(fields.message ?? "").replace(/\s+/g, " ").trim(), 300);
  if (message) parts.push(`msg=「${message}」`);
  const effective = fields.effectiveAt ? String(fields.effectiveAt) : "";
  if (effective) parts.push(`effective=${effective}`);
  const line = parts.join(" ");
  if (fields.state === "failed") console.warn(line);
  else console.log(line);
}

/** 领的那个计划在日志里怎么说：名字 + 截断的 plan_id。 */
export function describeClaimedPlan(name: string, planId: string): string {
  const label = String(name ?? "").trim() || shortPlanId(planId);
  return `claim ${label}(${shortPlanId(planId)})`;
}

/* ------------------------------------------------------------------ *
 * 问上游
 * ------------------------------------------------------------------ */

/**
 * 看有没有可领的（只读）。
 *
 * 「没有可领」也是 `ok`：`plans` 是空数组。上游那时答的是 HTTP 200 + code 0
 * 但**没有 data 字段** —— 那是「今天没有」，不是「问不到」。把它折成 failed，
 * 面板上就变成「额度没问到」，而真相是「没有可领的」。
 */
export async function previewClaims(providerId = "zcode"): Promise<VendorProbe<ZcodeClaimPreview>> {
  const session = loadSession(providerId);
  if (!session) return vendorMissing();
  let r: Response;
  try {
    r = await fetch(
      `${ZCODE_BASE}/api/v1/zcode-plan/billing/preview` +
        `?app_version=${encodeURIComponent(ZCODE_CLAIM_APP_VERSION)}` +
        `&platform=${encodeURIComponent(ZCODE_CLIENT_PLATFORM)}`,
      {
        headers: {
          ...zcodePlatformHeaders(session),
          accept: "application/json",
        },
        signal: AbortSignal.timeout(CLAIM_TIMEOUT_MS),
      },
    );
  } catch (e) {
    return vendorFailed(`问不到可领的额度：${(e as Error)?.message ?? String(e)}`);
  }
  if (r.status === 401 || r.status === 403) {
    return vendorUnauthorized(`上游拒绝了这把令牌（HTTP ${r.status}）`);
  }
  if (!r.ok) return vendorFailed(`上游答了 HTTP ${r.status}`);
  const body: any = await r.json().catch(() => null);
  if (!body) return vendorFailed("上游的答复不是 JSON");
  if (body?.code !== 0) {
    return vendorFailed(`上游报了业务错误 ${body?.code ?? "?"}：${String(body?.msg ?? "")}`);
  }
  const data = body?.data ?? {};
  return vendorOk({
    plans: plansOf(data?.plans),
    serverTime: isoOf(data?.server_time),
  });
}

/**
 * 领一个计划。
 *
 * 成功：code===0 且 `data.plan` 存在。
 * 失败：把服务端的 code 与中文原话原样带回来 —— 不自己映射错误码（那一套
 * 映射是猜的，而猜错的话面板会说错原因）。
 */
export async function claimPlan(
  providerId: string,
  planId: string,
): Promise<ZcodeClaimResult> {
  const session = loadSession(providerId);
  if (!session) return { state: "missing", at: Date.now() };
  let r: Response;
  try {
    r = await fetch(`${ZCODE_BASE}/api/v1/zcode-plan/billing/claim`, {
      method: "POST",
      headers: {
        ...zcodePlatformHeaders(session),
        "content-type": "application/json",
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
  if (code !== null && ZCODE_CLAIM_TERMINAL_CODES.includes(code)) {
    return { state: "already", at: Date.now(), code, message };
  }
  if ((code !== null && code === CAPTCHA_CODE) || message.includes(CAPTCHA_TEXT)) {
    return { state: "captcha", at: Date.now(), code: code ?? CAPTCHA_CODE, message };
  }
  return { state: "failed", at: Date.now(), code, message };
}
