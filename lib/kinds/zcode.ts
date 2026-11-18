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
import { zcodeModelsInUse } from "../zcode/models.ts";
import { ZCODE_MESSAGES_URL } from "../zcode/transport.ts";
import { peekHealthSnapshot } from "../health-cache.ts";
import { CredentialState } from "../gen/agentfacade/admin/v1/admin_pb.ts";
import type { ZcodeQuota } from "../zcode/credits.ts";

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
 */
function zcodeRefused(providerId: string, snapshot?: HealthSnapshot | null): boolean {
  const probe = zcodeProbeOf(providerId, snapshot ?? currentSnapshot());
  if (probe?.state !== "unauthorized") return false;
  const loginAtMs = loadSession(providerId)?.loginAtMs ?? 0;
  if (!loginAtMs) return false;
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

function zcodeQuotas(provider: ProviderRow, snapshot: HealthSnapshot): QuotaView[] {
  const probe = zcodeProbeOf(provider.id, snapshot);
  const view = (credits: QuotaView["credits"]): QuotaView[] => [
    { upstreamId: provider.platform, accountId: provider.id, credits },
  ];
  // 没有问过：面板上不摆额度卡 —— 摆一张全 0 的卡等于说「额度是 0」。
  if (!probe) return [];
  // 问到了，但不是答上来了：面板上要说清是哪一种「没有数字」。
  //
  //   unauthorized  上游拒了这把令牌 —— 要人重新登录，不是额度的问题
  //   failed        这一轮问不到（网络、超时、5xx、看不懂的答复）
  //   missing       本地就没有会话，压根没问
  //
  // 三件事都不许折成「没额度」：折掉之后面板上就是一片空白，等于告诉用户这个
  // 账号正常，而下一次请求就会吃 401。
  if (probe.state === "unauthorized") {
    return view({ total: 0, used: 0, remaining: 0, lots: [], note: `凭据被拒，需重新登录（${probe.message}）` });
  }
  if (probe.state === "failed") {
    return view({ total: 0, used: 0, remaining: 0, lots: [], note: `额度没问到：${probe.message}` });
  }
  if (probe.state === "missing") {
    return view({ total: 0, used: 0, remaining: 0, lots: [], note: "没有登录会话，未向平台问额度" });
  }
  const buckets = zcodeBucketsOf(provider, snapshot);
  if (buckets === null) return [];
  // An empty list is the answer "spent", so the panel gets a card that says so
  // instead of no card at all. Showing nothing would read as "no quota here".
  if (!buckets.length) {
    return view({
      total: 0,
      used: 0,
      remaining: 0,
      lots: [],
      note: "套餐额度已用完（平台没有返回额度桶）",
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
    if (!buckets.length) return true;
    return buckets.every((b: any) => Number(b.remaining ?? 0) <= 0);
  },
  recoverAt: (provider, snapshot) => {
    // 额度桶的到期时间：最早到期的那个先回来。桶空了就是不知道 —— 没有桶
    // 就没有到期时间，不编一个。凭据被拒、问不到、没有会话同样不编。
    const buckets = zcodeBucketsOf(provider, snapshot) ?? [];
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
