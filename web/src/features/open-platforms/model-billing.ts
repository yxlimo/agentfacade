import type { ModelBilling } from '@/gen/agentfacade/admin/v1/admin_pb'
import i18n from '@/lib/i18n'

/**
 * 上游报的这份计费在面板上怎么写。
 *
 * 只看 `billing` 自己那几个字段，不看是哪个平台报的：换平台、换方言都不改动这里。
 * 写不出来就返回 `null`（界面上什么都不摆），不写「没报」这类占位说法。
 *
 * `unknown === true` 是第一等判据：上游报了一份全 0 又没单位的东西，那是「不知道」，
 * 不是「免费」。写出来就成了把不知道说成 0 元，所以这种情况下一个字都不给。
 */
export function billingLine(billing: ModelBilling | undefined): string | null {
  if (!billing || billing.unknown) return null
  // `none` 有两种：上游说不上来（不摆），与人写的「不收费」（要摆 —— 那是结论，
  // 不是空白）。`overridden` 就是这两者的分界。
  if (billing.mode.trim() === 'none') {
    return billing.overridden ? i18n.t('openPlatforms.billingFree') : null
  }
  const price = priceText(billing)
  if (price === null) return null
  const windows = multipliersText(billing.multipliers)
  return windows === null ? price : `${price}，${windows}`
}

/** 币种符号：认得的写符号，不认得的把币种原样写在数字前面，没有币种就只写数字。 */
const CURRENCIES: Record<string, string> = {
  CNY: '¥',
  USD: '$',
}

/** 数：整数不带小数点，小数按需保留（最多六位，不给一串浮点尾巴）。 */
function priceFormat(): Intl.NumberFormat {
  return new Intl.NumberFormat(i18n.language === 'en' ? 'en-US' : 'zh-CN', {
    maximumFractionDigits: 6,
  })
}

function currencyPrefix(currency: string): string {
  const code = currency.trim().toUpperCase()
  if (code === '') return ''
  const symbol = CURRENCIES[code]
  return symbol === undefined ? `${code} ` : symbol
}

function priceText(billing: ModelBilling): string | null {
  const mode = billing.mode.trim()
  if (mode === 'token') {
    const unit = currencyPrefix(billing.currency)
    const parts: string[] = []
    const add = (label: string, value: number | undefined) => {
      if (value === undefined || !Number.isFinite(value)) return
      parts.push(`${label} ${unit}${priceFormat().format(value)}`)
    }
    add(i18n.t('openPlatforms.billingInput'), billing.inputPerMillion)
    add(i18n.t('openPlatforms.billingOutput'), billing.outputPerMillion)
    add(i18n.t('openPlatforms.billingCacheRead'), billing.cacheReadPerMillion)
    if (parts.length === 0) return null
    return `${parts.join(' / ')} ${i18n.t('openPlatforms.billingPerMillion')}`
  }
  if (mode === 'multiplier') {
    const credits = billing.credits
    if (credits === undefined || !Number.isFinite(credits)) return null
    return i18n.t('openPlatforms.billingMultiplier', {
      value: priceFormat().format(credits),
    })
  }
  // `none` 与还没有说法的模式：不摆。
  return null
}

/** 分时段倍率：只写 factor，几段就用 `/` 连起来。 */
function multipliersText(multipliers: number[]): string | null {
  const factors = multipliers
    .filter((factor) => Number.isFinite(factor))
    .map((factor) => `×${priceFormat().format(factor)}`)
  if (factors.length === 0) return null
  return i18n.t('openPlatforms.billingTimeOfDay', { factors: factors.join('/') })
}
