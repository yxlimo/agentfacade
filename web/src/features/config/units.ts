// web/src/features/config/units.ts — 配置项的时间单位换算。
//
// 契约里的传输单位是毫秒（ConfigUnit.MILLISECONDS），面板给人看的、让人填的
// 都是秒。换算全在这里做，面板只调这些函数，不自己写换算逻辑：规则改一处，
// 所有调用点一起变。
//
// 换算都在数字串上做，不走浮点：毫秒是整数，秒最多三位小数，浮点会把这类值
// 算飘，字符串上移小数点是精确的。

import { ConfigUnit } from '@/gen/agentfacade/admin/v1/admin_pb'

/** 契约的单位是不是毫秒。 */
export function isMilliseconds(unit: ConfigUnit): boolean {
  return unit === ConfigUnit.MILLISECONDS
}

/**
 * 毫秒串 → 秒串。编辑框初值用，不丢精度。
 *
 * "180000" → "180"，"1500" → "1.5"，"500" → "0.5"。
 * 不是非负整数毫秒的脏值原样返回，由调用方决定怎么显示。
 */
export function msToSecondsText(ms: string): string {
  const digits = ms.trim()
  if (!/^\d+$/.test(digits)) return ms
  // 小数点左移三位：不足四位的前面补零，再去掉小数部分末尾的零。
  const padded = digits.padStart(4, '0')
  const intPart = padded.slice(0, padded.length - 3).replace(/^0+(?=\d)/, '')
  const fracPart = padded.slice(padded.length - 3).replace(/0+$/, '')
  return fracPart ? `${intPart}.${fracPart}` : intPart
}

/**
 * 秒串 → 毫秒串。提交前用。
 *
 * "180" → "180000"，"1.5" → "1500"，"0.5" → "500"。
 * 小数点后超过三位的四舍五入到最近的毫秒：毫秒是最小传输单位，
 * 再精确的值传出去也没有地方放。
 * 不是非负十进制数的脏值原样返回。
 */
export function secondsToMsText(seconds: string): string {
  const text = seconds.trim()
  if (!/^\d+(\.\d+)?$/.test(text)) return text
  const [intPart, fracPart = ''] = text.split('.')
  const digits = intPart + fracPart
  const missing = 3 - fracPart.length
  if (missing >= 0) {
    return stripLeadingZeros(digits + '0'.repeat(missing))
  }
  // 超过三位小数：看第四位，决定第三位进不进位。
  const kept = digits.slice(0, digits.length + missing)
  const rest = digits.slice(digits.length + missing)
  const rounded = Number(rest[0]) >= 5 ? increment(kept) : kept
  return stripLeadingZeros(rounded)
}

/** 剥掉前导零，至少留一位（"0000" → "0"，"0500" → "500"）。 */
function stripLeadingZeros(digits: string): string {
  const stripped = digits.replace(/^0+/, '')
  return stripped === '' ? '0' : stripped
}

/** 非负整数串加一（四舍五入进位用）。 */
function increment(digits: string): string {
  let carry = 1
  let out = ''
  for (let i = digits.length - 1; i >= 0; i--) {
    const digit = Number(digits[i]) + carry
    carry = digit >= 10 ? 1 : 0
    out = String(digit % 10) + out
  }
  return carry ? `1${out}` : out
}

/**
 * 毫秒串 → 面板显示串（带单位）。
 *
 * "180000" 加 "秒" → "180 秒"，"1500" 加 "秒" → "1.5 秒"。
 * 脏值原样返回，不硬套单位。
 */
export function displayMilliseconds(ms: string, unitLabel: string): string {
  if (!/^\d+$/.test(ms.trim())) return ms
  return `${msToSecondsText(ms)} ${unitLabel}`
}

/**
 * 两个非负十进制数串的精确比较：a 小于 b 返回 -1，相等返回 0，大于返回 1。
 *
 * 契约的边界是 bigint，草稿是十进制串：把两边的小数位补齐后按整数比，
 * 不走浮点，大数也不会算飘。
 */
export function compareDecimals(a: string, b: string): number {
  const [aInt, aFrac = ''] = a.split('.')
  const [bInt, bFrac = ''] = b.split('.')
  const len = Math.max(aFrac.length, bFrac.length)
  const aScaled = BigInt(aInt + aFrac.padEnd(len, '0'))
  const bScaled = BigInt(bInt + bFrac.padEnd(len, '0'))
  if (aScaled < bScaled) return -1
  if (aScaled > bScaled) return 1
  return 0
}
