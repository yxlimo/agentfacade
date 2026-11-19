import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runTracelessVerification,
  setCaptchaLoaderForTest,
  type AliyunCaptchaSdk,
  type CaptchaInstance,
  type SdkMessage,
} from '@/features/upstreams/aliyun-captcha'

/** 页面里真的挂两个节点：SDK 用 CSS 选择器取它们，假实现也照这个规矩验。 */
function nodes() {
  const host = document.createElement('div')
  host.id = 'captcha-host-TESTONLY'
  const button = document.createElement('button')
  button.id = 'captcha-button-TESTONLY'
  document.body.append(host, button)
  return {
    element: `#${host.id}`,
    button: `#${button.id}`,
    host,
    buttonNode: button,
    cleanup: () => {
      host.remove()
      button.remove()
    },
  }
}

type Params = Parameters<AliyunCaptchaSdk['initAliyunCaptcha']>[0]

/**
 * 照公开 AliyunCaptcha.js 的形状实现假 SDK：
 * 一个参数对象，四回调都在里面；mode 只收 popup/embed；element/button 是选择器。
 */
function fakeSdk(opts: {
  success?: string
  error?: SdkMessage
  initThrow?: (params: Params) => Error | undefined
  badMode?: boolean
  startThrow?: Error
  withoutTraceless?: boolean
  tracelessCallsArgs?: (args: unknown[]) => void
  show?: (instance: CaptchaInstance) => void
} = {}) {
  const calls: string[] = []
  let gotParams: Params | undefined
  const instance: CaptchaInstance = {
    startTracelessVerification:
      opts.withoutTraceless === true
        ? undefined
        : (...args: unknown[]) => {
            calls.push('start')
            opts.tracelessCallsArgs?.(args)
            if (opts.startThrow) throw opts.startThrow
            if (opts.success !== undefined) gotParams?.success(opts.success)
            else if (opts.error) gotParams?.onError(opts.error)
          },
    show: () => {
      calls.push('show')
      opts.show?.(instance)
      // 交互式过了也走同一个 success 回调，参数是原样的字符串。
      if (opts.success !== undefined) gotParams?.success(opts.success)
    },
  }
  const sdk: AliyunCaptchaSdk = {
    initAliyunCaptcha(params) {
      calls.push('init')
      const effective = opts.badMode
        ? ({ ...params, mode: 'no_Captcha' } as unknown as Params)
        : params
      gotParams = effective
      if (!['popup', 'embed'].includes(effective.mode)) {
        throw new Error(
          'modeError: 目前支持弹出式（popup）和嵌入式（embed）。请参见mode参数说明检查此参数是否符合要求。'
        )
      }
      if (typeof params.element !== 'string' || typeof params.button !== 'string') {
        throw new Error('elementError: 参数必须是 CSS 选择器字符串')
      }
      const initError = opts.initThrow?.(effective)
      if (initError) throw initError
      effective.getInstance(instance)
    },
  }
  return { sdk, calls, paramsOf: () => gotParams }
}

afterEach(() => {
  setCaptchaLoaderForTest(null)
  document.querySelectorAll('script[src*="AliyunCaptcha.js"]').forEach((s) => s.remove())
  delete (window as Window & { AliyunCaptchaConfig?: unknown }).AliyunCaptchaConfig
})

describe('阿里云验证码封装', () => {
  it('成功：Config 先设 → init(四回调) → 无参 start，param 原样交出', async () => {
    const { element, button, cleanup } = nodes()
    const { sdk, calls, paramsOf } = fakeSdk({
      success: 'param-TESTONLY',
    })
    setCaptchaLoaderForTest(async () => sdk)

    const result = await runTracelessVerification({
      sceneId: 'scene-1',
      prefix: 'prefix-1',
      region: 'cn',
      element,
      button,
    })

    expect(result).toEqual({ ok: true, param: 'param-TESTONLY', interactive: false })
    expect(calls).toEqual(['init', 'start'])
    expect(paramsOf()).toMatchObject({
      SceneId: 'scene-1',
      prefix: 'prefix-1',
      region: 'cn',
      mode: 'popup',
      language: 'cn',
      showErrorTip: false,
      element,
      button,
    })
    expect(typeof paramsOf()?.getInstance).toBe('function')
    expect(typeof paramsOf()?.success).toBe('function')
    expect(typeof paramsOf()?.fail).toBe('function')
    expect(typeof paramsOf()?.onError).toBe('function')
    expect((window as Window & { AliyunCaptchaConfig?: unknown }).AliyunCaptchaConfig).toEqual({
      region: 'cn',
      prefix: 'prefix-1',
    })
    cleanup()
  })

  it('守门：mode 不是 popup/embed 时假 SDK 抛 modeError，报成 init 层', async () => {
    const { element, button, cleanup } = nodes()
    const { sdk } = fakeSdk({
      // 模拟旧实现把 mode 写成不存在的值：假 SDK 按真 SDK 校验抛 modeError。
      badMode: true,
    })
    setCaptchaLoaderForTest(async () => sdk)

    const result = await runTracelessVerification({
      sceneId: 's', prefix: 'p', region: 'cn', element, button,
    })
    expect(result).toMatchObject({ ok: false, stage: 'init', code: 'modeError' })
    expect(result.ok === false && result.message).toContain('modeError')
    cleanup()
  })

  it('守门：注入脚本之前 window.AliyunCaptchaConfig 已经设好', async () => {
    const { element, button, cleanup } = nodes()
    const seen: Array<Record<string, unknown> | undefined> = []
    const { sdk } = fakeSdk({ success: 'p' })
    setCaptchaLoaderForTest(async () => {
      seen.push(
        (window as Window & { AliyunCaptchaConfig?: Record<string, unknown> }).AliyunCaptchaConfig
      )
      return sdk
    })
    await runTracelessVerification({
      sceneId: 's', prefix: 'pfx-1', region: 'sg', element, button,
    })
    expect(seen).toEqual([{ region: 'sg', prefix: 'pfx-1' }])
    cleanup()
  })

  it('守门：element/button 传的是 CSS 选择器字符串，不是 DOM 节点', async () => {
    const { element, button, cleanup } = nodes()
    const { sdk, paramsOf } = fakeSdk({ success: 'p' })
    setCaptchaLoaderForTest(async () => sdk)
    await runTracelessVerification({
      sceneId: 's', prefix: 'p', region: 'cn', element, button,
    })
    expect(paramsOf()?.element).toBe(element)
    expect(paramsOf()?.button).toBe(button)
    expect(typeof paramsOf()?.element).toBe('string')
    expect(typeof paramsOf()?.button).toBe('string')
    cleanup()
  })

  it('守门：无感不可用时 show() 走交互式，结果标记 interactive', async () => {
    const { element, button, cleanup } = nodes()
    const tracelessArgs: unknown[][] = []
    for (const variant of ['missing', 'throws'] as const) {
      const { sdk, calls } = fakeSdk({
        success: 'interactive-param-TESTONLY',
        withoutTraceless: variant === 'missing',
        startThrow:
          variant === 'throws'
            ? new Error('Traceless verification is unavailable for this captcha instance.')
            : undefined,
        tracelessCallsArgs: (args) => {
          tracelessArgs.push(args)
        },
      })
      setCaptchaLoaderForTest(async () => sdk)
      const result = await runTracelessVerification({
        sceneId: 's', prefix: 'p', region: 'cn', element, button,
      })
      expect(result).toEqual({ ok: true, param: 'interactive-param-TESTONLY', interactive: true })
      expect(calls).toEqual(variant === 'missing' ? ['init', 'show'] : ['init', 'start', 'show'])
      expect(tracelessArgs).toEqual(variant === 'missing' ? [] : [[]])
    }
    cleanup()
  })

  it('无感方法抛别的错时报验证层，不冒充交互式', async () => {
    const { element, button, cleanup } = nodes()
    const { sdk } = fakeSdk({ startThrow: new Error('设备指纹失败') })
    setCaptchaLoaderForTest(async () => sdk)
    const result = await runTracelessVerification({
      sceneId: 's', prefix: 'p', region: 'cn', element, button,
    })
    expect(result).toMatchObject({ ok: false, stage: 'verification', message: '设备指纹失败' })
    cleanup()
  })

  it('脚本加载失败：报 script 这一层，不往下走 init', async () => {
    const { element, button, cleanup } = nodes()
    setCaptchaLoaderForTest(async () => {
      throw new Error('CDN 不可达')
    })
    const result = await runTracelessVerification({
      sceneId: 's', prefix: 'p', region: '', element, button,
    })
    expect(result).toMatchObject({ ok: false, stage: 'script' })
    expect(result.ok === false && result.message).toContain('CDN 不可达')
    cleanup()
  })

  it('加载到了但没有 init 入口：也是 script 失败', async () => {
    const { element, button, cleanup } = nodes()
    setCaptchaLoaderForTest(async () => ({}) as AliyunCaptchaSdk)
    const result = await runTracelessVerification({
      sceneId: 's', prefix: 'p', region: '', element, button,
    })
    expect(result).toMatchObject({ ok: false, stage: 'script' })
    cleanup()
  })

  it('选择器找不到节点：先报 init 失败，不调 SDK', async () => {
    const { element, button, host, cleanup } = nodes()
    host.remove()
    const { sdk, calls } = fakeSdk({ success: 'p' })
    setCaptchaLoaderForTest(async () => sdk)
    const result = await runTracelessVerification({
      sceneId: 's', prefix: 'p', region: '', element, button,
    })
    expect(result).toMatchObject({ ok: false, stage: 'init', code: 'ELEMENT_MISSING' })
    expect(calls).toEqual([])
    cleanup()
  })

  it('init 抛错：报 init 层，带 SDK 原文', async () => {
    const { element, button, cleanup } = nodes()
    const { sdk } = fakeSdk({ initThrow: () => new Error('配置不合法') })
    setCaptchaLoaderForTest(async () => sdk)
    const result = await runTracelessVerification({
      sceneId: 's', prefix: 'p', region: '', element, button,
    })
    expect(result).toMatchObject({ ok: false, stage: 'init', code: 'INIT_FAIL', message: '配置不合法' })
    cleanup()
  })

  it.each([
    ['INIT_FAIL', 'device'],
    ['DEVICE_INIT_FAIL', 'device'],
    ['DYNAMICJS_FAIL', 'verification'],
    ['LIMIT_FLOW', 'verification'],
    ['T001', 'verification'],
    ['F001', 'verification'],
  ])('SDK 错误码 %s 落在 %s 层，msg 原话留着', async (code, stage) => {
    const { element, button, cleanup } = nodes()
    const { sdk } = fakeSdk({ error: { code, msg: `上游说 ${code}` } })
    setCaptchaLoaderForTest(async () => sdk)
    const result = await runTracelessVerification({
      sceneId: 's', prefix: 'p', region: '', element, button,
    })
    expect(result).toMatchObject({ ok: false, stage, code })
    expect(result.ok === false && result.message).toBe(`上游说 ${code}`)
    cleanup()
  })

  it('success 收到空串：报拿不到结果，不把「不知道」说成「没通过」', async () => {
    const { element, button, cleanup } = nodes()
    const { sdk } = fakeSdk({ success: '' })
    setCaptchaLoaderForTest(async () => sdk)
    const result = await runTracelessVerification({
      sceneId: 's', prefix: 'p', region: '', element, button,
    })
    expect(result).toMatchObject({ ok: false, stage: 'verification', code: '' })
    expect(result.ok === false && result.message).toContain('没有给出')
    cleanup()
  })

  it('fail 回调也报验证层', async () => {
    const { element, button, cleanup } = nodes()
    const { sdk } = fakeSdk({
      withoutTraceless: true,
      show: () => {
        // 交互式失败走 fail，而不是 success。
      },
    })
    setCaptchaLoaderForTest(async () => sdk)
    const result = await runTracelessVerification({
      sceneId: 's', prefix: 'p', region: '', element, button,
    })
    expect(result.ok).toBe(false)
    cleanup()
  })

  it('一直没回调：报 timeout 层', async () => {
    const { element, button, cleanup } = nodes()
    const { sdk } = fakeSdk()
    setCaptchaLoaderForTest(async () => sdk)
    const result = await runTracelessVerification({
      sceneId: 's', prefix: 'p', region: '', element, button, timeoutMs: 20,
    })
    expect(result).toMatchObject({ ok: false, stage: 'timeout', code: 'TIMEOUT' })
    cleanup()
  })

  it('测试注入是进程级的：传 null 之后不再用上一份假实现', async () => {
    const { element, button, cleanup } = nodes()
    const spy = vi.fn(async () => fakeSdk().sdk)
    setCaptchaLoaderForTest(spy)
    setCaptchaLoaderForTest(null)
    const fakeDoc = {
      querySelector: () => null,
      createElement: () => ({
        addEventListener(event: string, handler: () => void) {
          if (event === 'error') queueMicrotask(handler)
        },
        src: '',
      }),
      head: { appendChild() {} },
    } as unknown as Document
    const result = await runTracelessVerification(
      { sceneId: 's', prefix: 'p', region: '', element, button, timeoutMs: 10 },
      { document: fakeDoc }
    )
    expect(spy).not.toHaveBeenCalled()
    expect(result).toMatchObject({ ok: false, stage: 'script' })
    cleanup()
  })
})
