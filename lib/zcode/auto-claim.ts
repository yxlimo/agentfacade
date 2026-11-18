// lib/zcode/auto-claim.ts — 活动免费额度的定时领取。
//
// 这一步与每日签到是**两件事**：签到发积分，领取给的是活动计划的额度。两者
// 混在一起，面板上的签到页就会把领取说成签到。所以它有自己的步进
// （lib/periodic.ts 的 `claim`），自己的开关，自己的结论。
//
// 一轮做三件事：
//
//   1. preview：看有没有可领的。没有（plans 空）就到此为止 —— 一个请求都不
//      发领取。
//   2. 领第一个（priority 最大的那个，同优先级按列表顺序）。一轮只领一个。
//   3. 把结论记下来（成功与失败都记），面板从额度卡 note 上读出来。
//
// 终态（已领过 / 要验证码 / 领到了）本轮不再试；**下一个周期重新 preview
// 判断** —— 不自己记「已放弃」：服务端的可领列表每轮都可能变，把自己记成
// 「放弃」就再也领不到了。
//
// 开关：`FACADE_ZCODE_AUTO_CLAIM`（默认开）。关掉时一个请求都不发。

import { configFlag, configNumber, markHotSetting } from "../config.ts";
import { parseBool, readEnvValue } from "../env.ts";
import { listProviders, type ProviderRow } from "../providers.ts";
import { peekHealthSnapshot } from "../health-cache.ts";
import type { HealthSnapshot, ZcodeClaimSnapshot } from "../provider-kinds.ts";
import { claimPlan, previewClaims } from "./claim.ts";

/**
 * 多久跑一轮。
 *
 * 三十分钟：活动名额是按天给的，频繁问只是浪费额度；半小时足够在名额放出来
 * 之后当天领到，又不至于让人等一整天。
 */
export const ZCODE_CLAIM_INTERVAL_MS = configNumber("ZCODE_CLAIM_INTERVAL_MS", 30 * 60_000);

// 开关是热的：面板上关掉之后下一轮就不发了，不用等重启。
markHotSetting("FACADE_ZCODE_AUTO_CLAIM");
configFlag("FACADE_ZCODE_AUTO_CLAIM", true);

/**
 * 领取的结论（面板读的那一格）。
 *
 * 形状在 lib/provider-kinds.ts 里（快照那一格归它管），这里转出去一份别名，
 * 免得两处各写一遍、写着写着就走样。
 */
export type { ZcodeClaimSnapshot };

/**
 * 自动领取开不开。
 *
 * 默认**开**：这是用户明确要的（活动名额按天放，忘了领就白扔）。
 *
 * 环境变量每次现读（不是读一次定死）：这样改了不用重启，测试也能现开现关。
 * 环境变量没给时走配置（面板写进库的那份）。
 */
export function autoClaimEnabled(): boolean {
  const raw = readEnvValue("FACADE_ZCODE_AUTO_CLAIM");
  const parsed = raw === null ? null : parseBool(raw);
  if (parsed !== null) return parsed;
  return configFlag("FACADE_ZCODE_AUTO_CLAIM", true);
}

/** 每个账号最近一次的结论。 */
const conclusions = new Map<string, ZcodeClaimSnapshot>();

/**
 * 这个账号最近一次的领取结论。
 *
 * 没有 = 还没领过（不是「领了但没结论」）。
 */
export function zcodeClaimSnapshot(providerId: string): ZcodeClaimSnapshot | undefined {
  return conclusions.get(providerId);
}

/**
 * 记一次结论。
 *
 * 同时写进现在的那份快照（如果有）：面板读的是快照，等下一次全量刷新才看到
 * 结论的话，人会以为没领（这一轮与下一次刷新之间最多差五分钟）。
 *
 * 只改已经存在的那一份：额度那一格还没有的时候不凭空造一个 —— 造出来的
 * 额度卡是「额度是 0」，那是撒谎。
 */
function record(providerId: string, snapshot: ZcodeClaimSnapshot): void {
  conclusions.set(providerId, snapshot);
  const live = peekHealthSnapshot<HealthSnapshot>()?.data;
  const entry = live?.zcode?.[providerId];
  if (!live || !entry) return;
  live.zcode[providerId] = { ...entry, claim: snapshot };
}

/**
 * 领哪一个：一轮只领一个。
 *
 * priority 最大的那个先领；同优先级按 preview 给的列表顺序（上游说同优先级时
 * 顺序本身有意义，别自己打乱）。
 *
 * 「priority 最大」是按数字大小取的：上游给的是数字，没说越小越优先，那就按
 * 字面意思（大的先）。
 */
export function pickPlan<T extends { priority: number }>(plans: T[]): T | null {
  if (!plans.length) return null;
  let best = plans[0];
  for (const plan of plans) {
    if (Number(plan?.priority ?? 0) > Number(best?.priority ?? 0)) best = plan;
  }
  return best;
}

/**
 * 领到的计划什么时候开始算数。
 *
 * 取所有权益里最早的那个生效时刻：那时候起才有额度。
 */
function effectiveAtOf(plan: { entitlements?: { effectiveAt?: string | null }[] }): string | undefined {
  const times = (plan?.entitlements ?? [])
    .map((e) => (e?.effectiveAt ? Date.parse(String(e.effectiveAt)) : NaN))
    .filter((t) => Number.isFinite(t));
  if (!times.length) return undefined;
  return new Date(Math.min(...times)).toISOString();
}

/**
 * 一个账号的一轮。
 *
 * 每一轮都重新 preview —— 上一轮的终态不作数（可领列表每轮都可能变）。
 */
export async function claimOnce(providerId: string): Promise<ZcodeClaimSnapshot | null> {
  const preview = await previewClaims(providerId);
  if (preview.state === "missing") return null;
  if (preview.state === "unauthorized") {
    const snapshot: ZcodeClaimSnapshot = {
      at: preview.at,
      state: "unauthorized",
      message: preview.message,
    };
    record(providerId, snapshot);
    return snapshot;
  }
  if (preview.state === "failed") {
    const snapshot: ZcodeClaimSnapshot = {
      at: preview.at,
      state: "failed",
      message: preview.message,
    };
    record(providerId, snapshot);
    return snapshot;
  }
  const plans = preview.value.plans ?? [];
  if (!plans.length) {
    // 「没有可领」也是一个结论：面板要能说出「今天没有名额」，而不是空白。
    const snapshot: ZcodeClaimSnapshot = { at: preview.at, state: "none", message: "" };
    record(providerId, snapshot);
    return snapshot;
  }
  const plan = pickPlan(plans);
  if (!plan) {
    const snapshot: ZcodeClaimSnapshot = { at: preview.at, state: "none", message: "" };
    record(providerId, snapshot);
    return snapshot;
  }
  const result = await claimPlan(providerId, plan.planId);
  if (result.state === "claimed") {
    const snapshot: ZcodeClaimSnapshot = {
      at: result.at,
      state: "claimed",
      message: "",
      planName: plan.name || result.plan.planId,
      effectiveAt: effectiveAtOf(result.plan),
    };
    record(providerId, snapshot);
    return snapshot;
  }
  if (result.state === "missing") return null;
  const snapshot: ZcodeClaimSnapshot = {
    at: result.at,
    state: result.state,
    message: result.message,
  };
  record(providerId, snapshot);
  return snapshot;
}

/** 名下开着的 zcode 账号。 */
function zcodeAccounts(): ProviderRow[] {
  return listProviders().filter((row) => row.kind === "zcode" && row.enabled);
}

/**
 * 跑一轮：名下每个 zcode 账号各来一次。
 *
 * 开关关着就一个请求都不发（连 preview 都不发 —— preview 也是问上游）。
 * 一个账号失败不挡住别的账号。
 */
export async function runZcodeAutoClaim(): Promise<void> {
  if (!autoClaimEnabled()) return;
  for (const row of zcodeAccounts()) {
    try {
      await claimOnce(row.id);
    } catch (e) {
      console.warn(`[ZCODE] 账号 ${row.id} 的领取没跑成：${(e as Error)?.message ?? String(e)}`);
    }
  }
}

/** 清掉记着的结论（测试用）。 */
export function forgetZcodeClaim(providerId?: string): void {
  if (providerId) conclusions.delete(providerId);
  else conclusions.clear();
}
