// lib/admin/service/benefits.ts — 每日权益的方法分片。
//
// 从 service.ts 原样搬来。权益本体在 lib/benefits.ts，这里只把最近一轮的
// 结果摆成契约里的形状。

import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  BenefitStatusSchema,
  CheckinState,
  GetBenefitStatusResponseSchema,
  RunBenefitNowResponseSchema,
  AdminService,
} from "../../gen/agentfacade/admin/v1/admin_pb.ts";
import { listProviders } from "../../providers.ts";
import { benefits, platformHasBenefits } from "../benefits.ts";

export const benefitMethods: Partial<ServiceImpl<typeof AdminService>> = {
  async getBenefitStatus() {
    const state = benefits.lastRun;
    // 只有「签得到」的账号才进答复：平台那一种类没登记签到的（第三方开放
    // 平台那一族），在签到页上不占位置。判据在 lib/admin/benefits.ts 的
    // platformHasBenefits —— 前端不自己判种类。
    const accounts = listProviders().filter((row) => platformHasBenefits(row.platform));
    const benefitsOut = accounts.map((row) => {
      const accountId = row.id;
      // 签到是账号的事，但面板按平台分组展示：upstreamId 填账号所属的平台，
      // accountId 填账号本身，两者不能混（面板拿 upstreamId 去 join 平台行）。
      const platform = row.platform;
      const outcome = state.lastOutcome?.find((o) => o.upstream === accountId);
      if (!outcome) {
        // 没问过：今天签没签是「不知道」，不是「还没签」。
        return create(BenefitStatusSchema, {
          upstreamId: platform,
          accountId,
          summary: "今日签到状态未知",
          lines: [],
          checkedAt: 0n,
          credits: 0,
          ok: false,
          checkinState: CheckinState.UNKNOWN,
        });
      }
      // The summary is what the panel shows on the line: what happened, in
      // one line. Six answers, in this order: it did not work; the platform
      // does not tell us the check-in's state; the platform has no daily
      // check-in at all; it worked and brought credits; it worked (the
      // credits came earlier today); today it is not signed in.
      //
      // "Already claimed" is not one of them: that is an internal wording
      // and it belongs in the details (lines), not in the summary.
      //
      // The state is separate from the wording: the panel decides what to
      // show from the state, never by parsing this sentence.
      const summary = !outcome.ok
        ? "签到未成功"
        : outcome.statusUnavailable
          ? "今日签到状态未知"
          : outcome.noDailyCheckin
            ? "今日无签到"
            : outcome.signedIn && outcome.credits > 0
              ? `今日已签到 +${outcome.credits}`
              : outcome.signedIn
                ? "今日已签到"
                : "今日尚未签到";
      // The check-in itself decides the state, not the credits: a sign-in
      // that hands out nothing is still a sign-in. A run that did not get an
      // answer (network error, upstream blew up) leaves today's state unknown:
      // "we could not ask" is not "not signed yet".
      const checkinState = !outcome.ok
        ? CheckinState.UNKNOWN
        : outcome.statusUnavailable
          ? CheckinState.UNKNOWN
          : outcome.noDailyCheckin
            ? CheckinState.NOT_SIGNED
            : outcome.signedIn
              ? CheckinState.SIGNED
              : CheckinState.NOT_SIGNED;
      return create(BenefitStatusSchema, {
        upstreamId: platform,
        accountId,
        summary,
        lines: outcome.report,
        checkedAt: BigInt(Date.parse(outcome.at) || 0),
        credits: outcome.credits,
        ok: outcome.ok,
        checkinState,
      });
    });
    return create(GetBenefitStatusResponseSchema, { benefits: benefitsOut });
  },

  async runBenefitNow() {
    await benefits.runOnce();
    const outcomes = benefits.lastRun.lastOutcome ?? [];
    return create(RunBenefitNowResponseSchema, {
      ok: outcomes.length > 0 && outcomes.every((o) => o.ok),
      lines: outcomes.flatMap((o) => [`[${o.upstream}] ${o.report.join("；")}`]),
    });
  },
};
