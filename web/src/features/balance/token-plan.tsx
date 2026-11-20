import { useTranslation } from 'react-i18next'
import { type TokenPlanWindow } from '@/gen/agentfacade/admin/v1/admin_pb'
import { Progress } from '@/components/ui/progress'
import { formatDateTime } from '@/lib/format'
import i18n from '@/lib/i18n'
import type { zh } from '@/lib/i18n/catalogs/zh'

/** 窗口的名字。视频窗口后端已经无视（网关只服务文本模型），这里不再有它。 */
const WINDOW_LABELS: Record<string, keyof typeof zh> = {
  general: 'balance.windowGeneral',
}

/** 两个窗口的名字：interval 是 5 小时那个，weekly 是每周那个。 */
export const INTERVAL_WINDOW_LABEL = () => i18n.t('balance.windowInterval')
export const WEEKLY_WINDOW_LABEL = () => i18n.t('balance.windowWeekly')

/** 窗口的名字给人看。认不出来就原样显示，不猜。 */
export function windowLabel(label: string): string {
  const key = WINDOW_LABELS[label]
  return key ? i18n.t(key) : label
}

/** 剩余百分比：越少越红。 */
function percentTone(percent: number): string {
  if (percent <= 10) return 'text-destructive'
  if (percent <= 30) return 'text-amber-600 dark:text-amber-400'
  return 'text-foreground'
}

/**
 * 距离重置还有多久。
 *
 * 平台给的是 unix 毫秒时间戳。已经到点就等后端刷新。
 */
export function remainingUntil(endsAt: bigint): string {
  const diff = Number(endsAt) - Date.now()
  if (diff <= 0) return i18n.t('balance.waitRefresh')
  const hours = Math.floor(diff / 3_600_000)
  if (hours < 1) {
    return i18n.t('balance.leftMinutes', {
      count: Math.max(1, Math.round(diff / 60_000)),
    })
  }
  const minutes = Math.floor((diff % 3_600_000) / 60_000)
  return i18n.t('balance.leftHoursMinutes', { hours, minutes })
}

/**
 * 套餐额度：MiniMax 的 5 小时窗口与周窗口各剩多少。
 *
 * 平台给的是「还剩多少个百分点」，所以 100 是全满。
 */
export function TokenPlanPanel({
  windows,
}: {
  windows: TokenPlanWindow[]
}) {
  const { t } = useTranslation()
  if (windows.length === 0) return null

  return (
    <div className='grid gap-4'>
      {windows.map((window, index) => {
        const name = windowLabel(window.label)
        // 认得出的名字（general）旁边再写一遍原名；认不出来的
        // （SenseNova 的池子名）就只写一次。
        const raw = window.label && window.label !== name ? window.label : ''
        return (
        <div
          key={`${window.label}-${index}`}
          className='rounded-lg border p-3'
        >
          <div className='mb-3 flex items-center justify-between gap-2'>
            <span className='text-sm font-medium'>
              {name || t('balance.windowFallback')}
            </span>
            <span className='text-xs text-muted-foreground'>
              {raw || '—'}
            </span>
          </div>

          <div className='grid gap-3 sm:grid-cols-2'>
            <QuotaMeter
              title={INTERVAL_WINDOW_LABEL()}
              percent={window.intervalPercent}
              endsAt={window.intervalEndsAt}
            />
            <QuotaMeter
              title={WEEKLY_WINDOW_LABEL()}
              percent={window.weeklyPercent}
              endsAt={window.weeklyEndsAt}
            />
          </div>
        </div>
        )
      })}
    </div>
  )
}

function QuotaMeter({
  title,
  percent,
  endsAt,
}: {
  title: string
  percent: number
  endsAt: bigint
}) {
  const { t } = useTranslation()
  const value = Math.max(0, Math.min(100, percent))
  return (
    <div className='grid gap-1.5'>
      <div className='flex items-baseline justify-between gap-2'>
        <span className='text-xs text-muted-foreground'>{title}</span>
        <span className={`font-mono text-sm font-medium ${percentTone(value)}`}>
          {t('balance.remainingShort', { value: `${value}%` })}
        </span>
      </div>
      <Progress value={value} />
      <span className='text-xs text-muted-foreground'>
        {endsAt > 0n ? (
          <>
            {t('balance.resetAt', {
              time: formatDateTime(endsAt),
              left: remainingUntil(endsAt),
            })}
          </>
        ) : (
          t('balance.noResetTime')
        )}
      </span>
    </div>
  )
}
