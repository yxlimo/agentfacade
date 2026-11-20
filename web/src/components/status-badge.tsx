import { useTranslation } from 'react-i18next'
import { Badge } from '@/components/ui/badge'
import type { zh } from '@/lib/i18n/catalogs/zh'

const LABELS: Record<string, keyof typeof zh> = {
  // 凭据
  authenticated: 'status.authenticated',
  usable: 'status.usable',
  ok: 'status.ok',
  missing: 'status.missing',
  expired: 'status.expired',
  error: 'status.error',
  // 用量事件
  success: 'status.success',
  succeeded: 'status.succeeded',
  failed: 'status.failed',
  // 上游
  enabled: 'status.enabled',
  disabled: 'status.disabled',
  // 余额批次
  active: 'status.active',
  permanent: 'status.permanent',
  used_up: 'status.usedUp',
}

/**
 * 状态字符串 → 徽章。认不出来的就原样显示。
 *
 * `labels` 覆盖文案：同一个状态词在账号和凭据上意思不一样（账号的 usable
 * 是「已登录」，凭据的 usable 是「可用」），各说各的。
 */
export function StatusBadge({
  status,
  className,
  labels,
}: {
  status: string | undefined | null
  className?: string
  /** 覆盖默认文案。 */
  labels?: Record<string, string>
}) {
  const { t } = useTranslation()
  const key = (status ?? '').trim().toLowerCase()
  if (!key) {
    return (
      <Badge variant='outline' className={className}>
        {t('status.unknown')}
      </Badge>
    )
  }

  const variant = variantFor(key)
  // 认不出的状态是服务端原话，原样透出。
  const labelKey = LABELS[key]
  const label = labels?.[key] ?? (labelKey ? t(labelKey) : status)
  return (
    <Badge variant={variant} className={className}>
      {label}
    </Badge>
  )
}

function variantFor(
  key: string
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (key) {
    case 'authenticated':
    case 'usable':
    case 'ok':
    case 'success':
    case 'succeeded':
    case 'active':
      return 'default'
    case 'expired':
    case 'error':
    case 'failed':
    case 'missing':
    case 'used_up':
      return 'destructive'
    case 'enabled':
    case 'disabled':
    case 'permanent':
      return 'secondary'
    default:
      return 'outline'
  }
}
