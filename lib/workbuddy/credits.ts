// lib/workbuddy/credits.ts — what the WorkBuddy account has collected.
//
// The check-in status carries the numbers, and asking for it does not check in:
// the check-in is the other endpoint.

import { loadSession as loadWorkBuddySession } from "./auth.ts";
import { dataOf, workbuddyApi } from "./api.ts";
import {
  vendorFailed,
  vendorMissing,
  vendorOk,
  vendorUnauthorized,
  type VendorProbe,
} from "../provider-kinds.ts";

export interface WorkBuddyCredits {
  /** The credits the daily check-in hands out. */
  daily: number;
  /** What today's check-in brought in. */
  today: number;
  /** The credits the account has collected in total. */
  total: number;
  /** How many days in a row the account has shown up. */
  streakDays: number;
  /** Whether today is already checked in. */
  checkedIn: boolean;
}

export type WorkBuddyCreditsProbe = VendorProbe<WorkBuddyCredits>;

/**
 * 签到状态。401/403 是上游明说令牌不行；其余错误码（含 0 = 网络失败）
 * 只是这一轮问不到。上游没有单独的「token 失效」业务码，不硬造一个。
 */
export async function fetchWorkBuddyCredits(providerId = "workbuddy-cn"): Promise<WorkBuddyCreditsProbe> {
  const session = loadWorkBuddySession(providerId);
  if (!session) return vendorMissing();
  try {
    const res = await workbuddyApi(session, "/v2/billing/meter/checkin-activity-status", "POST", undefined, providerId);
    if (res.status === 401 || res.status === 403) {
      return vendorUnauthorized(`上游拒绝了这把令牌（HTTP ${res.status}）`);
    }
    if (res.status !== 200) return vendorFailed(`上游答了 HTTP ${res.status}`);
    const data = dataOf(res.body);
    if (!data) return vendorFailed("上游的答复里没有数据");
    return vendorOk({
      daily: Number(data.daily_credit ?? 0),
      today: Number(data.today_credit ?? 0),
      total: Number(data.total_credits ?? 0),
      streakDays: Number(data.streak_days ?? 0),
      checkedIn: data.today_checked_in === true,
    });
  } catch (e) {
    return vendorFailed(`问不到签到状态：${(e as Error)?.message ?? String(e)}`);
  }
}
