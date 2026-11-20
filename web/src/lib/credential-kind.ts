import labels from '@/lib/i18n'

/**
 * 凭据是哪一种。
 *
 * 服务端给的是契约里的枚举值（session / api_key / cookie）：那一串对运维等于
 * 内部术语，界面上换成看得懂的词。没登记的值原样返回，不自创「未知类型」这类
 * 说法 —— 认不出的值本身就是后端要收敛的信号，藏起来反而看不见。
 *
 * 平台页的凭据表和总览页的凭据行都用这一张表，不另写第二份。
 */
type KindKey = 'session' | 'api_key' | 'cookie'

const KINDS: KindKey[] = ['session', 'api_key', 'cookie']

function kindKey(kind: KindKey): `credentialKind.${KindKey}` {
  return `credentialKind.${kind}`
}

function isKind(value: string): value is KindKey {
  return KINDS.some((known) => known === value)
}

/** 把一个凭据 kind 换成界面上的说法；空值给空串，没登记的值原样给回。 */
export function credentialKindLabel(kind: string | undefined): string {
  if (!kind) return ''
  return isKind(kind) ? labels.t(kindKey(kind)) : kind
}
