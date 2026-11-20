import { useTranslation } from 'react-i18next'
import { AlertTriangle, Inbox, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { describeErrorText } from '@/lib/errors'

export function LoadingState({ label }: { label?: string }) {
  const { t } = useTranslation()
  return (
    <div className='flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground'>
      <Loader2 className='size-4 animate-spin' />
      {label ?? t('common.loading')}
    </div>
  )
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown
  onRetry?: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className='flex flex-col items-center gap-3 py-12 text-center'>
      <AlertTriangle className='size-6 text-destructive' />
      <p className='text-sm text-destructive'>{describeErrorText(error, t)}</p>
      {onRetry ? (
        <Button variant='outline' size='sm' onClick={onRetry}>
          {t('common.retry')}
        </Button>
      ) : null}
    </div>
  )
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title?: string
  description?: React.ReactNode
  action?: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <div className='flex flex-col items-center gap-3 py-12 text-center'>
      <Inbox className='size-6 text-muted-foreground' />
      <p className='text-sm font-medium'>{title ?? t('common.noData')}</p>
      {description ? (
        <p className='text-sm text-muted-foreground'>{description}</p>
      ) : null}
      {action}
    </div>
  )
}
