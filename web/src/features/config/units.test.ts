// web/src/features/config/units.test.ts — 毫秒↔秒换算的钉子。
//
// 换算走的是数字串而不是浮点：这里把整秒、非整秒、超毫秒精度、脏值都走一遍，
// 钉住「不丢精度」与「脏值原样返回」这两条。

import { describe, expect, it } from 'vitest'
import {
  compareDecimals,
  displayMilliseconds,
  isMilliseconds,
  msToSecondsText,
  secondsToMsText,
} from '@/features/config/units'
import { ConfigUnit } from '@/gen/agentfacade/admin/v1/admin_pb'

describe('配置项的单位换算', () => {
  it('毫秒串换算成秒串：整秒、非整秒、不足一秒都不丢精度', () => {
    expect(msToSecondsText('180000')).toBe('180')
    expect(msToSecondsText('1500')).toBe('1.5')
    expect(msToSecondsText('500')).toBe('0.5')
    expect(msToSecondsText('1')).toBe('0.001')
    expect(msToSecondsText('600000')).toBe('600')
    expect(msToSecondsText('0')).toBe('0')
  })

  it('毫秒串的脏值原样返回，不硬套换算', () => {
    expect(msToSecondsText('abc')).toBe('abc')
    expect(msToSecondsText('')).toBe('')
    expect(msToSecondsText('12x')).toBe('12x')
  })

  it('秒串换算回毫秒串：整秒与非整秒都对得上', () => {
    expect(secondsToMsText('180')).toBe('180000')
    expect(secondsToMsText('1.5')).toBe('1500')
    expect(secondsToMsText('0.5')).toBe('500')
    expect(secondsToMsText('0.001')).toBe('1')
    expect(secondsToMsText('0')).toBe('0')
  })

  it('超过毫秒精度的秒四舍五入到最近的毫秒', () => {
    // 1.0005 秒 = 1000.5 毫秒，四舍五入进位。
    expect(secondsToMsText('1.0005')).toBe('1001')
    // 1.0004 秒 = 1000.4 毫秒，舍去。
    expect(secondsToMsText('1.0004')).toBe('1000')
    // 9.9995 秒 = 9999.5 毫秒，进位后整数位跟着进。
    expect(secondsToMsText('9.9995')).toBe('10000')
  })

  it('秒串的脏值原样返回', () => {
    expect(secondsToMsText('abc')).toBe('abc')
    expect(secondsToMsText('')).toBe('')
    expect(secondsToMsText('1.2.3')).toBe('1.2.3')
  })

  it('显示串带上单位，脏值不加单位', () => {
    expect(displayMilliseconds('180000', '秒')).toBe('180 秒')
    expect(displayMilliseconds('1500', '秒')).toBe('1.5 秒')
    expect(displayMilliseconds('abc', '秒')).toBe('abc')
  })

  it('单位的判据只认契约的毫秒', () => {
    expect(isMilliseconds(ConfigUnit.MILLISECONDS)).toBe(true)
    expect(isMilliseconds(ConfigUnit.UNSPECIFIED)).toBe(false)
  })

  it('十进制串的比较是精确的', () => {
    expect(compareDecimals('9', '5')).toBe(1)
    expect(compareDecimals('5', '9')).toBe(-1)
    expect(compareDecimals('5', '5')).toBe(0)
    // 小数位不同的同一数值。
    expect(compareDecimals('1.5', '1.50')).toBe(0)
    // 小数位补齐后比较，不是按字符串排。
    expect(compareDecimals('0.1', '0.09')).toBe(1)
    expect(compareDecimals('1.005', '1.01')).toBe(-1)
  })
})
