import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runTracelessVerification,
  setCaptchaLoaderForTest,
  type AliyunCaptchaSdk,
  type CaptchaInstance,
  type SdkMessage,
} from '@/features/upstreams/aliyun-captcha'

/** 页面里真的挂两个节点：SDK 要求它们存在，假实现也照这个规矩验。 */
function nodes() {
  const host = document.createElement('div')
  const button = document.createElement('button')
  document.body.append(host, button)
  return {
    element: host,
    button,
    cleanup: () => {
      host.remove()
      button.remove()
    },
  }
}

/** 一套记录调用顺序的假 SDK。 */
function fakeSdk(opts: {
  success?: SdkMessage
  error?: SdkMessage
  initThrows?: Error
  startThrows?: Error
} = {}) {
  const calls: string[] = []
  let gotConfig: Record<string, unknown> | undefined
  const instance: CaptchaInstance = {
    startTracelessVerification(callback, onError) {
      calls.push('start')
      if (opts.startThrows) throw opts.startThrows
      if (opts.error) onError(opts.error)
      else if (opts.success) callback(opts.success)
      // 都不给：等超时。
    },
  }
  const sdk: AliyunCaptchaSdk = {
    initAliyunCaptcha(config, onReady) {
      calls.push('init')
      gotConfig = config
      if (opts.initThrows) throw opts.initThrows
      onReady?.(instance)
    },
  }
  return { sdk, calls, configOf: () => gotConfig }
}

afterEach(() => {
  setCaptchaLoaderForTest(null)
  document.querySelectorAll('script[src*="AliyunCaptcha.js"]').forEach((s) => s.remove())
})

describe('阿里云无感验证码封装', () => {
  it('成功：按 加载 → init → start 的顺序走，init 带齐场景、节点与中文，param 原样交出', async () => {
    const { element, button, cleanup } = nodes()
    const { sdk, calls, configOf } = fakeSdk({
      success: { captchaVerifyParam: 'param-TESTONLY', certifyId: 'cert-1' },
    })
    setCaptchaLoaderForTest(async () => sdk)

    const result = await runTracelessVerification({
      sceneId: 'scene-1',
      prefix: 'prefix-1',
      region: 'cn',
      element,
      button,
    })

    expect(result).toEqual({
      ok: true,
      param: 'param-TESTONLY',
      certifyId: 'cert-1',
    })
    expect(calls).toEqual(['init', 'start'])
    expect(configOf()).toMatchObject({
      SceneId: 'scene-1',
      prefix: 'prefix-1',
      region: 'cn',
      mode: 'no_Captcha',
      language: 'cn',
      element,
      button,
    })
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

  it('加载到了但没有 init 入口：也是 script 失败，不是「验证码没过」', async () => {
    const { element, button, cleanup } = nodes()
    // 脚本加载完了但 SDK 没挂上来：用不完整形状模拟第三方改了版本。
    setCaptchaLoaderForTest(async () => ({}) as AliyunCaptchaSdk)

    const result = await runTracelessVerification({
      sceneId: 's', prefix: 'p', region: '', element, button,
    })
    expect(result).toMatchObject({ ok: false, stage: 'script' })
    cleanup()
  })

  it('节点不在页面上：先报 init 失败，不调 SDK（避免 elementError）', async () => {
    const { element, button } = nodes()
    element.remove()
    const { sdk, calls } = fakeSdk({ success: { captchaVerifyParam: 'p' } })
    setCaptchaLoaderForTest(async () => sdk)

    const result = await runTracelessVerification({
      sceneId: 's', prefix: 'p', region: '', element, button,
    })
    expect(result).toMatchObject({ ok: false, stage: 'init', code: 'ELEMENT_MISSING' })
    expect(calls).toEqual([])
    button.remove()
  })

  it('init 抛错：报 init 层，带 INIT_FAIL', async () => {
    const { element, button, cleanup } = nodes()
    const { sdk } = fakeSdk({ initThrows: new Error('配置不合法') })
    setCaptchaLoaderForTest(async () => sdk)

    const result = await runTracelessVerification({
      sceneId: 's', prefix: 'p', region: '', element, button,
    })
    expect(result).toMatchObject({ ok: false, stage: 'init', code: 'INIT_FAIL' })
    cleanup()
  })

  it.each([
    ['INIT_FAIL', 'device'],
    ['DEVICE_INIT_FAIL', 'device'],
    ['DYNAMICJS_FAIL', 'verification'],
    ['LIMIT_FLOW', 'verification'],
  ])('SDK 错误码 %s 落在 %s 层，原话留着', async (code, stage) => {
    const { element, button, cleanup } = nodes()
    const { sdk } = fakeSdk({
      error: { code, message: `上游说 ${code}` },
    })
    setCaptchaLoaderForTest(async () => sdk)

    const result = await runTracelessVerification({
      sceneId: 's', prefix: 'p', region: '', element, button,
    })
    expect(result).toMatchObject({ ok: false, stage, code })
    expect(result.ok === false && result.message).toBe(`上游说 ${code}`)
    cleanup()
  })

  it('回调里没有 param：报拿不到结果，不把「不知道」说成「没通过」', async () => {
    const { element, button, cleanup } = nodes()
    const { sdk } = fakeSdk({ success: { certifyId: '只有 id' } })
    setCaptchaLoaderForTest(async () => sdk)

    const result = await runTracelessVerification({
      sceneId: 's', prefix: 'p', region: '', element, button,
    })
    expect(result).toMatchObject({ ok: false, stage: 'verification', code: '' })
    expect(result.ok === false && result.message).toContain('没有给出')
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
    // 真加载器会去动 script 节点；这里只确认注入被清掉了，不发真请求：
    // 用一个假的 document 让 appendChild 落空，load 也不会触发，直接用超时收口。
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
