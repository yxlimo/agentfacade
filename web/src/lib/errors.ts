import { Code, ConnectError } from '@connectrpc/connect'
import type { TFunction } from 'i18next'
import {
  BUDDY_ERROR_HEADER,
  adminErrorText,
  unknownAdminErrorText,
} from '@/lib/admin-errors'

/**
 * 服务端用「HTTP 200 + ok:false」表达失败（不认识的配置项、上游 id 对不上、
 * 模型没有目标……）。这类失败不是传输层的错误，是业务上的失败。
 *
 * 前端把它翻成异常，这样成功/失败只有一条路：mutateAsync 正常返回就是成功，
 * 抛出来就是失败，页面不用在每个地方各写一遍 if (!result.ok)。
 */
export class ApiFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApiFailure'
  }
}

/**
 * 断言服务端的业务结果。ok 为假时抛出，message 直接给人看。
 */
export function assertOk(
  result: { ok: boolean; message?: string },
  fallback: string
): void {
  if (result.ok) return
  throw new ApiFailure(result.message?.trim() || fallback)
}

/**
 * 把错误翻成人话。
 *
 * 契约里区分的几类失败：凭据过期、上游不可用、配置非法、冲突。面板上
 * 至少要让人知道是自己没填令牌，还是网关自己出问题了。
 *
 * 三档：响应头上有机器码且面板认得 → 码表那句话（那句话已经是给人照着改的，
 * 不再拼前缀，也不带服务端的事实句）；有码但认不得 → 原样给机器码；
 * 没有码 → 按 Connect 的 Code 兜底。
 *
 * 由调用方传 t()：这样切语言后，页面上长期显示的错误会跟着变。toast 在 emit
 * 时定型，属于瞬时提示，不要求跟着变。
 * detail 是服务端原话（上游文本），故意不进词典、不翻译。
 */
export function describeErrorText(error: unknown, t: TFunction): string {
  // 业务上的失败（ok:false）是后端原话，原样给用户看，别再包一层。
  if (error instanceof ApiFailure) {
    return error.message
  }
  if (error instanceof ConnectError) {
    // 机器码只在响应头上；Headers 的取值大小写不敏感，键名统一写小写。
    const machineCode = error.metadata.get(BUDDY_ERROR_HEADER)?.trim()
    if (machineCode) {
      const key = adminErrorText(machineCode)
      // 认不得的码原样透出；包一层兜底文案会把机器码埋掉。
      if (!key) {
        console.warn('[errors]', machineCode)
        return unknownAdminErrorText(machineCode)
      }
      return t(key)
    }
    const detail = error.rawMessage || error.message
    switch (error.code) {
      case Code.Unauthenticated:
        return t('errors.unauthenticated', { detail })
      case Code.PermissionDenied:
        return t('errors.permissionDenied', { detail })
      case Code.NotFound:
        return t('errors.notFound', { detail })
      case Code.InvalidArgument:
        return t('errors.invalidArgument', { detail })
      case Code.AlreadyExists:
        return t('errors.alreadyExists', { detail })
      case Code.Unavailable:
        return t('errors.unavailable', { detail })
      case Code.DeadlineExceeded:
        return t('errors.deadlineExceeded', { detail })
      case Code.Unimplemented:
        return t('errors.unimplemented', { detail })
      case Code.Internal:
        return t('errors.internal', { detail })
      default:
        return t('errors.failed', { code: codeLabel(error.code, t), detail })
    }
  }
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}

function codeLabel(code: Code, t: TFunction): string {
  switch (code) {
    case Code.Canceled:
      return t('errors.code.canceled')
    case Code.Unknown:
      return t('errors.code.unknown')
    case Code.InvalidArgument:
      return t('errors.code.invalidArgument')
    case Code.DeadlineExceeded:
      return t('errors.code.deadlineExceeded')
    case Code.NotFound:
      return t('errors.code.notFound')
    case Code.AlreadyExists:
      return t('errors.code.alreadyExists')
    case Code.PermissionDenied:
      return t('errors.code.permissionDenied')
    case Code.ResourceExhausted:
      return t('errors.code.resourceExhausted')
    case Code.FailedPrecondition:
      return t('errors.code.failedPrecondition')
    case Code.Aborted:
      return t('errors.code.aborted')
    case Code.OutOfRange:
      return t('errors.code.outOfRange')
    case Code.Unimplemented:
      return t('errors.code.unimplemented')
    case Code.Internal:
      return t('errors.code.internal')
    case Code.Unavailable:
      return t('errors.code.unavailable')
    case Code.DataLoss:
      return t('errors.code.dataLoss')
    case Code.Unauthenticated:
      return t('errors.code.unauthenticated')
    default:
      return String(code)
  }
}

/**
 * 401 的时候要把面板送回令牌输入页。
 *
 * 403 不算：那是「令牌没问题，只是不许」，把令牌清掉反而更糟。
 */
export function isAuthError(error: unknown): boolean {
  return error instanceof ConnectError && error.code === Code.Unauthenticated
}

/**
 * 后端给的话是「中文（机器码）」。
 *
 * 机器码是给日志看的，不甩给人：面板上只显示中文那半句。括号里也是中文的
 * （比如「每日签到（连签 2 天）」）就整句留着。
 */
export function humanMessage(
  message: string | undefined | null
): string {
  const text = (message ?? '').trim()
  if (!text) return ''
  // 机器码：括号里没有中文的那些。后端给的是「中文（机器码）。（English (code)）」
  // 这种形状，括号里还套着括号 —— 从最里层开始剥，剥到没有为止。
  let stripped = text
  for (let i = 0; i < 5; i++) {
    const next = stripped
      .replace(/[（(][^（()）]*[)）]/g, (whole) =>
        /[\u4e00-\u9fff]/.test(whole) ? whole : ''
      )
      .trim()
    if (next === stripped) break
    stripped = next
  }
  return stripped || text
}
