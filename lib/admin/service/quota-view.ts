// lib/admin/service/quota-view.ts — 额度那一格在面板上的形状与结论。
//
// 从 service.ts 上半原样搬来。数字与三格结论（状态、恢复时刻、一句话）一起走：
// 面板靠它们回答「为什么这里没有数字」。只读快照，不现问上游。

import { create } from "@bufbuild/protobuf";
import {
  BalanceLotSchema,
  BalanceSummarySchema,
  CreditLotSchema,
  CreditSummarySchema,
  TokenPlanSchema,
  TokenPlanWindowSchema,
  UpstreamQuotaSchema,
  type UpstreamQuota,
} from "../../gen/agentfacade/admin/v1/admin_pb.ts";
import { peekHealthSnapshot } from "../../health-cache.ts";
import { quotaConclusionOf, quotaPluginIdOf, type QuotaConclusion } from "../../quota-state.ts";
import { accountsOfPlatform, provider, type ProviderRow } from "../../providers.ts";
import { isPlatform } from "../../platforms.ts";
import { listProviders } from "../../providers.ts";
import type { HealthSnapshot, QuotaView } from "../upstreams.ts";
import { percentInt, wholeMs } from "./shared.ts";
/**
 * 一个额度摘要。
 *
 * 三格结论（状态、恢复时刻、一句话）与数字一起走：面板靠它们回答「为什么这里
 * 没有数字」。没有结论就是空串 / 0 / 空串。
 */
export function quotaMessage(quota: QuotaView, conclusion?: QuotaConclusion | null) {
  return create(UpstreamQuotaSchema, {
    upstreamId: quota.upstreamId,
    accountId: quota.accountId,
    // 账号的名字：面板拿它当卡片标题，空串时退回显示 id。
    accountName: quota.accountName ?? "",
    // 余额（钱）。只有中转站这类平台有。
    balance: quota.balance
      ? create(BalanceSummarySchema, {
          availableCny: quota.balance.availableCny,
          currency: quota.balance.currency,
          lots: quota.balance.lots.map((lot) =>
            create(BalanceLotSchema, {
              id: lot.id,
              sourceLabel: lot.sourceLabel,
              remainingCny: lot.remainingCny,
              // int64 的时间戳：上游给的是浮点毫秒，BigInt 会抛。
              expiresAt: BigInt(wholeMs(lot.expiresAt)),
              status: lot.status,
            }),
          ),
          nextExpiryAt: BigInt(wholeMs(quota.balance.nextExpiryAt)),
          expiringCny: quota.balance.expiringCny,
        })
      : undefined,
    // 积分（点数）。跟余额不是一回事。
    credits: quota.credits
      ? create(CreditSummarySchema, {
          total: quota.credits.total,
          used: quota.credits.used,
          remaining: quota.credits.remaining,
          lots: quota.credits.lots.map((lot) =>
            create(CreditLotSchema, {
              id: lot.id,
              sourceLabel: lot.sourceLabel,
              remaining: lot.remaining,
              expiresAt: BigInt(wholeMs(lot.expiresAt)),
              status: lot.status,
            }),
          ),
          note: quota.credits.note,
        })
      : undefined,
    // 套餐额度：只有 MiniMax 有别的上游不带这个。
    tokenPlan: quota.tokenPlan
      ? create(TokenPlanSchema, {
          windows: quota.tokenPlan.windows.map((window) =>
            create(TokenPlanWindowSchema, {
              label: window.label,
              // proto 的这两个字段是 int32：百分比是算出来的小数，不取整会让
              // 整个面板解码失败（2026-10-28 真出过）。
              intervalPercent: percentInt(window.intervalPercent),
              weeklyPercent: percentInt(window.weeklyPercent),
              intervalEndsAt: BigInt(wholeMs(window.intervalEndsAt)),
              weeklyEndsAt: BigInt(wholeMs(window.weeklyEndsAt)),
            }),
          ),
        })
      : undefined,
    // 这一次问额度的结论：状态原样透出，恢复时刻不知道就是 0，一句话没有就是
    // 空串。认不出的状态与「没有结论」都落到空串 —— 契约说空串是「没有结论」。
    quotaState: conclusion?.state ?? "",
    // 这个数与路由 402/503 那句是同一个：都由 accountRecoveryAtMs 算
    // （lib/admin/platform-state.ts），这里不再自己取一份。
    recoverAtMs: BigInt(wholeMs(conclusion?.recoverAtMs ?? 0)),
    message: conclusion?.message ?? "",
  });
}
/**
 * 现在的额度快照。
 *
 * 只读：面板这一次拿快照里那一份，问问上游是后台扫描的事（lib/admin/upstreams.ts）。
 */
function quotaSnapshot(): HealthSnapshot | null {
  return peekHealthSnapshot<HealthSnapshot>()?.data ?? null;
}
export function conclusionOfRow(row: ProviderRow | null | undefined): QuotaConclusion | null {
  if (!row) return null;
  const conclusion = quotaConclusionOf(row, quotaSnapshot(), quotaPluginIdOf(row));
  return conclusion.state ? conclusion : null;
}
/**
 * 额度那一格报什么。
 *
 * 只要有结论就报：状态、恢复时刻、一句话三格回答「为什么这里没有数字」。见底、
 * 账号不能用、凭据被拒、被限流、没填凭据、问不到 —— 六种都是结论，面板按状态
 * 说话。只放行前两种的话，后四种在面板上一律是一个「—」，前端按七种状态写的那
 * 一半是死代码。
 *
 * 没有结论（没指名插件、插件没登记、快照里没这一份）才不报这一格：那不是「问
 * 过了没数字」，是没人去问。
 */
export function quotaAnswerOf(quota: QuotaView | null, row: ProviderRow | null): UpstreamQuota | undefined {
  const conclusion = conclusionOfRow(row);
  if (quota) return quotaMessage(quota, conclusion);
  if (!row || !conclusion) return undefined;
  // 没有数字的那一份只要归属与结论：upstreamId 是平台（面板按它分组），
  // accountId 是这个账号。
  return quotaMessage({ upstreamId: row.platform, accountId: row.id, accountName: row.alias ?? "" }, conclusion);
}
/**
 * 平台这一行按住哪个账号的结论。
 *
 * 有数字时就是那份额度所属的账号；没有数字时报名下第一个有结论的那个 ——
 * 面板要能说清这个平台为什么没有数字。
 */
export function quotaRowOfPlatform(rows: ProviderRow[], quota: QuotaView | null): ProviderRow | null {
  if (quota) return rows.find((row) => row.id === quota.accountId) ?? null;
  return rows.find((row) => conclusionOfRow(row) !== null) ?? null;
}
/**
 * 这一次 GetBalance 要报哪些账号。
 *
 * 指定了上游就只报它名下的：平台 id 报全部账号，账号 id 就报那一个。
 */
export function balanceScope(wanted: string): ProviderRow[] {
  if (!wanted) return listProviders();
  if (isPlatform(wanted)) return accountsOfPlatform(wanted);
  const row = provider(wanted);
  return row ? [row] : [];
}
