import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { formatLocalMoment } from '@/lib/format'
import i18n from '@/lib/i18n'
import { CheckinState, type BenefitStatus } from '@/gen/agentfacade/admin/v1/admin_pb'

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
  if (total === 0) return i18n.t('benefits.stateUnknown')
  const signed = benefits.filter(
    (benefit) => benefit.checkinState === CheckinState.SIGNED,
  ).length
  const unknown = benefits.filter(
    (benefit) => benefit.checkinState === CheckinState.UNKNOWN,
  ).length
  if (signed === total) return i18n.t('benefits.stateDone')
  // 有账号不知道签没签，而其余的又没签全：不能替它说「还没签」。
  if (unknown > 0) return i18n.t('benefits.stateUnknown')
  if (signed > 0)
    return i18n.t('benefits.statePartial', { total, signed })
  return i18n.t('benefits.stateNotYet')
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
  const { t } = useTranslation()
  const id = detailId(upstreamId)
  const credits = benefits.reduce((total, benefit) => total + benefit.credits, 0)

  return (
    <li
      aria-label={t('benefits.platformRow', { id: upstreamId })}
      className='rounded-lg border'
    >
      <button
        type='button'
        aria-label={t('benefits.platform', { id: upstreamId })}
        aria-expanded={expanded}
        aria-controls={expanded ? id : undefined}
        onClick={() => setExpanded((open) => !open)}
        className='flex w-full items-start justify-between gap-3 rounded-lg px-4 py-3 text-left hover:bg-muted/50'
      >
        <span className='grid min-w-0 gap-1'>
          <span className='text-sm font-medium'>{title}</span>
          <span
            aria-label={t('benefits.platformSummary', { id: upstreamId })}
            className='text-xs text-muted-foreground'
          >
            {platformStateText(benefits)}
          </span>
        </span>
        <span className='flex min-w-0 items-center gap-2'>
          {credits > 0 ? (
            <Badge>{t('benefits.points', { n: credits })}</Badge>
          ) : null}
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
          aria-label={t('benefits.platformDetails', { id: upstreamId })}
          className='grid gap-2 border-t px-6 py-4'
        >
          {benefits.map((benefit) => {
            const label =
              accountAliases.get(benefit.accountId)?.trim() ||
              benefit.accountId
            return (
              <div
                key={benefit.accountId}
                aria-label={t('benefits.detailEntry', { id: upstreamId, label })}
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
                {benefit.checkedAt > 0n ? (
                  <span className='text-xs text-muted-foreground'>
                    {t(
                      benefit.checkinState === CheckinState.UNKNOWN
                        ? 'benefits.lastChecked'
                        : 'benefits.lastCheckin',
                      { time: formatLocalMoment(benefit.checkedAt) },
                    )}
                  </span>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : null}
    </li>
  )
}
