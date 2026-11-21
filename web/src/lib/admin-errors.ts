/**
 * 管理接口失败的机器码 → 面板文案。
 *
 * 后端失败时抛 Connect 错误：错误消息里放排查用的事实（哪个 id、上游原文），
 * 机器码放在响应头 `buddy-error` 上。给人看的那句话在面板这一侧，按码查表，
 * 同一件事不会在两侧各写一份中文。
 *
 * 文案只讲哪里错了：一句话，陈述事实，不给操作建议（不写「请」「填一个」
 * 「换一个」「刷新页面」「稍后重试」这类话）。理由是正常的错在面板上已经
 * 被提前挡住、根本点不出来，剩下的都是少见情况，指引只会变成废话。
 *
 * 其余规矩：不复述字段名，不提实现，不写设计取舍；每条不超过 20 汉字。
 * 一个码一句话，两句一样就说明两个码分不清原因。
 */

import type { zh } from '@/lib/i18n/catalogs/zh'

/** 机器码所在的响应头。拼写固定小写（取值时大小写不敏感，键名统一写小写）。 */
export const BUDDY_ERROR_HEADER = 'buddy-error'

/**
 * 映射只给稳定的词条键，不在这里调 t()。
 *
 * 原因：这个函数会被非组件代码（mutation 的 onError、toast）调用，在那些
 * 地方定型语言，切语言后已经存下的文案就不会再变。渲染边界再翻译，按
 * i18n 当前语言取词；未知码原样透传，以免把机器码埋进兜底文案里。
 */
export type AdminErrorKey = keyof typeof zh

/**
 * 码表。键是后端 `lib/admin/error-codes.ts` 里的机器码，值是面板文案。
 *
 * 查表一律走 `adminErrorText`，不要直接下标取：`TABLE['constructor']` 会取到
 * 原型上的东西，看上去像认得这个码。
 */
export const ADMIN_ERROR_TEXT: Readonly<Record<string, AdminErrorKey>> = {
  // 平台
  PLATFORM_ID_MISSING: 'errors.admin.PLATFORM_ID_MISSING',
  PLATFORM_ID_INVALID: 'errors.admin.PLATFORM_ID_INVALID',
  PLATFORM_ID_RESERVED: 'errors.admin.PLATFORM_ID_RESERVED',
  PLATFORM_ID_TAKEN_BY_ACCOUNT: 'errors.admin.PLATFORM_ID_TAKEN_BY_ACCOUNT',
  PLATFORM_ID_NOT_PRESET: 'errors.admin.PLATFORM_ID_NOT_PRESET',
  PLATFORM_ALREADY_EXISTS: 'errors.admin.PLATFORM_ALREADY_EXISTS',
  PLATFORM_LABEL_MISSING: 'errors.admin.PLATFORM_LABEL_MISSING',
  PLATFORM_BASE_URL_MISSING: 'errors.admin.PLATFORM_BASE_URL_MISSING',
  PLATFORM_BASE_URL_INVALID: 'errors.admin.PLATFORM_BASE_URL_INVALID',
  PLATFORM_KIND_UNKNOWN: 'errors.admin.PLATFORM_KIND_UNKNOWN',
  PLATFORM_KIND_NOT_CREATABLE: 'errors.admin.PLATFORM_KIND_NOT_CREATABLE',
  PLATFORM_KIND_FIXED: 'errors.admin.PLATFORM_KIND_FIXED',
  PLATFORM_NOT_FOUND: 'errors.admin.PLATFORM_NOT_FOUND',
  PLATFORM_WRITE_FAILED: 'errors.admin.PLATFORM_WRITE_FAILED',

  // 开放平台的注入头模板
  PLATFORM_HEADERS_INVALID: 'errors.admin.PLATFORM_HEADERS_INVALID',
  PLATFORM_HEADERS_TOO_MANY: 'errors.admin.PLATFORM_HEADERS_TOO_MANY',
  PLATFORM_HEADERS_NAME_EMPTY: 'errors.admin.PLATFORM_HEADERS_NAME_EMPTY',
  PLATFORM_HEADERS_NAME_INVALID: 'errors.admin.PLATFORM_HEADERS_NAME_INVALID',
  PLATFORM_HEADERS_VALUE_EMPTY: 'errors.admin.PLATFORM_HEADERS_VALUE_EMPTY',
  PLATFORM_HEADERS_VALUE_INVALID: 'errors.admin.PLATFORM_HEADERS_VALUE_INVALID',
  PLATFORM_HEADERS_VALUE_TOO_LONG: 'errors.admin.PLATFORM_HEADERS_VALUE_TOO_LONG',

  // 额度插件
  QUOTA_PLUGIN_UNKNOWN: 'errors.admin.QUOTA_PLUGIN_UNKNOWN',

  // 账号
  ACCOUNT_PLATFORM_NOT_FOUND: 'errors.admin.ACCOUNT_PLATFORM_NOT_FOUND',
  ACCOUNT_NOT_FOUND: 'errors.admin.ACCOUNT_NOT_FOUND',
  ACCOUNT_KEY_COUNT_SHORT: 'errors.admin.ACCOUNT_KEY_COUNT_SHORT',
  ACCOUNT_TAKES_NO_KEY: 'errors.admin.ACCOUNT_TAKES_NO_KEY',

  // 公布的模型
  MODEL_NOT_GIVEN: 'errors.admin.MODEL_NOT_GIVEN',
  MODEL_ID_MISSING: 'errors.admin.MODEL_ID_MISSING',
  MODEL_ID_DUPLICATE: 'errors.admin.MODEL_ID_DUPLICATE',
  MODEL_HAS_NO_TARGET: 'errors.admin.MODEL_HAS_NO_TARGET',
  MODEL_MISSING_UPSTREAM: 'errors.admin.MODEL_MISSING_UPSTREAM',
  MODEL_DUPLICATE_TARGET: 'errors.admin.MODEL_DUPLICATE_TARGET',
  MODEL_NUMBER_INVALID: 'errors.admin.MODEL_NUMBER_INVALID',
  MODEL_NUMBER_OUT_OF_RANGE: 'errors.admin.MODEL_NUMBER_OUT_OF_RANGE',
  MODEL_CREDITS_INVALID: 'errors.admin.MODEL_CREDITS_INVALID',
  MODEL_BILLING_INVALID: 'errors.admin.MODEL_BILLING_INVALID',

  // 人工模型元数据
  MODEL_OVERRIDE_LIST_INVALID: 'errors.admin.MODEL_OVERRIDE_LIST_INVALID',
  MODEL_OVERRIDE_ENTRY_INVALID: 'errors.admin.MODEL_OVERRIDE_ENTRY_INVALID',
  MODEL_OVERRIDE_WRITE_FAILED: 'errors.admin.MODEL_OVERRIDE_WRITE_FAILED',
  MODEL_OVERRIDE_NOT_FOUND: 'errors.admin.MODEL_OVERRIDE_NOT_FOUND',
}

/**
 * 没有这条码的文案（后端加了码、面板还没跟上）。
 *
 * 直接给机器码：这时候任何中文包装都只会把码埋进一句话里，反而更难搜、
 * 更难贴去查。缺哪条码由 `describeError` 的 console.warn 报给开发。
 */
export function unknownAdminErrorText(code: string): string {
  return code
}

/**
 * 按机器码取文案。认不得的码返回 `undefined`。
 *
 * 用自有属性判断：`constructor`、`toString` 这类原型键不是码，不能命中。
 */
export function adminErrorText(code: string): AdminErrorKey | undefined {
  if (!Object.prototype.hasOwnProperty.call(ADMIN_ERROR_TEXT, code)) {
    return undefined
  }
  return ADMIN_ERROR_TEXT[code]
}
