import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { formatLocalMoment } from '@/lib/format'
import { CheckinState, type BenefitStatus } from '@/gen/buddy/admin/v1/admin_pb'

/** 明细区的 id：展开时 `aria-controls` 指过来。 */
function detailId(upstreamId: string): string {
  return `checkin-detail-${upstreamId}`
}

/**
 * 平台行的状态：这一家名下各账号的签到状态合成一句。
 *
 * 判断只看后端给的状态（checkin_state），不看那句中文摘要 —— 摘要是给人
 * 看的，改文案不该改这里的判断。
 *
 * 「不知道」不许显示成「还没签」：没问过与问出来「没签」是两件事。
 */
function platformStateText(benefits: BenefitStatus[]): string {
  const total = benefits.length
  if (total === 0) return '今日签到状态未知'
  const signed = benefits.filter(
    (benefit) => benefit.checkinState === CheckinState.SIGNED,
  ).length
  const unknown = benefits.filter(
    (benefit) => benefit.checkinState === CheckinState.UNKNOWN,
  ).length
  if (signed === total) return '今日已签到'
  // 有账号不知道签没签，而其余的又没签全：不能替它说「还没签」。
  if (unknown > 0) return '今日签到状态未知'
  if (signed > 0) return `${total} 个账号中 ${signed} 个已签到`
  return '今日尚未签到'
}

/**
 * 一个平台一行，收起时给状态。
 *
 * 行上写平台名、后端给的状态与这次加了多少点；点这一行才展开看逐账号的明细
 * 与签到时刻。默认收起：平台多的时候一屏能看全。
 */
export function PlatformCheckinRow({
  upstreamId,
  title,
  benefits,
  accountAliases,
}: {
  upstreamId: string
  /** 行标题：平台的显示名，没有就是 id。 */
  title: string
  /** 这一家平台的签到结论，一个账号一条。 */
  benefits: BenefitStatus[]
  /** 账号 id → 别名。拿不到别名的账号退回显示 id。 */
  accountAliases: Map<string, string>
}) {
  const [expanded, setExpanded] = useState(false)
  const id = detailId(upstreamId)
  const credits = benefits.reduce((total, benefit) => total + benefit.credits, 0)

  return (
    <li aria-label={`${upstreamId} 签到行`} className='rounded-lg border'>
      <button
        type='button'
        aria-label={`${upstreamId} 签到`}
        aria-expanded={expanded}
        aria-controls={expanded ? id : undefined}
        onClick={() => setExpanded((open) => !open)}
        className='flex w-full items-start justify-between gap-3 rounded-lg px-4 py-3 text-left hover:bg-muted/50'
      >
        <span className='grid min-w-0 gap-1'>
          <span className='text-sm font-medium'>{title}</span>
          <span aria-label={`${upstreamId} 签到摘要`} className='text-xs text-muted-foreground'>
            {platformStateText(benefits)}
          </span>
        </span>
        <span className='flex min-w-0 items-center gap-2'>
          {credits > 0 ? <Badge>+{credits} 点</Badge> : null}
          <ChevronDown
            aria-hidden='true'
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-180',
            )}
          />
        </span>
      </button>

      {expanded ? (
        <div
          id={id}
          role='region'
          aria-label={`${upstreamId} 签到明细`}
          className='grid gap-2 border-t px-6 py-4'
        >
          {benefits.map((benefit) => {
            const label =
              accountAliases.get(benefit.accountId)?.trim() ||
              benefit.accountId
            return (
              <div
                key={benefit.accountId}
                aria-label={`${upstreamId} ${label} 签到明细条目`}
                className='grid gap-0.5 text-sm'
              >
                <span className='font-medium'>{label}</span>
                {benefit.summary.trim() ? (
                  <span className='text-muted-foreground'>
                    {benefit.summary}
                  </span>
                ) : null}
                {benefit.lines.length > 0 ? (
                  <ul className='grid gap-0.5 text-muted-foreground'>
                    {benefit.lines.map((line, index) => (
                      <li key={`${index}-${line}`} className='break-words'>
                        {line}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <span className='text-xs text-muted-foreground'>
                  {benefit.checkedAt > 0n
                    ? `上次签到 ${formatLocalMoment(benefit.checkedAt)}`
                    : '还没签过'}
                </span>
              </div>
            )
          })}
        </div>
      ) : null}
    </li>
  )
}
