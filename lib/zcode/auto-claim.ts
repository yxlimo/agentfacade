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
// 例外：已经**领到**的那个计划不再重复领（按 plan_id 记，记忆在快照里）。
// preview 可能滞后，还列着刚领过的计划；照着它 POST 就是一天几十次重复写。
// 换一个新活动（新的 plan_id）照领不误。
//
// 开关：`FACADE_ZCODE_AUTO_CLAIM`（默认开）。关掉时一个请求都不发。

import { configFlag, configNumber, markHotSetting } from "../config.ts";
import { parseBool, readEnvValue } from "../env.ts";
import { listProviders, provider, type ProviderRow } from "../providers.ts";
import { peekHealthSnapshot } from "../health-cache.ts";
import type { HealthSnapshot, ZcodeClaimSnapshot } from "../provider-kinds.ts";
import { claimPlan, describeClaimedPlan, logClaimAttempt, previewClaims } from "./claim.ts";

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

/**
 * 这个账号最近一次的领取结论。
 *
 * 结论的落点是现役的那份健康快照（zcode[providerId].claim）：面板读的就是它。
 *
 * 整个快照都还没有的那一段窗口里，结论先放在模块级的 pending 里（见
 * pendingClaims）：领取是**写上游**的动作，一天一次的结果丢了就没人知道今天
 * 领没领。快照一出现，pending 就并进快照（mergePendingClaims），之后只读快照。
 */
export function zcodeClaimSnapshot(providerId: string): ZcodeClaimSnapshot | undefined {
  const live = peekHealthSnapshot<HealthSnapshot>()?.data ?? null;
  const claim = live?.zcode?.[providerId]?.claim;
  if (claim) {
    // 已经在快照里了：pending 那份是旧的，删掉。
    pendingClaims.delete(providerId);
    return claim;
  }
  const pending = pendingClaims.get(providerId);
  if (!pending) return undefined;
  // 窗口过去了：快照已经在了，更新的那份才是权威（它要么带走了这个结论，
  // 要么已经重新问过上游）。这一份不留着。
  if (pending.snapshot !== live) {
    pendingClaims.delete(providerId);
    return undefined;
  }
  return pending.claim;
}

/**
 * 还没写进快照的领取结论。
 *
 * 什么时候会有：进程刚起来、第一次健康轮询还没写出快照的时候，领取已经跑过
 * 一轮了（领取与健康刷新各有各的节奏，领取常常赶在前面）。领取是**写上游**
 * 的动作，结果丢了就没人知道今天领没领 —— 所以那一份先放在这里，等下一份
 * 快照写出来时并进去（mergePendingClaims）。
 *
 * 这是**运行期**的需要，不是给测试留的开关：所以这里没有「复位」入口。结论
 * 进了快照就删掉（快照是唯一的落点）；测试复位靠换一份快照
 * （putHealthSnapshot）—— 换了快照就说明有了更新的真相，这一窗口就过去了。
 */
interface PendingClaim {
  /**
   * 记下来时现役的那份快照。
   *
   * 窗口只有「整个快照都还没有」这一段，所以这里记的是 null。快照一旦出现，
   * 这一份就是旧的了。
   */
  snapshot: HealthSnapshot | null;
  claim: ZcodeClaimSnapshot;
}

/** 还没写进快照的领取结论：账号 id → 那一份。 */
const pendingClaims = new Map<string, PendingClaim>();

/**
 * 把窗口里的结论并进一份刚写出来的快照。
 *
 * 谁写快照谁调它：结论是**写上游**的结果，丢了就没人知道今天领没领。
 * 写完就删掉 pending —— 快照是唯一的落点，两处不留同一份。
 */
export function mergePendingClaims(snapshot: HealthSnapshot): void {
  const live = peekHealthSnapshot<HealthSnapshot>()?.data ?? null;
  for (const [providerId, pending] of pendingClaims) {
    if (pending.snapshot !== live) {
      // 窗口已经过去了（快照换过了）：这份是旧的。
      pendingClaims.delete(providerId);
      continue;
    }
    const existing = snapshot.zcode?.[providerId]?.claim;
    snapshot.zcode = { ...(snapshot.zcode ?? {}) };
    snapshot.zcode[providerId] = {
      ...(snapshot.zcode[providerId] ?? { quota: null }),
      claim: existing ?? pending.claim,
    };
    pendingClaims.delete(providerId);
  }
}

/**
 * 记一次结论。
 *
 * 同时写进现在的那份快照：面板读的是快照，等下一次全量刷新才看到结论的话，
 * 人会以为没领（这一轮与下一次刷新之间最多差五分钟）。
 *
 * 「已经领过哪些计划」也在这份结论里（claimedPlanIds）：它跟着快照走，
 * 刷新时带过去（lib/admin/upstreams.ts 把这一格原样抄进新快照），所以不会
 * 因为一次刷新就忘掉 —— 忘了就会重复领同一个计划。
 *
 * 额度那一格还没有的时候，造出来的那一份带着 `quota: null` —— 那是「没问过
 * 额度」，不是「额度是 0」（null 那一档面板不摆额度卡）。
 *
 * 整个快照都还没有的时候（进程刚起来，第一次健康轮询还没跑）：结论先放在
 * pending 里，等下一份快照写出来时并进去。**不造**一份半份快照 —— 造出来的
 * 那个形状不对（少了 qoder / minimax 那些桶），读它的人会崩。
 */
function record(providerId: string, snapshot: ZcodeClaimSnapshot): void {
  const live = peekHealthSnapshot<HealthSnapshot>()?.data ?? null;
  const previous =
    live?.zcode?.[providerId]?.claim ?? pendingClaims.get(providerId)?.claim;
  // 合并「已经领过哪些计划」：新的结论（none / failed）不该把这份记忆抹掉。
  const claimed = Array.from(
    new Set([...(previous?.claimedPlanIds ?? []), ...(snapshot.claimedPlanIds ?? [])]),
  );
  const merged: ZcodeClaimSnapshot = claimed.length
    ? { ...snapshot, claimedPlanIds: claimed }
    : snapshot;
  if (!live) {
    pendingClaims.set(providerId, { snapshot: null, claim: merged });
    return;
  }
  const entry = live.zcode?.[providerId];
  live.zcode = { ...(live.zcode ?? {}) };
  live.zcode[providerId] = { ...(entry ?? { quota: null }), claim: merged };
}

/**
 * 这个账号已经领过的计划（plan_id）。
 *
 * 存在结论里（见 record）：进程内存的那份健康快照就是全部记忆。
 */
function claimedPlanIdsOf(providerId: string): string[] {
  return zcodeClaimSnapshot(providerId)?.claimedPlanIds ?? [];
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
  const platformId = provider(providerId)?.platform ?? "zcode";
  const preview = await previewClaims(providerId);
  if (preview.state === "missing") {
    logClaimAttempt({
      accountId: providerId,
      platformId,
      claimable: null,
      action: "none",
      state: "missing",
      message: "本地没有会话",
    });
    return null;
  }
  if (preview.state === "unauthorized") {
    logClaimAttempt({
      accountId: providerId,
      platformId,
      claimable: null,
      action: "none",
      state: "unauthorized",
      message: preview.message,
    });
    const snapshot: ZcodeClaimSnapshot = {
      at: preview.at,
      state: "unauthorized",
      message: preview.message,
    };
    record(providerId, snapshot);
    return snapshot;
  }
  if (preview.state === "failed") {
    logClaimAttempt({
      accountId: providerId,
      platformId,
      claimable: null,
      action: "none",
      state: "failed",
      message: preview.message,
    });
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
    logClaimAttempt({
      accountId: providerId,
      platformId,
      claimable: 0,
      action: "none",
      state: "none",
    });
    const snapshot: ZcodeClaimSnapshot = { at: preview.at, state: "none", message: "" };
    record(providerId, snapshot);
    return snapshot;
  }
  const plan = pickPlan(plans);
  if (!plan) {
    logClaimAttempt({
      accountId: providerId,
      platformId,
      claimable: plans.length,
      action: "none",
      state: "none",
    });
    const snapshot: ZcodeClaimSnapshot = { at: preview.at, state: "none", message: "" };
    record(providerId, snapshot);
    return snapshot;
  }
  const action = describeClaimedPlan(plan.name || plan.planId, plan.planId);
  // 同一个计划不重复领：上游的 preview 可能滞后，还列着刚领过的计划 —— 照着
  // 它 POST 就是一天几十次重复写。换个 plan_id（新活动）不受影响，照领。
  //
  // 记忆只活在进程内存的快照里：重启之后可能多 POST 一次，服务端会回终态码
  // （already），不会多领到额度。
  if (claimedPlanIdsOf(providerId).includes(plan.planId)) {
    logClaimAttempt({
      accountId: providerId,
      platformId,
      claimable: plans.length,
      action,
      state: "already",
      message: "这个计划已经领过（网关记得），不再重复领取",
    });
    return zcodeClaimSnapshot(providerId) ?? null;
  }
  const result = await claimPlan(providerId, plan.planId);
  if (result.state === "claimed") {
    const effectiveAt = effectiveAtOf(result.plan);
    logClaimAttempt({
      accountId: providerId,
      platformId,
      claimable: plans.length,
      action,
      state: "claimed",
      effectiveAt,
    });
    const snapshot: ZcodeClaimSnapshot = {
      at: result.at,
      state: "claimed",
      message: "",
      planName: plan.name || result.plan.planId,
      effectiveAt,
      claimedPlanIds: [...claimedPlanIdsOf(providerId), plan.planId],
    };
    record(providerId, snapshot);
    return snapshot;
  }
  if (result.state === "missing") {
    logClaimAttempt({
      accountId: providerId,
      platformId,
      claimable: plans.length,
      action,
      state: "missing",
      message: "本地没有会话",
    });
    return null;
  }
  logClaimAttempt({
    accountId: providerId,
    platformId,
    claimable: plans.length,
    action,
    state: result.state,
    message: result.message,
  });
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
