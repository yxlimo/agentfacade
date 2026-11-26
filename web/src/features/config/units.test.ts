// web/src/features/config/units.test.ts — 毫秒↔秒换算的钉子。
//
// 面板只接受整数秒：毫秒是整数，秒取整就够了。小数不是合法的输入，换算函数
// 原样返回，由面板层先拦住（用例断的是「不被悄悄转换」，不是「被四舍五入」）。
//
// 显示那一步交给 humanize-duration，这里钉的是它的形状：中文「180 秒」、
// 英文「600 seconds」，脏值不加单位。

import { describe, expect, it } from 'vitest'
import {
  displayMilliseconds,
  durationLanguage,
  isMilliseconds,
  msToSecondsText,
  secondsToMsText,
} from '@/features/config/units'
import { ConfigUnit } from '@/gen/agentfacade/admin/v1/admin_pb'

describe('配置项的单位换算', () => {
  it('毫秒串换算成整数秒串', () => {
    expect(msToSecondsText('180000')).toBe('180')
    expect(msToSecondsText('600000')).toBe('600')
    expect(msToSecondsText('1000')).toBe('1')
    expect(msToSecondsText('0')).toBe('0')
  })

  it('毫秒串的脏值原样返回，不硬套换算', () => {
    expect(msToSecondsText('abc')).toBe('abc')
    expect(msToSecondsText('')).toBe('')
    expect(msToSecondsText('12x')).toBe('12x')
  })

  it('秒串换算回毫秒串', () => {
    expect(secondsToMsText('180')).toBe('180000')
    expect(secondsToMsText('600')).toBe('600000')
    expect(secondsToMsText('0')).toBe('0')
  })

  it('小数秒不是合法的输入：原样返回，不被悄悄换算', () => {
    expect(secondsToMsText('1.5')).toBe('1.5')
    expect(secondsToMsText('0.5')).toBe('0.5')
    expect(secondsToMsText('1.0005')).toBe('1.0005')
  })

  it('秒串的脏值原样返回', () => {
    expect(secondsToMsText('abc')).toBe('abc')
    expect(secondsToMsText('')).toBe('')
    expect(secondsToMsText('1.2.3')).toBe('1.2.3')
  })

  it('显示串交给 humanize-duration：中文是秒，英文是 seconds', () => {
    expect(displayMilliseconds('180000', 'zh_CN')).toBe('180 秒')
    expect(displayMilliseconds('600000', 'en')).toBe('600 seconds')
    // 脏值不加单位。
    expect(displayMilliseconds('abc', 'zh_CN')).toBe('abc')
  })

  it('界面语言映射到语言包名', () => {
    expect(durationLanguage('zh')).toBe('zh_CN')
    expect(durationLanguage('en')).toBe('en')
  })

  it('单位的判据只认契约的毫秒', () => {
    expect(isMilliseconds(ConfigUnit.MILLISECONDS)).toBe(true)
    expect(isMilliseconds(ConfigUnit.UNSPECIFIED)).toBe(false)
  })
})
