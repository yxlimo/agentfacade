/**
 * 阿里云无感验证码，只在这一层碰浏览器。
 *
 * SDK 是浏览器脚本，只能在操作者的浏览器里跑：它要往页面里塞节点、读设备指纹，
 * 拿到的 token 也是给这一次浏览器会话用的。后端只收结果，不碰 SDK。
 *
 * 三条硬规矩：
 *
 * 1. 脚本从 CDN 拉一次。失败单独报一层（`script`），别和「init 失败」混在一起；
 * 2. 初始化之前 element 与 button 两个节点必须真的在 DOM 里，不然 SDK 会当场
 *    `elementError`，那不是验证码没过，是我们没把节点放好；
 * 3. 对外只暴露 `runTracelessVerification`，错误分层返回，不抛出 —— 调用方拿
 *    `{ ok: false, stage }` 决定怎么说人话，不靠异常类型猜。
 */

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
  /** 无感校验没过（DYNAMICJS_FAIL、LIMIT_FLOW 等）。 */
  | 'verification'
  /** 等回调等超时了：不知道结果，不能当成「没通过」。 */
  | 'timeout'

/** 一封 SDK 的回调消息。码是阿里云给的，原样留着，别翻译成猜测。 */
export interface SdkMessage {
  code?: string
  message?: string
  captchaVerifyParam?: string
  certifyId?: string
}

/** SDK 的实例（从 init 回调里拿到）。 */
export interface CaptchaInstance {
  startTracelessVerification: (
    callback: (message: SdkMessage) => void,
    onError: (message: SdkMessage) => void
  ) => void
}

/** SDK 挂在 window 上的入口。只在加载完成后读。 */
export interface AliyunCaptchaSdk {
  initAliyunCaptcha: (
    config: Record<string, unknown>,
    onReady?: (instance: CaptchaInstance) => void
  ) => void
}

/** 初始化时给 SDK 的配置。`element` / `button` 由调用方给真实节点。 */
export interface TracelessConfig {
  sceneId: string
  prefix: string
  region: string
  /** 页面里那个隐藏容器，SDK 会把验证控件挂进去。 */
  element: HTMLElement
  /** 要点按钮的节点：SDK 靠它绑事件、读位置。 */
  button: HTMLElement
  /** 等无感回调多久。 */
  timeoutMs?: number
}

/** 成功：param 是给 ClaimZcodePlan 的那一次性凭据。 */
export type TracelessResult =
  | { ok: true; param: string; certifyId: string }
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
      // 别人已经插了：等它的 load/error，别插第二份。
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('SDK 脚本加载失败')), {
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
      () => reject(new Error('SDK 脚本加载失败')),
      { once: true }
    )
    ;(doc.head ?? doc.documentElement).appendChild(script)
  })
  // 加载失败要能重试：把状态清掉，下次点击重新拉（比如网络恢复了）。
  void scriptLoad.catch(() => {
    scriptLoad = null
  })
  return scriptLoad
}

/**
 * 注入假的 SDK 加载器（单测 / e2e 用）。
 *
 * 测试绝不访问 CDN。传 null 恢复默认（真浏览器加载）。
 */
export function setCaptchaLoaderForTest(
  loader: (() => Promise<AliyunCaptchaSdk>) | null
): void {
  testHook.load = loader ?? undefined
}

/** 测试注入点，生产里没人写它。 */
const testHook: { load?: () => Promise<AliyunCaptchaSdk> } = {}

function sdkOf(win: Window & typeof globalThis): AliyunCaptchaSdk | undefined {
  const candidate = (win as Window & typeof globalThis & {
    initAliyunCaptcha?: unknown
  }).initAliyunCaptcha
  return typeof candidate === 'function'
    ? (win as Window & typeof globalThis & AliyunCaptchaSdk)
    : undefined
}

/**
 * 跑一次无感校验。
 *
 * 顺序固定：加载脚本 → 检查两个节点还在 → init → startTracelessVerification →
 * 等回调。每一步失败都带 stage 与 SDK 原话，调用方能分清「没加载出来」「节点
 * 没放好」「设备没过」「无感没过」「等不到结果」。
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
      message: 'SDK 加载完没有 initAliyunCaptcha',
    }
  }

  // SDK 会在 init 里立刻查这两个节点。文档里找不到就别往下走 —— 那报出来
  // 是 elementError，不是验证码没通过，重试也一样。
  if (!config.element.isConnected || !config.button.isConnected) {
    return {
      ok: false,
      stage: 'init',
      code: 'ELEMENT_MISSING',
      message: '验证码的容器或按钮不在页面上',
    }
  }

  const timeoutMs = config.timeoutMs ?? 10000
  return await new Promise<TracelessResult>((resolve) => {
    let settled = false
    let timer: number | undefined
    const finish = (result: TracelessResult) => {
      if (settled) return
      settled = true
      if (timer !== undefined) win.clearTimeout(timer)
      resolve(result)
    }

    const callback = (raw: SdkMessage) => {
      if (!raw || typeof raw.captchaVerifyParam !== 'string' || raw.captchaVerifyParam === '') {
        // 有码就用它的码（DYNAMICJS_FAIL 等）；没有码也别把「不知道」说成
        // 「没通过」—— 这里是拿不到 token，不是上游拒了 token。
        finish({
          ok: false,
          stage: 'verification',
          code: raw?.code ?? '',
          message: raw?.message ?? '无感校验没有给出 verify param',
        })
        return
      }
      finish({
        ok: true,
        param: raw.captchaVerifyParam,
        certifyId: raw.certifyId ?? '',
      })
    }
    const onError = (raw: SdkMessage) => {
      const code = raw?.code ?? ''
      finish({
        ok: false,
        stage:
          code === 'INIT_FAIL' || code === 'DEVICE_INIT_FAIL'
            ? 'device'
            : 'verification',
        code,
        message: raw?.message ?? '无感校验失败',
      })
    }

    timer = win.setTimeout(() => {
      finish({
        ok: false,
        stage: 'timeout',
        code: 'TIMEOUT',
        message: `等无感校验结果超过 ${timeoutMs} 毫秒`,
      })
    }, timeoutMs)

    // 有些 SDK 在 init 里同步回调 onReady，所以 start 必须先定义好。
    let started = false
    function start(instance: CaptchaInstance) {
      if (started || settled) return
      started = true
      try {
        instance.startTracelessVerification(callback, onError)
      } catch (error) {
        finish({
          ok: false,
          stage: 'verification',
          code: 'VERIFICATION_FAIL',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }

    try {
      // 新版 SDK：init 的第二个参数是「就绪」回调，实例由它给。
      // 旧版 SDK：没有第二参数，实例挂在 window 上。两种都认。
      sdk.initAliyunCaptcha(
        {
          SceneId: config.sceneId,
          prefix: config.prefix,
          region: config.region,
          mode: 'no_Captcha',
          language: 'cn',
          element: config.element,
          button: config.button,
          callback,
        },
        (instance: CaptchaInstance) => {
          start(instance)
        }
      )
      const fallback = (win as Window & typeof globalThis & {
        aliyunCaptchaInstance?: CaptchaInstance
      }).aliyunCaptchaInstance
      if (fallback) start(fallback)
    } catch (error) {
      finish({
        ok: false,
        stage: 'init',
        code: 'INIT_FAIL',
        message: error instanceof Error ? error.message : String(error),
      })
    }

  })
}
