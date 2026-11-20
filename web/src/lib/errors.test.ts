import { Code, ConnectError } from '@connectrpc/connect'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_ERROR_TEXT } from '@/lib/admin-errors'
import { ApiFailure, assertOk, describeErrorText, isAuthError } from '@/lib/errors'
import i18n from '@/lib/i18n'
import { zh } from '@/lib/i18n/catalogs/zh'

/** 一次带机器码的失败（机器码在响应头上，和其他头一样）。 */
function withCode(code: string, message = '已经有这个平台了'): ConnectError {
  return new ConnectError(message, Code.AlreadyExists, {
    'buddy-error': code,
  })
}

/** 测试走当前语言的词典，和面板渲染走同一条路。 */
function text(error: unknown): string {
  return describeErrorText(error, i18n.t)
}

describe('把错误翻成人话', () => {
  afterEach(async () => {
    await i18n.changeLanguage('zh')
  })

  it('鉴权未通过时要说明是访问令牌的问题', () => {
    const error = new ConnectError('面板令牌不对。', Code.Unauthenticated)
    const result = text(error)
    expect(result).toContain('鉴权未通过')
    expect(result).toContain('面板令牌不对。')
  })

  it('网关不可用、未实现、参数不合法各说各的', () => {
    expect(text(new ConnectError('连不上', Code.Unavailable))).toContain(
      '网关不可用'
    )
    expect(text(new ConnectError('还没做', Code.Unimplemented))).toContain(
      '未实现该接口'
    )
    expect(text(new ConnectError('键不对', Code.InvalidArgument))).toContain(
      '参数不合法'
    )
  })

  it('业务上的失败（ok:false）原样给用户看', () => {
    expect(text(new ApiFailure('模型至少要有一个上游'))).toBe(
      '模型至少要有一个上游'
    )
  })

  it('不是 Error 的东西也能说点什么', () => {
    expect(text('就是坏了')).toBe('就是坏了')
  })
})

describe('响应头上有机器码时按码给文案', () => {
  afterEach(async () => {
    vi.restoreAllMocks()
    await i18n.changeLanguage('zh')
  })

  it('认得的码：给码表那句话，不带服务端的事实句', () => {
    const result = text(withCode('PLATFORM_ALREADY_EXISTS'))
    expect(result).toBe(i18n.t(ADMIN_ERROR_TEXT.PLATFORM_ALREADY_EXISTS))
    expect(result).not.toContain('已经有这个平台了')
    expect(result).not.toContain('资源已存在')
  })

  it('认不得的码：原样给机器码，并告一声', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = text(withCode('SOMETHING_NEW'))
    expect(result).toBe('SOMETHING_NEW')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('没有那个头：仍按 Connect 的 Code 兜底', () => {
    const error = new ConnectError('键不对', Code.InvalidArgument)
    expect(text(error)).toContain('参数不合法：键不对')
  })

  it('原型键不吃文案：constructor 走「不认得」那一支', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = text(withCode('constructor'))
    expect(result).toBe('constructor')
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('文案键与语言切换', () => {
  afterEach(async () => {
    await i18n.changeLanguage('zh')
  })

  it('每个 errors.* 键都在中文词典里', () => {
    for (const key of Object.keys(ADMIN_ERROR_TEXT)) {
      expect(zh).toHaveProperty(`errors.admin.${key}`)
    }
  })

  it('每个已知错误类别都给出已知键，不把插值留给用户', () => {
    const knownCodes = [...Object.keys(ADMIN_ERROR_TEXT), 'unknown-code']
    const knownErrors: unknown[] = Object.values(Code)
      .filter((code): code is Code => typeof code === 'number')
      .map((code) => new ConnectError('上游原话', code))
      .concat(knownCodes.map((code) => withCode(code)))

    for (const error of knownErrors) {
      for (const lang of ['zh', 'en'] as const) {
        void i18n.changeLanguage(lang)
        const result = text(error)
        expect(result, `${lang}: ${result}`).not.toContain('{{')
        expect(result.trim(), `${lang}: ${result}`).not.toBe('')
      }
    }
  })

  it('带 detail 的类别在英文下 detail 仍是原文', async () => {
    await i18n.changeLanguage('en')
    const result = text(new ConnectError('upstream said no', Code.Unavailable))
    expect(result).toContain('upstream said no')
    expect(result).not.toContain('上游')
  })

  it('页面里长期显示的错误跟着语言变', async () => {
    const error = new ConnectError('boom', Code.InvalidArgument)
    await i18n.changeLanguage('zh')
    const zhText = text(error)
    await i18n.changeLanguage('en')
    const enText = text(error)
    expect(zhText).toContain('参数不合法')
    expect(enText).toContain('Invalid argument')
    expect(enText).not.toBe(zhText)
  })
})

describe('assertOk', () => {
  it('ok 为真就什么都不做', () => {
    expect(() =>
      assertOk({ ok: true, message: '好了' }, i18n.t('config.saveFailed'))
    ).not.toThrow()
  })

  it('ok 为假就抛异常，消息用服务端给的', () => {
    expect(() =>
      assertOk({ ok: false, message: '不认识的上游：xxx' }, '保存失败')
    ).toThrow('不认识的上游：xxx')
  })

  it('服务端没给消息就用兜底的那句', () => {
    expect(() => assertOk({ ok: false }, '保存失败')).toThrow('保存失败')
  })
})

describe('isAuthError', () => {
  it('401 算鉴权失败', () => {
    expect(isAuthError(new ConnectError('x', Code.Unauthenticated))).toBe(true)
  })

  it('403 不计为鉴权失败：访问令牌有效，仅权限不足', () => {
    expect(isAuthError(new ConnectError('x', Code.PermissionDenied))).toBe(false)
  })

  it('别的错误不算', () => {
    expect(isAuthError(new ConnectError('x', Code.Internal))).toBe(false)
    expect(isAuthError(new Error('x'))).toBe(false)
  })
})
