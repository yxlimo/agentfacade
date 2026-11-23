// lib/admin/service/balance.ts — GetBalance 的方法分片。
//
// 从 service.ts 原样搬来。指定平台就只刷它名下的账号，没指定就整轮刷新一次；
// 没有数字但有结论的账号也报一条 —— 六种状态都不是 0，面板要看得见状态与那句话。

import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import { AdminService, GetBalanceResponseSchema, type UpstreamQuota } from "../../gen/agentfacade/admin/v1/admin_pb.ts";
import { freshHealthSnapshot, upstreamQuotas } from "../upstreams.ts";
import { balanceScope, conclusionOfRow, quotaAnswerOf, quotaMessage } from "./quota-view.ts";

export const balanceMethods: Partial<ServiceImpl<typeof AdminService>> = {
  async getBalance(request) {
    const wanted = String(request.upstreamId ?? "");
    const rows = balanceScope(wanted);
    const quotas: UpstreamQuota[] = [];
    // 已经有数字的账号：下面只给没有数字的那些补一条原因。
    const withNumbers = new Set<string>();
    if (wanted) {
      // 问一个平台：只刷这个平台名下的账号，不碰别人。
      for (const quota of await upstreamQuotas(wanted, true, Boolean(request.force))) {
        const row = rows.find((r) => r.id === quota.accountId) ?? null;
        quotas.push(quotaMessage(quota, conclusionOfRow(row)));
        withNumbers.add(quota.accountId);
      }
    } else {
      // 没指定平台：整轮刷新一次（一次就够），然后从快照里读。
      await freshHealthSnapshot(Boolean(request.force));
      for (const row of rows) {
        for (const quota of await upstreamQuotas(row.id)) {
          quotas.push(quotaMessage(quota, conclusionOfRow(row)));
          withNumbers.add(quota.accountId);
        }
      }
    }
    // 没有数字但有结论的账号也报一条：见底、不能用、凭据被拒、被限流、没填
    // 凭据、问不到 —— 六种都不是 0，面板要看得见状态与那句话，而不是一行零。
    for (const row of rows) {
      if (withNumbers.has(row.id)) continue;
      const answer = quotaAnswerOf(null, row);
      if (answer) quotas.push(answer);
    }
    return create(GetBalanceResponseSchema, { quotas });
  },
};
