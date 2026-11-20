// lib/qoder/credits.ts — what the Qoder account has left.
//
// The plan's own credits, the ones bought on top of it, and the account's
// standing (the server says PASS, WAIT, or why it may not be used).

import {
  ENDPOINTS,
  USER_AGENT,
  ensureCredential,
  loadSession,
  loginHint,
  regionOf,
  sessionId,
  type QoderRegion,
} from "./auth.ts";
import { clearHint } from "../session.ts";
import { scrubForLog } from "../log-scrub.ts";
import {
  vendorFailed,
  vendorMissing,
  vendorOk,
  vendorUnauthorized,
  type VendorProbe,
} from "../provider-kinds.ts";

export interface QoderAccountHealth {
  region: QoderRegion;
  authorized: boolean;
  /** PASS / WAIT / NoIpPermission / AppDisable / LoginExpire, as the server reports it. */
  whitelistStatus?: string;
  userId?: string;
  userType?: string;
  /** True when the account is fine to use. */
  usable: boolean;
  /** Why not, in a sentence. */
  reason?: string;
  hint?: string;
}

/** What the account has left, in credits. */
export interface QoderCredits {
  region: QoderRegion;
  /** The plan's own credits. */
  plan: { total: number; used: number; remaining: number };
  /** Credits bought on top of the plan. */
  addOn: { total: number; used: number; remaining: number };
  /** Whether the plan's credits are used up. */
  quotaExceeded: boolean;
  /** When the plan's credits reset. */
  resetsAt: string | null;
}

/**
 * Ask the account how many credits it has left.
 *
 * GET /api/v2/quota/usage on the openapi host, with the same token the status
 * check uses. The answer holds two pots: the plan's own credits and the ones
 * bought on top of it.
 */
export type QoderCreditsProbe = VendorProbe<QoderCredits>;

/**
 * Qoder 的鉴权失败有时不在 HTTP 码上：status 接口的 whitelistStatus 会明说
 * `LoginExpire`。额度接口没给这份码时，只把 401/403 算 unauthorized；
 * 别的不明业务码算 failed —— 不把「问不到」编成「凭据坏了」。
 */
export async function fetchQoderCredits(providerId = "qoder"): Promise<QoderCreditsProbe> {
  const region = regionOf(providerId);
  const session = loadSession(providerId);
  if (!session) return vendorMissing();
  try {
    const cred = await ensureCredential(providerId);
    const r = await fetch(`${ENDPOINTS[region].openapi}/api/v2/quota/usage`, {
      headers: {
        Authorization: `Bearer ${cred.accessToken}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...(session.machineToken ? { "Cosy-MachineToken": session.machineToken } : {}),
        ...(session.machineType ? { "Cosy-Machine-Type": session.machineType } : {}),
      },
    });
    if (!r.ok) {
      // 正文只在这一处拿得到：额度读不出来时面板上只会写「没有额度」，
      // 没人知道上游到底答了什么。
      const text = await r.text().catch(() => "");
      console.warn(`[UPSTREAM] Qoder 额度查询 ${r.status}：${scrubForLog(text, 300)}`);
      if (r.status === 401 || r.status === 403) {
        return vendorUnauthorized(`上游拒绝了这把令牌（HTTP ${r.status}）`);
      }
      return vendorFailed(`上游答了 HTTP ${r.status}`);
    }
    const body = await r.json().catch(() => undefined);
    if (!body || typeof body !== "object") return vendorFailed("上游的答复不是 JSON 对象");
    const pot = (p: any) => ({
      total: Number(p?.total ?? 0),
      used: Number(p?.used ?? 0),
      remaining: Number(p?.remaining ?? 0),
    });
    return vendorOk({
      region,
      plan: pot(body?.userQuota),
      addOn: pot(body?.addOnQuota),
      quotaExceeded: body?.isQuotaExceeded === true,
      resetsAt: typeof body?.expiresAt === "number" ? new Date(body.expiresAt).toISOString() : null,
    });
  } catch (e) {
    return vendorFailed(`问不到额度：${(e as Error)?.message ?? String(e)}`);
  }
}

export async function checkAccountHealth(providerId = "qoder"): Promise<QoderAccountHealth> {
  const region = regionOf(providerId);
  const session = loadSession(providerId);
  if (!session) {
    return { region, authorized: false, usable: false, reason: "no session", hint: loginHint(providerId) };
  }
  const cred = await ensureCredential(providerId);
  const r = await fetch(`${ENDPOINTS[region].openapi}/api/v3/user/status`, {
    headers: {
      Authorization: `Bearer ${cred.accessToken}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...(session.machineToken ? { "Cosy-MachineToken": session.machineToken } : {}),
      ...(session.machineType ? { "Cosy-Machine-Type": session.machineType } : {}),
    },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    let body: any = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      /* not JSON */
    }
    const code = body?.errorCode ?? body?.code ?? `HTTP ${r.status}`;
    // 只留一个代码在面板上，上游到底说了什么只有这里知道。
    console.warn(`[UPSTREAM] Qoder 账号状态 ${r.status}：${scrubForLog(text, 300)}`);
    return {
      region,
      authorized: false,
      usable: false,
      reason: `status check failed (${code})`,
      hint: `Qoder 账号状态查询失败（${code}）。`,
    };
  }
  const body = await r.json().catch(() => undefined);
  const userId = typeof body?.id === "string" ? body.id : undefined;
  const whitelistStatus = typeof body?.whitelistStatus === "string" ? body.whitelistStatus : undefined;
  const userType = typeof body?.userType === "string" ? body.userType : undefined;

  if (!userId) {
    return {
      region,
      authorized: false,
      usable: false,
      reason: "login expired",
      hint: `登录已失效，${clearHint(sessionId(region))}。`,
    };
  }
  if (whitelistStatus === "NoIpPermission") {
    return {
      region,
      authorized: false,
      usable: false,
      whitelistStatus,
      userId,
      userType,
      reason: "the account may not be used from this IP",
      hint: "Qoder 拒绝了当前出口 IP（NoIpPermission）。请更换出口后重试。",
    };
  }
  if (whitelistStatus === "AppDisable") {
    return { region, authorized: false, usable: false, whitelistStatus, userId, userType, reason: "the app is disabled for this account" };
  }
  if (whitelistStatus === "LoginExpire") {
    return {
      region,
      authorized: false,
      usable: false,
      whitelistStatus,
      userId,
      userType,
      reason: "login expired",
      hint: `登录已过期，${clearHint(sessionId(region))}。`,
    };
  }
  return { region, authorized: true, usable: true, whitelistStatus, userId, userType };
}
