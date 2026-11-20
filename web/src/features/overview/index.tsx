import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import {
  Activity,
  Boxes,
  Clock,
  Layers,
} from 'lucide-react'
import { PageShell } from '@/components/layout/page-shell'
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from '@/components/async-state'
import {
  CredentialStateBadge,
  UpstreamStateBadge,
} from '@/features/upstreams/state-badge'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { QuotaSummary } from '@/features/balance/quota'
import { DailyCheckinPanel } from '@/features/benefits/daily-checkin'
import { useSystemStatus, useUsageSummary } from '@/features/overview/api'
import { credentialKindLabel } from '@/lib/credential-kind'
import { formatCompact, formatCount, formatUptime } from '@/lib/format'

export function OverviewPage() {
  const { t } = useTranslation()
  const status = useSystemStatus()
  const usage = useUsageSummary({ upstreamId: '', window: 'day' })

  if (status.isPending) {
    return <LoadingState />
  }
  if (status.isError) {
    return <ErrorState error={status.error} onRetry={() => status.refetch()} />
  }

  const data = status.data
  const total = usage.data?.total

  return (
    <PageShell
      title={t('overview.title')}
      description={t('overview.description')}
    >

      <div className='mb-4'>
        <DailyCheckinPanel />
      </div>

      {/* 额度不在这里求和：余额（钱）、积分（点数）、套餐额度（百分比）
          单位不同，加起来没有意义。各上游的额度去「平台」页看。 */}
      <div className='grid gap-4 lg:grid-cols-3'>
        <Card>
          <CardHeader>
            <CardDescription className='flex items-center gap-1.5'>
              <Activity className='size-3.5' />
              {t('overview.todayRequests')}
            </CardDescription>
            <CardTitle className='text-2xl'>
              {total ? formatCount(total.requests) : '—'}
            </CardTitle>
          </CardHeader>
          <CardContent className='text-sm text-muted-foreground'>
            {total
              ? t('common.successFailed', {
                  ok: formatCount(total.succeeded),
                  bad: formatCount(total.failed),
                })
              : t('overview.noUsageData')}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription className='flex items-center gap-1.5'>
              <Layers className='size-3.5' />
              {t('overview.mainModels')}
            </CardDescription>
            <CardTitle className='text-2xl'>{data.publishedModelCount}</CardTitle>
          </CardHeader>
          <CardContent className='text-sm text-muted-foreground'>
            <Link to='/models' className='underline underline-offset-4'>
              {t('overview.manageModels')}
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardDescription className='flex items-center gap-1.5'>
              <Clock className='size-3.5' />
              {t('overview.uptime')}
            </CardDescription>
            <CardTitle className='text-2xl'>
              {formatUptime(data.uptimeSec)}
            </CardTitle>
          </CardHeader>
          <CardContent className='text-sm text-muted-foreground'>
            {t('overview.version', {
              version: data.version || t('overview.unknownVersion'),
            })}
          </CardContent>
        </Card>
      </div>

      <Separator className='my-6' />

      <div className='grid gap-4 lg:grid-cols-2'>
        <Card>
          <CardHeader>
            <CardTitle className='flex items-center gap-2 text-base'>
              <Boxes className='size-4' />
              {t('overview.platforms')}
            </CardTitle>
            <CardDescription>
              {t('overview.platformSwitchHint')}
            </CardDescription>
          </CardHeader>
          <CardContent className='grid gap-3'>
            {data.upstreams.length === 0 ? (
              <EmptyState title={t('overview.noPlatforms')} />
            ) : (
              data.upstreams.map((upstream) => (
                <div
                  key={upstream.id}
                  className='flex items-start justify-between gap-3 rounded-lg border p-3'
                >
                  <div className='grid gap-1'>
                    <span className='text-sm font-medium'>
                      {upstream.label || upstream.id}
                    </span>
                    <span className='text-xs text-muted-foreground'>
                      {upstream.id} · {t('overview.models', { count: upstream.modelCount })}
                    </span>
                    {upstream.credential ? (
                      <span className='text-xs text-muted-foreground'>
                        {credentialKindLabel(upstream.credential.kind)
                          ? t('overview.credentialKind', {
                              kind: credentialKindLabel(upstream.credential.kind),
                            })
                          : ''}
                      </span>
                    ) : null}
                  </div>
                  <div className='flex min-w-0 flex-col items-end gap-1'>
                    <UpstreamStateBadge state={upstream.state} />
                    {upstream.credential ? (
                      <CredentialStateBadge status={upstream.credential.status} />
                    ) : null}
                    {upstream.quota ? (
                      <QuotaSummary quota={upstream.quota} />
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className='flex items-center gap-2 text-base'>
              <Activity className='size-4' />
              {t('overview.todayUsage')}
            </CardTitle>
            <CardDescription>{t('overview.usageByPlatform')}</CardDescription>
          </CardHeader>
          <CardContent className='grid gap-3'>
            {usage.isPending ? (
              <LoadingState label={t('usage.loadingUsage')} />
            ) : usage.isError ? (
              <ErrorState error={usage.error} onRetry={() => usage.refetch()} />
            ) : (usage.data?.byUpstream.length ?? 0) === 0 ? (
              <EmptyState title={t('overview.noRequestsToday')} />
            ) : (
              usage.data?.byUpstream.map((bucket) => (
                <div
                  key={bucket.key}
                  className='flex items-center justify-between gap-3 rounded-lg border p-3 text-sm'
                >
                  <span className='font-medium'>{bucket.key}</span>
                  <span className='font-mono text-muted-foreground'>
                    {t('overview.inOut', {
                      in: formatCompact(bucket.summary?.promptTokens ?? 0n),
                      out: formatCompact(bucket.summary?.completionTokens ?? 0n),
                    })}
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </PageShell>
  )
}
