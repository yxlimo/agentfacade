/**
 * 阿里云验证码，只在这一层碰浏览器。
 *
 * SDK 是浏览器脚本，只能在操作者的浏览器里跑：它要往页面里塞节点、读设备指纹，
 * 拿到的 token 也是给这一次浏览器会话用的。后端只收结果，不碰 SDK。
 *
 * 调用序列照公开 SDK（AliyunCaptcha.js 1.3.7）来：
 * window.AliyunCaptchaConfig 先设，再注入脚本，initAliyunCaptcha 一个参数对象
 * （四个回调都在对象里），instance 从 getInstance 拿，最后无参调用
 * startTracelessVerification。mode 只有 popup / embed，element / button 是 CSS
 * 选择器字符串。
 *
 * 错误分层：脚本加载 / init / 验证 / 超时。SDK 的 code 与 msg 原样带上。
 * 面板自己写的提示走词典；SDK 的原话不翻译。
 */

import i18n from '@/lib/i18n'

const SDK_URL =
  'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'

/** 失败发生在哪一步。名字是给日志看的，界面文案在 claim-result.ts。 */
export type CaptchaFailureStage =
  /** CDN 脚本没加载出来（网络、CSP、第三方挂了）。 */
  | 'script'
  /** `initAliyunCaptcha` 没接受这份配置或节点。 */
  | 'init'
  /** SDK 初始化本身报错（INIT_FAIL、DEVICE_INIT_FAIL 等）。 */
  | 'device'
  /** 验证没过（DYNAMICJS_FAIL、LIMIT_FLOW、T 开头或 F 开头的业务码等）。 */
  | 'verification'
  /** 等回调等超时了：不知道结果，不能当成「没通过」。 */
  | 'timeout'

/** 一封 SDK 的回调消息。code/msg 是 SDK 原话；param 是验证通过的凭据。 */
export interface SdkMessage {
  code?: string
  msg?: string
  message?: string
  captchaVerifyParam?: string
}

/** SDK 的实例（从 getInstance 回调里拿到）。 */
export interface CaptchaInstance {
  startTracelessVerification?: () => void
  show?: () => void
}

/**
 * SDK 挂在 window 上的入口。四个回调都在同一个参数对象里。
 *
 * success 的第一个参数直接就是 X-Aliyun-Captcha-Verify-Param 的值：
 * SDK 源码 `e.success(u.CertifyId)` / `e.success(btoa({certifyId,sceneId,isSign}))`。
 * 这里不解析、不重组，原样交给 RPC。
 */
export interface AliyunCaptchaSdk {
  initAliyunCaptcha: (params: {
    SceneId: string
    region: string
    prefix: string
    mode: 'popup' | 'embed'
    language: string
    captchaLogoImg?: string
    showErrorTip: boolean
    element: string
    button: string
    getInstance: (instance: CaptchaInstance) => void
    success: (param: string) => void
    fail: (message: SdkMessage) => void
    onError: (message: SdkMessage) => void
  }) => void
}

/** 初始化时给 SDK 的配置。`element` / `button` 是页面上节点的选择器。 */
export interface TracelessConfig {
  sceneId: string
  prefix: string
  region: string
  /** 页面里那个隐藏容器的 CSS 选择器。 */
  element: string
  /** 真实 button 的 CSS 选择器。 */
  button: string
  /** 等回调多久。 */
  timeoutMs?: number
}

/**
 * 成功：param 原样交给 ClaimZcodePlan。
 * interactive 为 true 表示无感不可用，这次是 instance.show() 走交互式过的。
 */
export type TracelessResult =
  | { ok: true; param: string; interactive: boolean }
  | {
      ok: false
      stage: CaptchaFailureStage
      /** SDK 的码，没给就是空串。 */
      code: string
      /** SDK 的原话，没给就是空串。 */
      message: string
    }

/** 脚本加载的状态：同一个页面只拉一次，失败也别一遍遍重试。 */
let scriptLoad: Promise<void> | null = null

function loadScript(doc: Document): Promise<void> {
  if (scriptLoad) return scriptLoad
  scriptLoad = new Promise<void>((resolve, reject) => {
    const existing = doc.querySelector<HTMLScriptElement>(
      `script[src="${SDK_URL}"]`
    )
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error(i18n.t('upstreams.captchaScriptLoadFail'))), {
        once: true,
      })
      return
    }
    const script = doc.createElement('script')
    script.src = SDK_URL
    script.async = true
    script.addEventListener('load', () => resolve(), { once: true })
    script.addEventListener(
      'error',
      () => reject(new Error(i18n.t('upstreams.captchaScriptLoadFail'))),
      { once: true }
    )
    ;(doc.head ?? doc.documentElement).appendChild(script)
  })
  void scriptLoad.catch(() => {
    scriptLoad = null
  })
  return scriptLoad
}

/**
 * 注入假的 SDK 加载器（单测 / e2e 用）。传 null 恢复默认。
 *
 * 测试绝不访问 CDN。
 */
export function setCaptchaLoaderForTest(
  loader: (() => Promise<AliyunCaptchaSdk>) | null
): void {
  testHook.load = loader ?? undefined
}

/** 测试注入点，生产里没人写它。 */
const testHook: { load?: () => Promise<AliyunCaptchaSdk> } = {}

type CaptchaWindow = Window & typeof globalThis & {
  initAliyunCaptcha?: unknown
  AliyunCaptchaConfig?: unknown
}

function sdkOf(win: Window & typeof globalThis): AliyunCaptchaSdk | undefined {
  const candidate = (win as CaptchaWindow).initAliyunCaptcha
  return typeof candidate === 'function'
    ? (win as Window & typeof globalThis & AliyunCaptchaSdk)
    : undefined
}

/**
 * 无感不可用的两种形态：实例没有方法，或方法抛 SDK 的那句固定错误。
 */
function isTracelessUnavailable(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === 'Traceless verification is unavailable for this captcha instance.'
  )
}

/**
 * 跑一次验证码。
 *
 * 顺序：设 AliyunCaptchaConfig → 加载脚本 → init（四回调）→ getInstance
 * → startTracelessVerification()；无感不可用时 show() 走交互式。
 */
export async function runTracelessVerification(
  config: TracelessConfig,
  options?: {
    /** 只给测试：换掉 window / document，默认用当前页面。 */
    window?: Window & typeof globalThis
    document?: Document
  }
): Promise<TracelessResult> {
  const win = options?.window ?? window
  const doc = options?.document ?? win.document

  // SDK 在脚本顶层读 window.AliyunCaptchaConfig，所以必须赶在注入之前设。
  ;(win as CaptchaWindow).AliyunCaptchaConfig = {
    region: config.region,
    prefix: config.prefix,
  }

  let sdk: AliyunCaptchaSdk | undefined
  try {
    if (testHook.load) {
      sdk = await testHook.load()
    } else {
      await loadScript(doc)
      sdk = sdkOf(win)
    }
  } catch (error) {
    return {
      ok: false,
      stage: 'script',
      code: '',
      message: error instanceof Error ? error.message : String(error),
    }
  }

  if (!sdk || typeof sdk.initAliyunCaptcha !== 'function') {
    return {
      ok: false,
      stage: 'script',
      code: '',
      message: i18n.t('upstreams.captchaNoInit'),
    }
  }

  // 选择器必须是真的节点：SDK 用 querySelector 取它们，找不到就 elementError。
  if (!doc.querySelector(config.element) || !doc.querySelector(config.button)) {
    return {
      ok: false,
      stage: 'init',
      code: 'ELEMENT_MISSING',
      message: i18n.t('upstreams.captchaElementMissing'),
    }
  }

  const timeoutMs = config.timeoutMs ?? 10000
  return await new Promise<TracelessResult>((resolve) => {
    let settled = false
    let timer: number | undefined
    let interactive = false
    const finish = (result: TracelessResult) => {
      if (settled) return
      settled = true
      if (timer !== undefined) win.clearTimeout(timer)
      resolve(result)
    }

    const messageOf = (raw: SdkMessage | string | undefined) => {
      if (typeof raw === 'string') return { code: '', message: raw }
      return {
        code: raw?.code ?? '',
        message: raw?.msg ?? raw?.message ?? i18n.t('upstreams.captchaFailed'),
      }
    }

    const success = (param: string) => {
      if (typeof param !== 'string' || param === '') {
        finish({
          ok: false,
          stage: 'verification',
          code: '',
          message: i18n.t('upstreams.captchaNoParam'),
        })
        return
      }
      finish({ ok: true, param, interactive })
    }
    const fail = (raw: SdkMessage | string | undefined) => {
      const { code, message } = messageOf(raw)
      finish({ ok: false, stage: 'verification', code, message })
    }
    const onError = (raw: SdkMessage | string | undefined) => {
      const { code, message } = messageOf(raw)
      finish({
        ok: false,
        stage:
          code === 'INIT_FAIL' || code === 'DEVICE_INIT_FAIL'
            ? 'device'
            : 'verification',
        code,
        message,
      })
    }

    timer = win.setTimeout(() => {
      finish({
        ok: false,
        stage: 'timeout',
        code: 'TIMEOUT',
        message: i18n.t('upstreams.captchaTimeout', { ms: timeoutMs }),
      })
    }, timeoutMs)

    const start = (instance: CaptchaInstance) => {
      if (settled) return
      const traceless = instance?.startTracelessVerification
      if (typeof traceless !== 'function') {
        if (typeof instance?.show !== 'function') {
          finish({
            ok: false,
            stage: 'verification',
            code: 'VERIFICATION_FAIL',
            message: i18n.t('upstreams.captchaNoEntry'),
          })
          return
        }
        interactive = true
        instance.show()
        return
      }
      try {
        traceless.call(instance)
      } catch (error) {
        if (!isTracelessUnavailable(error) || typeof instance?.show !== 'function') {
          finish({
            ok: false,
            stage: 'verification',
            code: 'VERIFICATION_FAIL',
            message: error instanceof Error ? error.message : String(error),
          })
          return
        }
        interactive = true
        instance.show()
      }
    }

    try {
      sdk.initAliyunCaptcha({
        SceneId: config.sceneId,
        region: config.region,
        prefix: config.prefix,
        mode: 'popup',
        language: 'cn',
        showErrorTip: false,
        element: config.element,
        button: config.button,
        getInstance: start,
        success,
        fail,
        onError,
      })
    } catch (error) {
      // SDK 自己的 modeError / elementError 就在这里同步抛出来，是 init 层。
      const code =
        error instanceof Error && error.message.includes('modeError')
          ? 'modeError'
          : 'INIT_FAIL'
      finish({
        ok: false,
        stage: 'init',
        code,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  })
}
