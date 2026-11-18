// lib/zcode/credits.ts — ZCode 的额度。
//
// Start Plan 的额度是一个接口：
//
//   GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance?app_version=<版本>
//
// 头是 Authorization: Bearer <zcode JWT>。
//
// 答复的信封是 {code, msg, data:{server_time, plans[], balances[]}}，
// balances[] 每项是一个额度桶：meter、unit_type、capabilities（哪些模型能用
// 这个桶）、total_units、used_units、remaining_units、period_start/end。
//
// 依据：docs/zcode/FINDINGS.md §9。

import {
  vendorFailed,
  vendorMissing,
  vendorOk,
  vendorUnauthorized,
  type VendorProbe,
} from "../provider-kinds.ts";
import { configNumber } from "../config.ts";
import { ZCODE_BASE, ZCODE_VERSION, loadSession } from "./auth.ts";
import { setZcodeCapabilities } from "./models.ts";
import { zcodePlatformHeaders } from "./transport.ts";

export interface ZcodeBucket {
  /** 桶的名字。 */
  showName: string;
  /** 计量方式：token 之类。 */
  meter: string;
  /** 单位类型。 */
  unitType: string;
  /** 这个桶适用哪些模型（`model:GLM-5.3-Flash` 这样）。 */
  capabilities: string[];
  total: number;
  used: number;
  remaining: number;
  periodStart: string | null;
  periodEnd: string | null;
  expiresAt: string | null;
}

export interface ZcodeQuota {
  /** 额度桶。 */
  buckets: ZcodeBucket[];
  /** 平台说的服务器时间。 */
  serverTime: string | null;
}

/**
 * 问额度的那一次结论。
 *
 * 四种：问到了（ok）／上游说凭据不行（unauthorized）／问到了但没拿到答案
 * （failed）／本地就没有会话（missing）。
 *
 * 为什么不再是一个 `ZcodeQuota | null`：null 把「上游拒了这把令牌」「问不到」
 * 「压根没问」折成一种，于是被拒的账号在面板上显示成「凭据可用 + 额度区空白」
 * —— 等于告诉用户这个账号正常，而下一次请求就会吃 401。
 */
export type ZcodeQuotaProbe = VendorProbe<ZcodeQuota>;

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 平台给的是 unix 秒，别的模块按 ISO 字符串收。
 *
 * 直接 Date.parse 一个数字串会得到 NaN（它不认 unix 时间），到后面
 * BigInt(NaN) 就炸了。
 */
function isoFromSeconds(value: unknown): string | null {
  const seconds = num(value);
  if (!seconds) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

/** 问额度等多久就收手（毫秒）。 */
const ZCODE_QUOTA_TIMEOUT_MS = configNumber("ZCODE_QUOTA_TIMEOUT_MS", 20_000);

/**
 * 读额度，答一个结论。
 *
 * 没有登录态就是 `missing`（压根没问）；401/403 是 `unauthorized`（上游明确说
 * 这把令牌不行）；网络、超时、5xx、看不懂的答复与业务码非 0 都是 `failed`。
 *
 * 答了 200 且 `balances: []` 是 **ok**：那是「额度用完了」，不是「不知道」——
 * 这两件事在面板上长得一样（都没有桶），但只有前者能判成用尽。
 */
export async function fetchZcodeQuota(providerId = "zcode"): Promise<ZcodeQuotaProbe> {
  const session = loadSession(providerId);
  if (!session) return vendorMissing();
  let r: Response;
  try {
    r = await fetch(
      `${ZCODE_BASE}/api/v1/zcode-plan/billing/balance?app_version=${encodeURIComponent(ZCODE_VERSION)}`,
      {
        headers: {
          ...zcodePlatformHeaders(session),
          accept: "application/json",
        },
        signal: AbortSignal.timeout(ZCODE_QUOTA_TIMEOUT_MS),
      },
    );
  } catch (e) {
    return vendorFailed(`问不到额度：${(e as Error)?.message ?? String(e)}`);
  }
  // 401/403 是上游明说「这把凭据不行」：它要人重新登录，不是额度的问题。
  if (r.status === 401 || r.status === 403) {
    return vendorUnauthorized(`上游拒绝了这把令牌（HTTP ${r.status}）`);
  }
  if (!r.ok) return vendorFailed(`上游答了 HTTP ${r.status}`);
  const body: any = await r.json().catch(() => null);
  if (!body) return vendorFailed("上游的答复不是 JSON");
  if (body?.code !== 0) {
    return vendorFailed(`上游报了业务错误 ${body?.code ?? "?"}：${String(body?.msg ?? "")}`);
  }
  try {
    const data = body?.data ?? {};
    const buckets: ZcodeBucket[] = (Array.isArray(data.balances) ? data.balances : []).map((row: any) => ({
      showName: String(row?.show_name ?? ""),
      meter: String(row?.meter ?? ""),
      unitType: String(row?.unit_type ?? ""),
      capabilities: (Array.isArray(row?.capabilities) ? row.capabilities : []).map((c: any) => String(c)),
      total: num(row?.total_units),
      used: num(row?.used_units),
      remaining: num(row?.remaining_units ?? row?.available_units),
      periodStart: isoFromSeconds(row?.period_start),
      periodEnd: isoFromSeconds(row?.period_end),
      expiresAt: isoFromSeconds(row?.expires_at),
    }));
    // 平台按账号限定能用哪些模型（每个额度桶带 capabilities）。它也是
    // 公布目录的依据 —— 不在这份清单里的模型，上游回 3006 model not allowed。
    setZcodeCapabilities(buckets.flatMap((b) => b.capabilities));
    return vendorOk({ buckets, serverTime: data?.server_time ?? null });
  } catch (e) {
    return vendorFailed(`读额度失败：${(e as Error)?.message ?? String(e)}`);
  }
}

/** 额度，问一次就缓存几分钟 —— 面板不该把平台问烦了。 */
export async function zcodeQuota(maxAgeMs = 300_000, providerId = "zcode"): Promise<ZcodeQuotaProbe> {
  const cached = caches.get(providerId);
  if (cached && Date.now() - cached.at < maxAgeMs) return cached.probe;
  const probe = await fetchZcodeQuota(providerId);
  caches.set(providerId, { at: Date.now(), probe });
  return probe;
}

/** The quota of each provider, cached separately: they are different accounts. */
const caches = new Map<string, { at: number; probe: ZcodeQuotaProbe }>();
