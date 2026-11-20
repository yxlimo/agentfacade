import { create } from '@bufbuild/protobuf'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ClaimZcodePlanRequestSchema,
  GetZcodeClaimStatusRequestSchema,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import type { MessageInitShape } from '@bufbuild/protobuf'
import type {
  GetZcodeClaimStatusResponse,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { useAdminClient } from '@/features/auth/client-provider'
import { queryKeys } from '@/lib/query-keys'
import { invalidateServerData } from '@/lib/server-data'

/**
 * ZCode 活动额度的领取状态。
 *
 * 一个账号一份：按钮只在 `captchaAvailable` 为真且后端给了 offer 时显示 ——
 * 其它情况（配置没下发、问不到、没有投放）都不是「可以领」。
 */
export function useZcodeClaimStatus(input: {
  providerId: string
  enabled: boolean
}) {
  const client = useAdminClient()
  return useQuery({
    queryKey: queryKeys.zcodeClaim.of(input.providerId),
    queryFn: () =>
      client.getZcodeClaimStatus(
        create(GetZcodeClaimStatusRequestSchema, {
          providerId: input.providerId,
        })
      ),
    enabled: input.enabled,
  })
}

/**
 * 领一次。
 *
 * `captchaVerifyParam` 由浏览器里的无感校验给出，是一次性的；`captchaRegion`
 * 只在配置里有时带。领完三摊数据一起失效：额度（积分真的变了）、这个账号的
 * 领取状态（按钮变「已领取」）、平台列表（账号行上带着额度快照）。
 */
export function useClaimZcodePlan() {
  const client = useAdminClient()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: MessageInitShape<typeof ClaimZcodePlanRequestSchema>) =>
      client.claimZcodePlan(create(ClaimZcodePlanRequestSchema, input)),
    onSettled: () => {
      invalidateServerData(queryClient, 'zcodeClaim', 'quotas')
    },
  })
}

/** 当前可领的那一个：按后端给的 priority 取最靠前的一份。 */
export function pickOffer(status: GetZcodeClaimStatusResponse) {
  const offers = status.offers.slice().sort((a, b) => a.priority - b.priority)
  return offers[0]
}
