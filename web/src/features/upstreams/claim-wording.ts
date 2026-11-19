import { ZcodeClaimOutcome } from '@/gen/agentfacade/admin/v1/admin_pb'
import type { ClaimZcodePlanResponse } from '@/gen/agentfacade/admin/v1/admin_pb'
import type { CaptchaFailureStage } from '@/features/upstreams/aliyun-captcha'

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
function effectiveText(ms: bigint): string {
  if (ms <= 0n) return ''
  const date = new Date(Number(ms))
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:00 生效`
}

/** 服务端那六种结论 → 面板文案。 */
export function wordingOf(result: ClaimZcodePlanResponse): ClaimWording {
  switch (result.outcome) {
    case ZcodeClaimOutcome.CLAIMED: {
      const plan = result.planName ? `「${result.planName}」` : ''
      const at = effectiveText(result.effectiveAtMs)
      // 有名字、有时刻就都带上；缺哪一样都不替后端编。
      const detail = [plan, at].filter(Boolean).join('，')
      return { text: `已领到${detail ? ` ${detail}` : ''}`, error: false }
    }
    case ZcodeClaimOutcome.ALREADY:
      return { text: '已经领过了', error: false }
    case ZcodeClaimOutcome.CAPTCHA_REJECTED:
      return {
        text: '这台浏览器没能通过验证码，建议去官方客户端点一次',
        error: true,
      }
    case ZcodeClaimOutcome.NO_OFFER:
      return { text: '此刻没有可领的', error: false }
    case ZcodeClaimOutcome.FAILED:
      return {
        text: result.upstreamMessage
          ? `领取失败：${result.upstreamMessage}`
          : '领取失败',
        error: true,
      }
    default:
      // UNKNOWN 以及服务端没见过的枚举值：不知道，绝不是「没有」。
      return {
        text: result.message || '这次领取的结果还不知道，请稍后再看',
        error: false,
      }
  }
}

/** 浏览器这一步（还没发领取请求）失败怎么说。 */
export function wordingOfCaptcha(stage: CaptchaFailureStage): ClaimWording {
  switch (stage) {
    case 'script':
      return {
        text: '没能加载验证码脚本，暂时无法领取',
        error: true,
      }
    case 'init':
      return {
        text: '验证码没能启动，暂时无法领取',
        error: true,
      }
    case 'timeout':
      // 等不到结果 ≠ 校验没过。
      return { text: '这次验证码的结果还不知道，请稍后再试', error: false }
    case 'device':
    case 'verification':
      return {
        text: '这台浏览器没能通过验证码，建议去官方客户端点一次',
        error: true,
      }
  }
}
