// web/src/features/config/units.ts — 配置项的时间单位换算。
//
// 契约里的传输单位是毫秒（ConfigUnit.MILLISECONDS），面板给人看的、给人填的
// 都是整数秒。换算全在这里做，面板只调这些函数，不自己写换算逻辑：规则改一处，
// 所有调用点一起变。
// 面板只接受整数秒：小数写出去没有地方放，落库等于悄悄改值，所以小数在面板层就被拦住。
// 反过来，初值给的是**精确**的秒，不做四舍五入 —— 1500 毫秒要是显示成 2 秒，用户什么都
// 没动就保存，落库就真的变成 2000 了。
// 显示这一步交给现成的库：humanize-duration 自带中英文语言包，只输出秒这一档
// 时正好是「180 秒」/「180 seconds」这种形状，面板不自己拼单位。

import humanizeDuration from 'humanize-duration'
import { ConfigUnit } from '@/gen/agentfacade/admin/v1/admin_pb'

/** humanize-duration 的语言包名。面板的语言只有中英两种。 */
export type DurationLanguage = 'zh_CN' | 'en'

/**
 * 界面语言 → 语言包名。
 *
 * i18next 的语言是 'zh' / 'en'，humanize-duration 的中文包叫 'zh_CN'。
 */
export function durationLanguage(lang: string): DurationLanguage {
  return lang.startsWith('zh') ? 'zh_CN' : 'en'
}

/** 契约的单位是不是毫秒。 */
export function isMilliseconds(unit: ConfigUnit): boolean {
  return unit === ConfigUnit.MILLISECONDS
}

/**
 * 毫秒串 → 秒串。编辑框初值用。
 *
 * "180000" → "180"，"1500" → "1.5"。
 * 这里是精确的秒，不取整：初值被改成整数的话，用户什么都没动就保存，落库就是另一个
 * 数 —— 那是悄悄改值。非整秒的初值由面板层「只填整数」拦住，改成多少由用户自己定。
 * 不是非负整数毫秒的脏值原样返回，由调用方决定怎么显示。
 */
export function msToSecondsText(ms: string): string {
  const digits = ms.trim()
  if (!/^\d+$/.test(digits)) return ms
  return String(Number(digits) / 1000)
}

/**
 * 秒串 → 毫秒串。提交前用。
 *
 * "180" → "180000"。
 * 只认整数秒：小数不是合法的输入，原样返回，由调用方先拦住。
 * 不是非负十进制整数的脏值原样返回。
 */
export function secondsToMsText(seconds: string): string {
  const text = seconds.trim()
  if (!/^\d+$/.test(text)) return text
  return String(Number(text) * 1000)
}

/**
 * 毫秒串 → 面板显示串。
 *
 * "180000" → "180 秒"（中文界面）/ "180 seconds"（英文界面）。
 * 脏值原样返回，不硬套单位。
 */
export function displayMilliseconds(
  ms: string,
  language: DurationLanguage
): string {
  const digits = ms.trim()
  if (!/^\d+$/.test(digits)) return ms
  return humanizeDuration(Number(digits), { units: ['s'], language })
}
