// lib/admin/service/zcode.ts — ZCode 活动额度领取的方法分片。
//
// 从 service.ts 原样搬来。领取本体在 lib/admin/zcode-claim.ts，这里只把
// 契约里的字段摆过去。

import type { ServiceImpl } from "@connectrpc/connect";
import { AdminService } from "../../gen/agentfacade/admin/v1/admin_pb.ts";
import { claimZcodePlan, getZcodeClaimStatus } from "../zcode-claim.ts";

export const zcodeMethods: Partial<ServiceImpl<typeof AdminService>> = {
  async getZcodeClaimStatus(request) {
    return getZcodeClaimStatus(String(request.providerId ?? ""));
  },

  async claimZcodePlan(request) {
    return claimZcodePlan({
      accountId: String(request.providerId ?? ""),
      planId: String(request.planId ?? ""),
      campaignId: String(request.campaignId ?? ""),
      captchaVerifyParam: String(request.captchaVerifyParam ?? ""),
      captchaRegion: String(request.captchaRegion ?? ""),
    });
  },
};
