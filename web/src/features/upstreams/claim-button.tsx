import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { runTracelessVerification } from '@/features/upstreams/aliyun-captcha'
import { wordingOf, wordingOfCaptcha } from '@/features/upstreams/claim-wording'
import { useClaimZcodePlan, useZcodeClaimStatus } from '@/features/upstreams/claim'
import type { Account } from '@/gen/agentfacade/admin/v1/admin_pb'
import type { ClaimWording } from '@/features/upstreams/claim-wording'

/**
 * zcode 账号那一行上的「领取」。
 *
 * 按钮与隐藏容器都在这个组件里：SDK 要求 element/button 两个节点真在页面上，
 * 所以点之前它们必须已经挂载，不能等回调里再建。
 *
 * 显示条件只看后端给的那份状态：`captchaAvailable` 为真且有 offer 才出现。
 * 配置不知道（没下发 / 问不到）时这里什么都不显示 —— 「不知道」不是「不能领」
 * 也不是「能领」。
 */
export function ClaimButton({
  account,
  platform,
  enabled,
}: {
  account: Account
  /** 这个账号所在的平台 id：只有 zcode 才取领取状态。 */
  platform: string
  /** 这一行能不能操作（列表正在重取时别点）。 */
  enabled: boolean
}) {
  const status = useZcodeClaimStatus({
    providerId: account.id,
    enabled: enabled && platform === 'zcode',
  })
  const claim = useClaimZcodePlan()
  const elementRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const [result, setResult] = useState<ClaimWording | null>(null)
  // SDK 只认 CSS 选择器字符串，节点 id 在同一页面里固定且唯一。
  const elementSelector = '#zcode-captcha-element'
  const buttonSelector = '#zcode-captcha-button'

  if (platform !== 'zcode') return null
  if (status.isPending || status.isError) return null

  const data = status.data
  if (!data?.captchaAvailable || data.offers.length === 0) return null

  const offers = [...data.offers].sort((a, b) => a.priority - b.priority)
  const offer = offers[0]
  if (!offer || offer.alreadyClaimed) {
    return <span className='text-xs text-muted-foreground'>已领取</span>
  }

  const captcha = data.captcha
  const running = claim.isPending

  const onClick = async () => {
    if (running || !captcha) return
    setResult(null)
    if (!elementRef.current || !buttonRef.current) {
      setResult(wordingOfCaptcha('init'))
      return
    }
    const verification = await runTracelessVerification({
      sceneId: captcha.sceneId,
      prefix: captcha.prefix,
      region: captcha.region,
      element: elementSelector,
      button: buttonSelector,
    })
    if (!verification.ok) {
      setResult(wordingOfCaptcha(verification.stage))
      return
    }
    const interactiveNotice = verification.interactive
      ? '这台浏览器不支持无感验证，已用交互式验证码通过'
      : ''
    try {
      const answer = await claim.mutateAsync({
        providerId: account.id,
        planId: offer.planId,
        campaignId: offer.campaignId,
        captchaVerifyParam: verification.param,
        // 上游没给 region 时契约里这一格是空串，不是「随便填一个」。
        captchaRegion: captcha.region,
      })
      const answerWording = wordingOf(answer)
      setResult(
        interactiveNotice
          ? { text: `${interactiveNotice}；${answerWording.text}`, error: answerWording.error }
          : answerWording
      )
    } catch {
      // 传输层失败（连不上网关）时服务端没给结论，不说「没领到」。
      const unknown = { text: '这次领取的结果还不知道，请稍后再看', error: false }
      setResult(interactiveNotice ? { text: `${interactiveNotice}；${unknown.text}`, error: false } : unknown)
    }
  }

  return (
    <span className='inline-flex flex-col items-end gap-0.5'>
      {/* SDK 要求容器与按钮节点都存在，所以这一格始终挂在 DOM 上，只是不可见。 */}
      <div
        ref={elementRef}
        id={elementSelector.slice(1)}
        aria-hidden='true'
        className='pointer-events-none absolute h-0 w-0 overflow-hidden'
      />
      <Button
        ref={buttonRef}
        id={buttonSelector.slice(1)}
        size='sm'
        disabled={running || !enabled}
        onClick={() => void onClick()}
      >
        {running ? <Loader2 className='animate-spin' /> : null}
        {running ? '领取中' : '领取'}
      </Button>
      {result ? (
        <span
          role='status'
          data-tone={result.error ? 'error' : 'neutral'}
          className={`max-w-64 text-xs ${result.error ? 'text-destructive' : 'text-muted-foreground'}`}
        >
          {result.text}
        </span>
      ) : null}
    </span>
  )
}
