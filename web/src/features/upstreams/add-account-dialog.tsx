import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * 在一个平台下加一个账号。
 *
 * 平台是表里的一行（播种的模拟客户端与自建的开放平台）；能加的是账号 —— 同一个
 * 平台下可以有好几个（主账号与 M plan、中转站的每个租户）。
 *
 * 别名可以不给：不给就由服务端起一个（「账号 2」这种）。
 */
export function AddAccountDialog({
  open,
  platform,
  platformLabel,
  onSubmit,
  onOpenChange,
  pending,
}: {
  open: boolean
  /** 在哪个平台下加：九个模板之一的 id。 */
  platform: string
  /** 这个平台叫什么，给人看。 */
  platformLabel: string
  onSubmit: (input: { platform: string; alias: string }) => void
  onOpenChange: (open: boolean) => void
  pending: boolean
}) {
  const { t } = useTranslation()
  const [alias, setAlias] = useState('')

  const reset = () => setAlias('')

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent className='sm:max-w-md'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2'>
            <Plus className='size-4' />
            {t('upstreams.addAccountTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('upstreams.addAccountDescription', { platform: platformLabel })}
          </DialogDescription>
        </DialogHeader>
        <div className='grid gap-2'>
          <Label htmlFor='account-alias'>{t('upstreams.aliasLabel')}</Label>
          <Input
            id='account-alias'
            value={alias}
            placeholder={t('upstreams.aliasPlaceholder')}
            onChange={(event) => setAlias(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              if (pending) return
              onSubmit({ platform, alias: alias.trim() })
            }}
          />
          <p className='text-xs text-muted-foreground'>
            {t('upstreams.aliasHint')}
          </p>
        </div>
        <DialogFooter>
          <Button
            variant='outline'
            onClick={() => {
              reset()
              onOpenChange(false)
            }}
          >
            {t('upstreams.cancel')}
          </Button>
          <Button
            disabled={pending}
            onClick={() => onSubmit({ platform, alias: alias.trim() })}
          >
            {t('upstreams.add')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
