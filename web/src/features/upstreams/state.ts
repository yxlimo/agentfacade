import {
  CredentialState,
  UnpublishedReason,
  UpstreamState,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import i18n from '@/lib/i18n'
import type { zh } from '@/lib/i18n/catalogs/zh'

type DictKey = keyof typeof zh

/**
 * 上游状态的人话。
 *
 * 面板不再自己拼「开着 && 登录了」——能不能接由后端说，state 说了算。
 * 标签从词典取：语言切换时以 i18next 的 languageChanged 重算一次，导出对象
 * 保持原来的形状（models 等目录也读这几份表）。
 */
function labelsOf<T extends string | number>(
  keys: Record<T, DictKey>
): Record<T, string> {
  const result = {} as Record<T, string>
  for (const key of Object.keys(keys) as T[]) {
    const dictKey: DictKey = keys[key]
    result[key] = i18n.t(dictKey)
  }
  return result
}

const UPSTREAM_STATE_KEYS: Record<UpstreamState, DictKey> = {
  [UpstreamState.UNSPECIFIED]: 'upstreams.stateUnspecified',
  [UpstreamState.READY]: 'upstreams.stateReady',
  [UpstreamState.DISABLED]: 'upstreams.stateDisabled',
  [UpstreamState.NO_CREDENTIAL]: 'upstreams.stateNoCredential',
  [UpstreamState.CREDENTIAL_EXPIRED]: 'upstreams.stateCredentialExpired',
  [UpstreamState.CREDENTIAL_REJECTED]: 'upstreams.stateCredentialRejected',
  [UpstreamState.OUT_OF_CREDITS]: 'upstreams.stateOutOfCredits',
  [UpstreamState.LOGGING_IN]: 'upstreams.stateLoggingIn',
  [UpstreamState.COOLING]: 'upstreams.stateCooling',
  [UpstreamState.QUEUED]: 'upstreams.stateQueued',
}

const UPSTREAM_STATE_HINT_KEYS: Record<UpstreamState, DictKey> = {
  [UpstreamState.UNSPECIFIED]: 'upstreams.hintUnspecified',
  [UpstreamState.READY]: 'upstreams.hintReady',
  [UpstreamState.DISABLED]: 'upstreams.hintDisabled',
  [UpstreamState.NO_CREDENTIAL]: 'upstreams.stateNoCredential',
  [UpstreamState.CREDENTIAL_EXPIRED]: 'upstreams.stateCredentialExpired',
  [UpstreamState.CREDENTIAL_REJECTED]: 'upstreams.stateCredentialRejected',
  [UpstreamState.OUT_OF_CREDITS]: 'upstreams.hintOutOfCredits',
  [UpstreamState.LOGGING_IN]: 'upstreams.stateLoggingIn',
  [UpstreamState.COOLING]: 'upstreams.hintCooling',
  [UpstreamState.QUEUED]: 'upstreams.hintQueued',
}

const CREDENTIAL_STATE_KEYS: Record<CredentialState, DictKey> = {
  [CredentialState.UNSPECIFIED]: 'upstreams.credentialUnknown',
  [CredentialState.AUTHENTICATED]: 'upstreams.credentialAvailable',
  [CredentialState.MISSING]: 'upstreams.credentialMissing',
  [CredentialState.EXPIRED]: 'upstreams.credentialExpired',
  [CredentialState.ERROR]: 'upstreams.credentialError',
  [CredentialState.USABLE]: 'upstreams.credentialAvailable',
  [CredentialState.ANONYMOUS]: 'upstreams.credentialAvailable',
}

const UNPUBLISHED_REASON_KEYS: Record<UnpublishedReason, DictKey> = {
  [UnpublishedReason.UNSPECIFIED]: 'upstreams.reasonUnpublished',
  [UnpublishedReason.DISABLED]: 'upstreams.reasonDisabled',
  [UnpublishedReason.UPSTREAM_DISABLED]: 'upstreams.reasonUpstreamDisabled',
  [UnpublishedReason.NO_CREDENTIAL]: 'upstreams.reasonNoCredential',
  [UnpublishedReason.MODEL_GONE]: 'upstreams.reasonModelGone',
  [UnpublishedReason.TARGET_DISABLED]: 'upstreams.reasonTargetDisabled',
  [UnpublishedReason.NO_TARGET]: 'upstreams.reasonNoTarget',
}

export let UPSTREAM_STATE_LABELS = labelsOf(UPSTREAM_STATE_KEYS)
export let UPSTREAM_STATE_HINTS = labelsOf(UPSTREAM_STATE_HINT_KEYS)
export let CREDENTIAL_STATE_LABELS = labelsOf(CREDENTIAL_STATE_KEYS)
export let UNPUBLISHED_REASON_LABELS = labelsOf(UNPUBLISHED_REASON_KEYS)

i18n.on('languageChanged', () => {
  UPSTREAM_STATE_LABELS = labelsOf(UPSTREAM_STATE_KEYS)
  UPSTREAM_STATE_HINTS = labelsOf(UPSTREAM_STATE_HINT_KEYS)
  CREDENTIAL_STATE_LABELS = labelsOf(CREDENTIAL_STATE_KEYS)
  UNPUBLISHED_REASON_LABELS = labelsOf(UNPUBLISHED_REASON_KEYS)
})

/** 不能选的时候说清楚为什么：一句话，短的，能塞进下拉那一行。 */

/** 这个上游现在能不能接请求。 */
export function isUpstreamReady(state: UpstreamState): boolean {
  return state === UpstreamState.READY
}

/** 徽章的色调。 */
export function upstreamStateVariant(
  state: UpstreamState
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (state) {
    case UpstreamState.READY:
      return 'default'
    case UpstreamState.COOLING:
      return 'outline'
    // 排队也是「等一会儿就好」那一档：淡色，不是红色。单写一个 case（不跟
    // COOLING 合并）—— 将来两档要分开时就改这一处。
    case UpstreamState.QUEUED:
      return 'outline'
    case UpstreamState.DISABLED:
    case UpstreamState.LOGGING_IN:
    case UpstreamState.UNSPECIFIED:
      return 'secondary'
    case UpstreamState.NO_CREDENTIAL:
    case UpstreamState.CREDENTIAL_EXPIRED:
    case UpstreamState.CREDENTIAL_REJECTED:
    case UpstreamState.OUT_OF_CREDITS:
      return 'destructive'
    default:
      return 'outline'
  }
}

/**
 * 徽章上再叠的颜色。
 *
 * 冷却中是暂时的绕开，跟额度用完（红色，不行）不是一回事：黄色，说的
 * 是等一会儿就好。
 */
export function upstreamStateClass(state: UpstreamState): string {
  switch (state) {
    case UpstreamState.COOLING:
      return 'border-amber-500/60 text-amber-700 dark:text-amber-300'
    // 同一个淡黄，但不是同一个常量：两档的含义不同（冷却是自己绕开、排队是上游
    // 不放进），将来要分开时只需改这一行。
    case UpstreamState.QUEUED:
      return 'border-amber-500/60 text-amber-700 dark:text-amber-300'
    default:
      return ''
  }
}

/** 凭据徽章的色调。 */
export function credentialStateVariant(
  state: CredentialState
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (state) {
    case CredentialState.AUTHENTICATED:
    case CredentialState.USABLE:
    case CredentialState.ANONYMOUS:
      return 'default'
    case CredentialState.MISSING:
    case CredentialState.EXPIRED:
    case CredentialState.ERROR:
      return 'destructive'
    case CredentialState.UNSPECIFIED:
      return 'secondary'
    default:
      return 'outline'
  }
}
