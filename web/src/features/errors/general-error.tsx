import { Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { describeErrorText } from '@/lib/errors'

export function GeneralError({ error }: { error: unknown }) {
  const { t } = useTranslation()
  return (
    <div className='flex min-h-svh flex-col items-center justify-center gap-4 p-6 text-center'>
      <p className='text-2xl font-semibold'>{t('common.pageFailed')}</p>
      <p className='max-w-lg text-sm text-muted-foreground'>
        {describeErrorText(error, t)}
      </p>
      <Button asChild>
        <Link to='/'>{t('common.backToOverview')}</Link>
      </Button>
    </div>
  )
}
