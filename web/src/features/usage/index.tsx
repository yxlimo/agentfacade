import { getRouteApi } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { PageShell } from '@/components/layout/page-shell'
import {
  ErrorState,
  LoadingState,
} from '@/components/async-state'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useUsageSummary } from '@/features/overview/api'
import { useUpstreams } from '@/features/upstreams/api'
import { useUsageEvents } from '@/features/usage/api'
import { USAGE_TOP_LIMIT, topBuckets } from '@/features/usage/top-buckets'
import { UsageTable } from '@/features/usage/usage-table'
import { type NavigateFn } from '@/hooks/use-table-url-state'
import { formatCompact, formatCount } from '@/lib/format'

const route = getRouteApi('/_authenticated/usage')

// 契约里的 ListUsageEvents 只有 limit 和 before_id 游标，所以一次拉一段，
// 翻页在这一段里切。
const EVENTS_LIMIT = 500

// 时间窗。契约里的取值：hour / day / week / month，空表示全部。
// today 是从本地零点算起的一段 —— 早上八点看「今天」，要的是零点到现在。
// 文案按 key 进词典，窗口值本身是路由参数。
const WINDOWS = [
  { value: 'today', label: 'usage.windowToday' },
  { value: 'hour', label: 'usage.windowHour' },
  { value: 'day', label: 'usage.windowDay' },
  { value: 'week', label: 'usage.windowWeek' },
  { value: 'month', label: 'usage.windowMonth' },
  { value: 'all', label: 'usage.windowAll' },
] as const

export function UsagePage() {
  const { t } = useTranslation()
  const search = route.useSearch()
  const navigate = route.useNavigate()

  const upstreamFilter = search.upstream ?? ''
  const modelFilter = search.model ?? ''
  // 默认看最近一周：按天那张表在「今天」这一档下永远只有一行。
  // 'week' 就是选项列表里那档最近一周（后端 windowMs 也按 7 天算）。
  const windowFilter = search.window ?? 'week'

  const summary = useUsageSummary({
    upstreamId: upstreamFilter,
    window: windowFilter,
  })
  const upstreams = useUpstreams()
  const events = useUsageEvents({
    upstreamId: upstreamFilter,
    model: modelFilter,
    limit: EVENTS_LIMIT,
    window: windowFilter,
  })

  const total = summary.data?.total
  const upstreamOptions = (upstreams.data?.upstreams ?? []).map((item) => ({
    label: item.label || item.id,
    value: item.id,
  }))
  const modelOptions = (summary.data?.byModel ?? []).map((item) => ({
    label: item.key,
    value: item.key,
  }))

  const parentSession = topBuckets(summary.data?.byParentSession ?? [])
  const subagent = topBuckets(summary.data?.bySubagent ?? [])

  return (
    <PageShell
      title={t('usage.title')}
      description={t('usage.description')}
      actions={
        <Select
          value={windowFilter}
          onValueChange={(value) =>
            navigate({
              search: (prev) => ({
                ...prev,
                window: value,
              }),
              replace: true,
            })
          }
        >
          <SelectTrigger className='w-36'>
            <SelectValue placeholder={t('usage.window')} />
          </SelectTrigger>
          <SelectContent>
            {WINDOWS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {t(item.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {summary.isPending ? (
        <LoadingState label={t('usage.loadingUsage')} />
      ) : summary.isError ? (
        <ErrorState error={summary.error} onRetry={() => summary.refetch()} />
      ) : (
        <>
          <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
            <StatCard
              title={t('usage.requests')}
              value={formatCount(total?.requests ?? 0n)}
              hint={t('common.successFailed', {
                ok: formatCount(total?.succeeded ?? 0n),
                bad: formatCount(total?.failed ?? 0n),
              })}
            />
            <StatCard
              title={t('usage.outputTokens')}
              value={formatCompact(total?.completionTokens ?? 0n)}
              hint={
                total && total.reasoningTokens > 0n
                  ? t('usage.reasoningHint', {
                      tokens: formatCompact(total.reasoningTokens),
                    })
                  : undefined
              }
            />
            <StatCard
              title={t('usage.inputTokens')}
              value={formatCompact(total?.promptTokens ?? 0n)}
            />
            <StatCard
              title={t('usage.totalLatency')}
              value={
                total && total.requests > 0n
                  ? `${Math.round(
                      Number(total.latencyMsSum) / Number(total.requests)
                    )} ms`
                  : '—'
              }
              hint={t('usage.perRequestHint')}
            />
          </div>

          <div className='grid gap-4 lg:grid-cols-2'>
            <BreakdownCard
              title={t('usage.byPlatform')}
              buckets={summary.data?.byUpstream ?? []}
            />
            <BreakdownCard
              title={t('usage.byModel')}
              buckets={summary.data?.byModel ?? []}
            />
          </div>

          <div className='grid gap-4 lg:grid-cols-2'>
            <BreakdownCard
              title={t('usage.byAgent')}
              buckets={summary.data?.byAgent ?? []}
            />
            <DaySeries buckets={summary.data?.byDay ?? []} />
          </div>

          <div className='grid gap-4 lg:grid-cols-2'>
            {/* 会话太多，只列用得最多的那几个。 */}
            <BreakdownCard
              title={t('usage.bySession')}
              buckets={(summary.data?.bySession ?? []).slice(0, 10)}
              total={(summary.data?.bySession ?? []).length}
            />
            {/* 主会话：子代理的请求并进主代理那一档。 */}
            <BreakdownCard
              title={t('usage.byParentSession')}
              buckets={parentSession.shown}
              total={parentSession.total}
            />
          </div>

          <div className='grid gap-4 lg:grid-cols-2'>
            <BreakdownCard
              title={t('usage.byAgentName')}
              buckets={summary.data?.byAgentName ?? []}
            />
            <BreakdownCard
              title={t('usage.bySubagent')}
              buckets={subagent.shown}
              total={subagent.total}
            />
          </div>
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle className='text-base'>{t('usage.events')}</CardTitle>
          <CardDescription>
            {t('usage.eventsRecent', { count: EVENTS_LIMIT })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UsageTable
            data={events.data?.events ?? []}
            isPending={events.isPending}
            error={events.error}
            onRetry={() => void events.refetch()}
            search={search as Record<string, unknown>}
            navigate={navigate as unknown as NavigateFn}
            upstreamOptions={upstreamOptions}
            modelOptions={modelOptions}
          />
        </CardContent>
      </Card>
    </PageShell>
  )
}

function StatCard({
  title,
  value,
  hint,
}: {
  title: string
  value: string
  hint?: string
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription>{title}</CardDescription>
        <CardTitle className='text-2xl'>{value}</CardTitle>
      </CardHeader>
      {hint ? (
        <CardContent className='text-sm text-muted-foreground'>{hint}</CardContent>
      ) : null}
    </Card>
  )
}

export function BreakdownCard({
  title,
  buckets,
  total,
}: {
  title: string
  total?: number
  buckets: {
    key: string
    summary?: {
      requests: bigint
      promptTokens: bigint
      completionTokens: bigint
    }
  }[]
}) {
  const { t } = useTranslation()
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>{title}</CardTitle>
        {total !== undefined && total > buckets.length ? (
          <CardDescription>
            {t('usage.entriesShown', {
              count: total,
              shown: USAGE_TOP_LIMIT,
            })}
          </CardDescription>
        ) : null}
      </CardHeader>
      <CardContent className='grid gap-2'>
        {buckets.length === 0 ? (
          <p className='py-6 text-center text-sm text-muted-foreground'>
            {t('usage.noData')}
          </p>
        ) : (
          buckets.map((bucket) => (
            <div
              key={bucket.key}
              className='flex items-center justify-between gap-3 text-sm'
            >
              <span className='truncate font-mono text-xs'>{bucket.key}</span>
              <span className='whitespace-nowrap font-mono text-sm text-muted-foreground'>
                {t('usage.requestsTimes', {
                  count: Number(bucket.summary?.requests ?? 0n),
                  in: formatCompact(bucket.summary?.promptTokens ?? 0n),
                  out: formatCompact(bucket.summary?.completionTokens ?? 0n),
                })}
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}

function DaySeries({
  buckets,
}: {
  buckets: { key: string; summary?: { requests: bigint } }[]
}) {
  const { t } = useTranslation()
  const max = buckets.reduce(
    (peak, bucket) => Math.max(peak, Number(bucket.summary?.requests ?? 0n)),
    0
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>{t('usage.byDay')}</CardTitle>
        <CardDescription>{t('usage.byDayDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        {buckets.length === 0 ? (
          <p className='py-6 text-center text-sm text-muted-foreground'>
            {t('usage.noData')}
          </p>
        ) : (
          <div className='flex items-end gap-1 overflow-x-auto pb-2'>
            {buckets.map((bucket) => {
              const value = Number(bucket.summary?.requests ?? 0n)
              const height = max > 0 ? Math.max(4, (value / max) * 120) : 4
              return (
                <div
                  key={bucket.key}
                  className='flex min-w-10 flex-col items-center gap-1'
                  title={t('usage.bucketTitle', {
                    key: bucket.key,
                    count: value,
                  })}
                >
                  <div
                    className='w-full rounded-t bg-primary/70'
                    style={{ height: `${height}px` }}
                  />
                  <span className='text-[10px] text-muted-foreground'>
                    {bucket.key.slice(5)}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
