import { ZcodeClaimOutcome } from '@/gen/agentfacade/admin/v1/admin_pb'
import type { ClaimZcodePlanResponse } from '@/gen/agentfacade/admin/v1/admin_pb'
import type { CaptchaFailureStage } from '@/features/upstreams/aliyun-captcha'
import type { TFunction } from 'i18next'

/**
 * 领取的结论怎么说人话。
 *
 * 每一档的语气是结论本身给的吗？不是的话不能瞎说：
 * UNKNOWN 只说「不知道结果」，不说「没有领到」；拿不到验证码配置时也不说
 * 「不需要验证码」。这一条踩过三次，这里不许再犯。
 */
export interface ClaimWording {
  /** 摆给操作者看的那句话。 */
  text: string
  /** 是错误吗？ALREADY / NO_OFFER / UNKNOWN 都不是错误。 */
  error: boolean
}

/** 整毫秒 → `HH:00 生效`。后端没给（0）就不带这一截。 */
function effectiveText(ms: bigint, t: TFunction): string {
  if (ms <= 0n) return ''
  const date = new Date(Number(ms))
  if (Number.isNaN(date.getTime())) return ''
  return t('upstreams.claimEffectiveAt', {
    time: `${String(date.getHours()).padStart(2, '0')}:00`,
  })
}

/** 服务端那六种结论 → 面板文案。 */
export function wordingOf(
  result: ClaimZcodePlanResponse,
  t: TFunction
): ClaimWording {
  switch (result.outcome) {
    case ZcodeClaimOutcome.CLAIMED: {
      const plan = result.planName ? `「${result.planName}」` : ''
      const at = effectiveText(result.effectiveAtMs, t)
      // 有名字、有时刻就都带上；缺哪一样都不替后端编。
      const detail = [plan, at].filter(Boolean).join('，')
      return {
        text: t('upstreams.claimClaimed', {
          detail: detail
            ? t('upstreams.claimClaimedDetail', { detail })
            : '',
        }),
        error: false,
      }
    }
    case ZcodeClaimOutcome.ALREADY:
      return { text: t('upstreams.claimAlready'), error: false }
    case ZcodeClaimOutcome.CAPTCHA_REJECTED:
      return {
        text: t('upstreams.claimCaptchaRejected'),
        error: true,
      }
    case ZcodeClaimOutcome.NO_OFFER:
      return { text: t('upstreams.claimNoOffer'), error: false }
    case ZcodeClaimOutcome.FAILED:
      return {
        text: result.upstreamMessage
          ? t('upstreams.claimFailed', { message: result.upstreamMessage })
          : t('upstreams.claimFailedPlain'),
        error: true,
      }
    default:
      // UNKNOWN 以及服务端没见过的枚举值：不知道，绝不是「没有」。
      return {
        text: result.message || t('upstreams.claimUnknown'),
        error: false,
      }
  }
}

/** 浏览器这一步（还没发领取请求）失败怎么说。 */
export function wordingOfCaptcha(
  stage: CaptchaFailureStage,
  t: TFunction
): ClaimWording {
  switch (stage) {
    case 'script':
      return {
        text: t('upstreams.claimScriptFail'),
        error: true,
      }
    case 'init':
      return {
        text: t('upstreams.claimInitFail'),
        error: true,
      }
    case 'timeout':
      // 等不到结果 ≠ 校验没过。
      return { text: t('upstreams.claimTimeout'), error: false }
    case 'device':
    case 'verification':
      return {
        text: t('upstreams.claimCaptchaRejected'),
        error: true,
      }
  }
}
