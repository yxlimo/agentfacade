import { useTranslation } from 'react-i18next'
import {
  CredentialState,
  UpstreamState,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { Badge } from '@/components/ui/badge'
import {
  CREDENTIAL_STATE_LABELS,
  UPSTREAM_STATE_LABELS,
  credentialStateVariant,
  upstreamStateClass,
  upstreamStateVariant,
} from '@/features/upstreams/state'

/** 上游的状态徽章：就绪 / 已停用 / 没登录 / 额度用完…… */
export function UpstreamStateBadge({
  state,
  className,
}: {
  state: UpstreamState
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <Badge
      variant={upstreamStateVariant(state)}
      className={[upstreamStateClass(state), className]
        .filter(Boolean)
        .join(' ')}
    >
      {UPSTREAM_STATE_LABELS[state] ?? t('upstreams.credentialUnknown')}
    </Badge>
  )
}

/** 凭据的状态徽章。 */
export function CredentialStateBadge({
  status,
  className,
}: {
  status: CredentialState
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <Badge variant={credentialStateVariant(status)} className={className}>
      {CREDENTIAL_STATE_LABELS[status] ?? t('upstreams.credentialUnknown')}
    </Badge>
  )
}
