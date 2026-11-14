import { useMemo } from 'react'
import { PageShell } from '@/components/layout/page-shell'
import { ErrorState } from '@/components/async-state'
import { Button } from '@/components/ui/button'
import { useUpstreams } from '@/features/upstreams/api'
import { useBenefitStatus, useRunBenefitNow } from '@/features/upstreams/benefits'
import { describeError } from '@/lib/errors'
import { useOrderedPlatforms } from '@/lib/platform-order'
import { PlatformCheckinRow } from '@/features/benefits/platform-checkin-row'
import type { BenefitStatus, Upstream } from '@/gen/buddy/admin/v1/admin_pb'

/** 停用账号的 id：签到页只列启用的账号（停用的签不了，占一行说「未知」是噪声）。 */
export function disabledAccountIds(upstreams: Upstream[]): Set<string> {
  const disabled = new Set<string>()
  for (const upstream of upstreams) {
    for (const account of upstream.accounts) {
      if (!account.enabled) disabled.add(account.id)
    }
  }
  return disabled
}

/**
 * 签到页：一个平台一行，收起时给状态，点开看逐条明细。
 *
 * 行集合来自后端的答复：签到是账号的事，答复里只有「签得到」的账号 ——
 * 没有签到能力的平台（第三方开放平台那一族）压根不出现在答复里，页面也就不
 * 给它占一行。次序照操作者自己排的那一份（平台页上拖出来的），平台名从平台
 * 清单里取。
 */
export function CheckinPage() {
  const platforms = useUpstreams()
  const status = useBenefitStatus()
  const run = useRunBenefitNow()

  // 答复里的账号按平台归堆：upstreamId 是平台，accountId 是账号。
  // 停用的账号签不了，也不该在签到页占一行说「状态未知」——只列启用的账号。
  // 后端答复里多出的账号（清单里找不到的）不扣：扣不扣不知道，别替后端删。
  const benefits = useMemo(() => {
    const disabled = disabledAccountIds(platforms.data?.upstreams ?? [])
    const map = new Map<string, BenefitStatus[]>()
    for (const benefit of status.data?.benefits ?? []) {
      if (disabled.has(benefit.accountId)) continue
      const list = map.get(benefit.upstreamId) ?? []
      list.push(benefit)
      map.set(benefit.upstreamId, list)
    }
    return map
  }, [platforms.data, status.data])

  // 账号别名：展开明细里每条记录要能看出是哪个账号，拿别名，拿不到退回 id。
  const accountAliases = useMemo(() => {
    const map = new Map<string, string>()
    for (const upstream of platforms.data?.upstreams ?? []) {
      for (const account of upstream.accounts) {
        const alias = account.alias?.trim()
        if (alias) map.set(account.id, alias)
      }
    }
    return map
  }, [platforms.data])

  // 平台名从清单里取（清单里有这个平台才拿得到名字），次序也照清单排 ——
  // 但哪些平台占一行由答复决定，不由清单决定。
  const ordered = useOrderedPlatforms(platforms.data?.upstreams ?? [])
  const rows = useMemo(() => {
    const names = new Map<string, string>()
    for (const upstream of platforms.data?.upstreams ?? []) {
      names.set(upstream.id, upstream.label?.trim() || upstream.id)
    }
    const ids = ordered
      .map((upstream) => upstream.id)
      .filter((id) => benefits.has(id))
    // 清单里没有的平台（刚删掉的）也占位置：答复里还有它。
    for (const id of benefits.keys()) {
      if (!ids.includes(id)) ids.push(id)
    }
    return ids.map((id) => ({ upstreamId: id, title: names.get(id) ?? id }))
  }, [benefits, ordered, platforms.data])

  const runLines = run.data?.lines ?? []

  return (
    <PageShell
      title='签到'
      description='按平台列出签到状态与明细。'
      actions={
        <Button size='sm' onClick={() => run.mutate()} disabled={run.isPending}>
          {run.isPending ? '签到中…' : '立即签到'}
        </Button>
      }
    >
      {platforms.isPending || status.isPending ? (
        <div>
          <p className='mb-4 text-sm text-muted-foreground'>正在读取签到状态…</p>
          <ul aria-label='平台签到' className='grid gap-3'>
            {[0, 1, 2].map((index) => (
              <li key={index} className='rounded-lg border px-4 py-3'>
                <div className='h-4 w-24 animate-pulse rounded bg-muted' />
                <div className='mt-2 h-3 w-16 animate-pulse rounded bg-muted' />
              </li>
            ))}
          </ul>
        </div>
      ) : platforms.isError ? (
        <ErrorState error={platforms.error} onRetry={() => platforms.refetch()} />
      ) : status.isError ? (
        <ErrorState error={status.error} onRetry={() => status.refetch()} />
      ) : rows.length === 0 ? (
        <p className='rounded-lg border px-4 py-12 text-center text-sm text-muted-foreground'>
          没有需要签到的平台
        </p>
      ) : (
        <>
          {run.isError ? (
            <p
              aria-label='签到失败'
              className='mb-4 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive'
            >
              {describeError(run.error as Error)}
            </p>
          ) : null}

          {run.data ? (
            <div
              aria-label='本次签到'
              className='mb-4 grid gap-1 rounded-lg border px-4 py-3'
            >
              <span className='text-sm font-medium'>本次签到</span>
              {runLines.length > 0 ? (
                <ul className='grid gap-0.5 text-sm'>
                  {runLines.map((line, index) => (
                    <li key={`${index}-${line}`} className='break-words'>
                      {line}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className='text-sm text-muted-foreground'>没有输出</span>
              )}
            </div>
          ) : null}

          <ul aria-label='平台签到' className='grid gap-3'>
            {rows.map((row) => (
              <PlatformCheckinRow
                key={row.upstreamId}
                upstreamId={row.upstreamId}
                title={row.title}
                benefits={benefits.get(row.upstreamId) ?? []}
                accountAliases={accountAliases}
              />
            ))}
          </ul>
        </>
      )}
    </PageShell>
  )
}
