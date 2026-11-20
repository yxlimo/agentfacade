import { useTranslation } from 'react-i18next'
import type { CreditLot } from '@/gen/agentfacade/admin/v1/admin_pb'
import { EmptyState } from '@/components/async-state'
import { StatusBadge } from '@/components/status-badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDate, formatPoints, isFarFuture, remainingDays } from '@/lib/format'

/**
 * 积分批次。
 *
 * 积分是点数，不是钱：这里不写 ¥，也不跟余额加在一起。
 *
 * 到期时间原样显示平台的日期：平台用 2099-12-31 标记「永不过期」，这里
 * 不翻译它。倒计时那一列对这种批次给「—」。
 *
 * 表里只留还有点的批次，快用完的排前面，永不过期的排最后。
 */
export function CreditLotsTable({ lots }: { lots: CreditLot[] }) {
  const { t } = useTranslation()
  const visible = lots
    .filter((lot) => lot.remaining > 0)
    .sort((a, b) => {
      const farA = isFarFuture(a.expiresAt)
      const farB = isFarFuture(b.expiresAt)
      if (farA !== farB) return farA ? 1 : -1
      if (a.expiresAt === b.expiresAt) return 0
      return a.expiresAt < b.expiresAt ? -1 : 1
    })

  if (visible.length === 0) {
    return (
      <EmptyState title={t('balance.emptyCreditLots')} />
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('balance.lot')}</TableHead>
          <TableHead>{t('balance.source')}</TableHead>
          <TableHead className='text-right'>{t('balance.remaining')}</TableHead>
          <TableHead>{t('balance.expiresAt')}</TableHead>
          <TableHead>{t('balance.countdown')}</TableHead>
          <TableHead>{t('balance.state')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {visible.map((lot) => (
          <CreditLotRow key={lot.id} lot={lot} />
        ))}
      </TableBody>
    </Table>
  )
}

function CreditLotRow({ lot }: { lot: CreditLot }) {
  const { t } = useTranslation()
  const far = isFarFuture(lot.expiresAt)
  const days = remainingDays(lot.expiresAt)

  return (
    <TableRow>
      <TableCell>
        <span className='font-mono text-xs'>{lot.id}</span>
      </TableCell>
      <TableCell>{lot.sourceLabel || '—'}</TableCell>
      <TableCell className='text-right font-mono'>
        {t('balance.points', { n: formatPoints(lot.remaining) })}
      </TableCell>
      <TableCell className='font-mono text-xs'>
        {formatDate(lot.expiresAt)}
      </TableCell>
      <TableCell className='text-xs'>
        {far || days === null ? (
          '—'
        ) : days === 0 ? (
          <span className='text-destructive'>{t('balance.expired')}</span>
        ) : (
          t('balance.days', { days })
        )}
      </TableCell>
      <TableCell>
        <StatusBadge status={lot.status} />
      </TableCell>
    </TableRow>
  )
}
