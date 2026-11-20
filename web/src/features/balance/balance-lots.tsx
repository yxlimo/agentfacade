import { useTranslation } from 'react-i18next'
import type { BalanceLot } from '@/gen/agentfacade/admin/v1/admin_pb'
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
import { formatCny, formatDate, isFarFuture, remainingDays } from '@/lib/format'

/**
 * 余额里的每一笔：赠金、充值本金。
 *
 * 这里是钱，跟积分分开列：两者的单位不同，不能加在一起。
 *
 * 到期时间原样显示平台的日期：平台用 2099-12-31 标记「永不过期」，这里
 * 不翻译它。倒计时那一列对这种批次给「—」。
 */
export function BalanceLotsTable({ lots }: { lots: BalanceLot[] }) {
  const { t } = useTranslation()
  if (lots.length === 0) {
    return (
      <EmptyState title={t('balance.emptyBalanceLots')} />
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
        {lots.map((lot) => (
          <BalanceLotRow key={lot.id} lot={lot} />
        ))}
      </TableBody>
    </Table>
  )
}

function BalanceLotRow({ lot }: { lot: BalanceLot }) {
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
        {formatCny(lot.remainingCny)}
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
