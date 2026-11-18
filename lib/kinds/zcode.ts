// lib/kinds/zcode.ts — ZCode.
//
// The plan is a bucket of tokens, and the endpoint speaks the Anthropic dialect
// (lib/zcode/transport.ts).

import { zcodeCatalogModels } from "../catalog-models.ts";
import {
  fromUpstreamStatus,
  registerKind,
  sessionOnlyPlan,
  vendorProbeOf,
  type HealthSnapshot,
  type ProviderRow,
  type QuotaView,
  type VendorProbe,
} from "./shared.ts";
import { loadSession, zcodeStatus } from "../zcode/auth.ts";
import type { ZcodeClaimSnapshot } from "../provider-kinds.ts";
import { zcodeModelsInUse } from "../zcode/models.ts";
import { ZCODE_MESSAGES_URL } from "../zcode/transport.ts";
import { peekHealthSnapshot } from "../health-cache.ts";
import { CredentialState } from "../gen/agentfacade/admin/v1/admin_pb.ts";
import type { ZcodePlan, ZcodeQuota } from "../zcode/credits.ts";

/**
 * 快照里这个账号那一次的结论。null = 没问过（快照里没有这一份）。
 *
 * 存的是结论而不是原样答复，所以这里读出来的是四种状态之一：问到了 / 上游说
 * 凭据不行 / 问到了但没拿到答案 / 本地就没有凭据。它们长得几乎一样，后果完全
 * 不同，折成一种就会把被拒的令牌说成「正常」（见 lib/provider-kinds.ts 的
 * VendorProbe）。
 */
function zcodeProbeOf(
  providerId: string,
  snapshot: HealthSnapshot | null | undefined,
): VendorProbe<ZcodeQuota> | null {
  const entry = snapshot?.zcode?.[providerId];
  return vendorProbeOf<ZcodeQuota>(entry?.quota);
}

/** 现在的快照（进程内存里那一份）。 */
function currentSnapshot(): HealthSnapshot | null {
  return peekHealthSnapshot<HealthSnapshot>()?.data ?? null;
}

/**
 * 上游是不是拒了这把令牌（而且拒的是现在这一把）。
 *
 * 判据两条，缺一不可：
 *
 *   · 结论是 unauthorized —— 上游明说了，不是我们猜的
 *   · 结论的时刻晚于这份会话的登录时刻 —— 重新登录之后旧的那次拒绝自动作废，
 *     否则人已经登录过了，账号却永远挂着一个红
 *
 * 没有会话就没有可拒的东西：那时候凭据是「没登录」，不是「被拒」。
 *
 * 会话在、但缺登录时刻（旧会话）时按**被拒**处理：登录路径每次登录都会写
 * loginAtMs（lib/zcode/auth.ts），所以用户一重登这个红就自动消失 —— 判错
 * 的代价是「刚重登的那几分钟红着」，自愈；反过来按「没被拒」处理，被拒的
 * 令牌会一直显示成可用，那是不会自愈的。
 */
function zcodeRefused(providerId: string, snapshot?: HealthSnapshot | null): boolean {
  const probe = zcodeProbeOf(providerId, snapshot ?? currentSnapshot());
  if (probe?.state !== "unauthorized") return false;
  const session = loadSession(providerId);
  if (!session) return false;
  const loginAtMs = Number(session.loginAtMs ?? 0);
  if (!loginAtMs) return true;
  return probe.at > loginAtMs;
}

/**
 * The plan buckets the snapshot holds for this account, or `null` when nothing
 * was learned.
 *
 * Three shapes have to stay apart, because two of them look the same once the
 * buckets are read out as a list:
 *
 *   no entry, or `quota: null`   the platform was not asked, or the call
 *                                failed — we know nothing
 *   `quota.buckets: []`          asked, answered 200, and the platform listed
 *                                no bucket at all — the plan is spent or has
 *                                expired. This is ZCode's way of saying "used
 *                                up", not its default for "no quota".
 *   `quota.buckets: [bucket]`    the plan as the platform reports it
 *
 * Collapsing the middle shape into the first is what made a spent account look
 * ready: the panel showed no quota card and the state stayed `ready`, while the
 * next request came back with business code 1005 (a 402 on our side).
 *
 * 这一段现在读的是结论（VendorProbe）：「上游拒了令牌」「这一轮问不到」「本地
 * 没有会话」也各有各的形状，见 zcodeProbeOf。
 */
function zcodeBucketsOf(provider: ProviderRow, snapshot: HealthSnapshot): any[] | null {
  const probe = zcodeProbeOf(provider.id, snapshot);
  if (!probe || probe.state !== "ok") return null;
  const buckets = probe.value?.buckets;
  return Array.isArray(buckets) ? buckets : null;
}

/**
 * 账号领到的计划。null = 不知道（没问过 / 问不到），[] = 问过了，一个计划也没有。
 *
 * 与 buckets 各自独立：balances 空不等于 plans 空，反过来也一样。
 */
function zcodePlansOf(provider: ProviderRow, snapshot: HealthSnapshot): ZcodePlan[] | null {
  const probe = zcodeProbeOf(provider.id, snapshot);
  if (!probe || probe.state !== "ok") return null;
  const plans = probe.value?.plans;
  return Array.isArray(plans) ? plans : [];
}

/**
 * 上游的服务器时间（毫秒）。
 *
 * 判「计划生效了没有」要用上游那把尺子，不是本机时钟：两边差着几分钟，
 * 结论就反了。快照里存的是 ISO 字符串，早一版的快照存的是 unix 秒，两种都认。
 * 上游没给时刻（本机时钟）时退回本机时钟 —— 那时上游也没说清。
 */
function zcodeServerNowMs(probe: VendorProbe<ZcodeQuota> | null): number {
  const raw = probe?.state === "ok" ? probe.value?.serverTime : null;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw * 1000;
  if (typeof raw === "string" && raw) {
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return at;
  }
  return Date.now();
}

/**
 * 这个账号最近一次领取的结论（快照里那一格）。
 *
 * null = 还没领过（不是「领了但没结论」）。
 */
function zcodeClaimOf(
  providerId: string,
  snapshot: HealthSnapshot | null | undefined,
): ZcodeClaimSnapshot | null {
  const entry = snapshot?.zcode?.[providerId];
  const claim = entry?.claim;
  if (!claim || typeof claim !== "object") return null;
  return claim as ZcodeClaimSnapshot;
}

/**
 * 领取的结论写成额度卡上的一句话。
 *
 * 只在「没有桶、也没有待生效计划」时补这一句：那时候额度卡说的是「用完了」，
 * 而领取那一格说的是今天为什么没领到 —— 两句合起来才是完整的实情。有桶或者
 * 有待生效计划时额度卡本来就在说额度的事，不必再插一句。
 *
 * 服务端的原话原样带上（它是中文，比我们转述的准）。
 */
function zcodeClaimNote(
  providerId: string,
  snapshot: HealthSnapshot | null | undefined,
): string {
  const claim = zcodeClaimOf(providerId, snapshot);
  if (!claim) return "";
  const message = String(claim.message ?? "");
  switch (claim.state) {
    case "claimed": {
      const name = String(claim.planName ?? "");
      const at = String(claim.effectiveAt ?? "");
      const what = name ? `「${name}」` : "";
      const when = at ? `（${at} 生效）` : "";
      return `领取：已领到${what}${when}`;
    }
    case "already":
      return `领取：已领过${message ? `（${message}）` : ""}`;
    case "none":
      // preview 的列表是空的：此刻没有可领的。可能是名额用完了，也可能已经领过、
      // 活动还没开始 —— preview 没给 data 就分不出来，所以不编结论，只说「此刻」。
      // 服务端说了什么就带上什么。
      return `领取：此刻没有可领的${message ? `（${message}）` : ""}`;
    case "captcha":
      return `领取：需要人工过验证码${message ? `（${message}）` : ""}`;
    case "unauthorized":
      return `领取：上游拒绝了这把凭据${message ? `（${message}）` : ""}`;
    case "failed":
      return `领取：没领成${message ? `（${message}）` : ""}`;
    default:
      return "";
  }
}

/** 一个「领到了但还没生效」的计划。 */
interface PendingPlan {
  /** 计划的名字（面板上要念给人听）。 */
  name: string;
  /** 什么时候开始算数（毫秒，绝对时刻）。 */
  effectiveAtMs: number;
  /** 这个计划一共给了多少 token。 */
  grantUnits: number;
}

/**
 * 领到了、但还没生效的计划。
 *
 * 判据三条，缺一不可：
 *
 *   · status 是 active —— 别的状态（expired 之类）不算「还没生效」
 *   · 上游给了生效时刻 —— 没给就说不清，不编
 *   · 上游的尺子还没走到那个时刻 —— 走过了就是「生效中」，不是「还没生效」
 *
 * 一个计划里多个权益的生效时刻不一样时，取最早的那个：那时候开始有额度。
 */
function zcodePendingPlan(
  plans: ZcodePlan[] | null,
  nowMs: number,
): PendingPlan | null {
  if (!plans) return null;
  let best: PendingPlan | null = null;
  for (const plan of plans) {
    if (String(plan.status ?? "").toLowerCase() !== "active") continue;
    const times = (plan.entitlements ?? [])
      .map((e) => (e?.effectiveAt ? Date.parse(String(e.effectiveAt)) : NaN))
      .filter((t) => Number.isFinite(t));
    // 生效时刻说不清：这个计划不当「还没生效」处理（也不编恢复时刻）。
    if (!times.length) continue;
    // 已经有一个权益生效了 → 这个计划在生效中。
    if (times.some((t) => t <= nowMs)) continue;
    const at = Math.min(...times);
    if (!best || at < best.effectiveAtMs) {
      best = {
        name: String(plan.name ?? ""),
        effectiveAtMs: at,
        grantUnits: (plan.entitlements ?? []).reduce(
          (sum, e) => sum + Number(e?.grantUnits ?? 0),
          0,
        ),
      };
    }
  }
  return best;
}

function zcodeQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  const probe = zcodeProbeOf(provider.id, snapshot);
  const view = (credits: QuotaView["credits"]): QuotaView[] => [
    { upstreamId: provider.platform, accountId: provider.id, credits },
  ];
  // 没有问过：面板上不摆额度卡 —— 摆一张全 0 的卡等于说「额度是 0」。
  if (!probe) return [];
  // 问到了，但不是答上来了：面板上不摆额度卡。
  //
  //   unauthorized  上游拒了这把令牌 —— 要人重新登录，不是额度的问题
  //   failed        这一轮问不到（网络、超时、5xx、看不懂的答复）
  //   missing       本地就没有会话，压根没问
  //
  // 三件事都不许折成「没额度」，也不许折成「额度是 0」：契约里 credits 只有
  // 数字加 note，没有「状态」这一格，于是数字那一格没有诚实的写法 —— 编一个 0
  // 等于说「额度用完了」，会把凭据那条线已经说清的事抵消掉。三种「不知道」各
  // 自另有承担：凭据被拒由凭据行承担（EXPIRED + detail），问不到由既有的
  // 「额度没问到」日志承担，上游状态也不再是绿的。
  //
  // 摆一张全 0 的卡正是本仓库栽过三次的那一类错误（spent 账号显示 ready、
  // checkedAt=0 显示成「还没签过」、no-snapshot 用例没真测到）：把「不知道」
  // 写成「没有」。
  if (probe.state === "unauthorized") return [];
  if (probe.state === "failed") return [];
  if (probe.state === "missing") return [];
  const buckets = zcodeBucketsOf(provider, snapshot);
  if (buckets === null) return [];
  // An empty list is the answer "spent", so the panel gets a card that says so
  // instead of no card at all. Showing nothing would read as "no quota here".
  //
  // 例外：空桶 + 一个领到了但还没生效的计划 —— 那是「已领到，今晚 23:00 生效」。
  // 这时摆的那张 0 卡是**真的**：现在可用的额度就是 0（还没生效，一分都用不了）。
  // 这和「凭据被拒却摆 0 卡」不是一回事：那一次我们对额度一无所知；这一次上游
  // 明确答复了额度领到了、还差多久生效。不要把它当成重复问题删掉。
  if (!buckets.length) {
    const pending = zcodePendingPlan(zcodePlansOf(provider, snapshot), zcodeServerNowMs(probe));
    if (pending) {
      return view({
        total: 0,
        used: 0,
        remaining: 0,
        lots: [],
        note:
          `已领到「${pending.name}」，${new Date(pending.effectiveAtMs).toISOString()} 生效` +
          `（${pending.grantUnits} token）`,
      });
    }
    // 领取那一格的话：今天为什么没领到（没名额 / 已领过 / 要验证码）。没有这一句
    // 时面板只说「用完了」，而真相可能是「今天压根没领」。
    const claimNote = zcodeClaimNote(provider.id, snapshot);
    return view({
      total: 0,
      used: 0,
      remaining: 0,
      lots: [],
      note: "套餐额度已用完（平台没有返回额度桶）" + (claimNote ? `；${claimNote}` : ""),
    });
  }
  return view({
    // Start Plan 的额度是 token 桶：它是一份「还剩多少 token」的额度。
    total: buckets.reduce((sum, b) => sum + Number(b.total ?? 0), 0),
    used: buckets.reduce((sum, b) => sum + Number(b.used ?? 0), 0),
    remaining: buckets.reduce((sum, b) => sum + Number(b.remaining ?? 0), 0),
    lots: buckets.map((b, i) => ({
      id: `zcode-bucket-${i}`,
      sourceLabel: b.showName || "额度桶",
      remaining: Number(b.remaining ?? 0),
      expiresAt: b.expiresAt ? Date.parse(String(b.expiresAt)) : 0,
      status: "有效",
    })),
    note: "Start Plan 的额度桶",
  });
}

registerKind({
  kind: "zcode",
  label: "ZCode",
  login: "browser",
  policies: ["single", "fallback"],
  baseUrl: () => ZCODE_MESSAGES_URL.replace(/\/anthropic\/v1\/messages$/, ""),
  // 推理用的就是凭据文件里那份 JWT：会话本身就是推理凭据。
  inferWith: "session",
  // 凭据只有登录会话（JWT 没有刷新通道，过期了只能重登）。
  //
  // refused 那一段：zcode 的 JWT 没有刷新通道，网关也换不了它，所以「上游拒了
  // 这把令牌」只能从问额度的那次答复里看出来。判据在 zcodeRefused。
  credentials: sessionOnlyPlan({
    title: "ZCode 的凭据",
    refused: (accountId) => zcodeRefused(accountId),
  }),
  credential: (provider) => {
    const view = fromUpstreamStatus(zcodeStatus(provider.id), "session");
    // 会话还在 ≠ 凭据可用：zcode 的 JWT 没有 exp，网关只能凭「在不在」答
    // authenticated，于是被上游拒掉的令牌在面板上显示成「凭据可用」。上游明说
    // 拒了，而且拒的是现在这一把 —— 那就是过期了，要人重新登录。
    if (!zcodeRefused(provider.id)) return view;
    return {
      ...view,
      status: CredentialState.EXPIRED,
      detail: "令牌被上游拒绝，需重新登录",
    };
  },
  models: () => zcodeCatalogModels(zcodeModelsInUse()),
  quotas: (provider, snapshot) => zcodeQuotas(provider, snapshot),
  outOfCredits: (provider, snapshot) => {
    const probe = zcodeProbeOf(provider.id, snapshot);
    // 没问过、问不到、本地没有会话：不知道不等于没钱。
    if (!probe || probe.state !== "ok") return false;
    const buckets = zcodeBucketsOf(provider, snapshot) ?? [];
    // Asked and not a single bucket: spent (see zcodeBucketsOf).
    //
    // 空桶 + 领到了但还没生效的计划 → 也是「现在用不了」（outOfCredits 为真）：
    // 现在确实一个字节都用不了，只是等一会儿就有了。区别体现在恢复时刻与
    // 额度卡的那句 note 上。
    if (!buckets.length) return true;
    return buckets.every((b: any) => Number(b.remaining ?? 0) <= 0);
  },
  recoverAt: (provider, snapshot) => {
    const probe = zcodeProbeOf(provider.id, snapshot);
    const buckets = zcodeBucketsOf(provider, snapshot) ?? [];
    // 没有桶：桶的到期时间无从谈起（用完就是用完）。除非有一个领到了、还没生效
    // 的计划 —— 那时候额度会在它生效的时刻回来，冷却到那一刻就放行。
    if (!buckets.length) {
      const pending = zcodePendingPlan(zcodePlansOf(provider, snapshot), zcodeServerNowMs(probe));
      return pending ? pending.effectiveAtMs : null;
    }
    // 额度桶的到期时间：最早到期的那个先回来。桶空了就是不知道 —— 没有桶
    // 就没有到期时间，不编一个。凭据被拒、问不到、没有会话同样不编。
    const now = Date.now();
    let soonest: number | null = null;
    for (const bucket of buckets) {
      for (const key of ["expiresAt", "periodEnd"]) {
        if (!bucket?.[key]) continue;
        const at = Date.parse(String(bucket[key]));
        if (!Number.isFinite(at) || at <= now) continue;
        if (soonest === null || at < soonest) soonest = at;
      }
    }
    return soonest;
  },
});
