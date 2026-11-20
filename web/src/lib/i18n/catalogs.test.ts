import { beforeEach, describe, expect, it } from 'vitest'
import i18n, { setLang } from '@/lib/i18n'
import { en } from '@/lib/i18n/catalogs/en'
import { zh } from '@/lib/i18n/catalogs/zh'

/**
 * i18n 词典与 t()。
 *
 * 键集一致的第一道门是类型（en 的类型是 Record<keyof typeof zh, string>），
 * 这里是运行时的第二道：tsc 没跑到的地方（比如生成路径上的键）兜底。
 */
describe('i18n 词典', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('zh')
  })

  it('en 与 zh 的键集一致', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })

  it('每个键的值都不是空串', () => {
    for (const key of Object.keys(zh) as (keyof typeof zh)[]) {
      expect(en[key].trim()).not.toBe('')
      expect(zh[key].trim()).not.toBe('')
    }
  })

  it('t() 做插值', () => {
    expect(i18n.t('common.successFailed', { ok: '3', bad: '1' })).toBe(
      '成功 3 · 失败 1'
    )
    expect(i18n.t('overview.version', { version: '9.9.9' })).toBe('版本 9.9.9')
  })

  it('en 的插值也走词典', async () => {
    await i18n.changeLanguage('en')
    expect(i18n.t('common.successFailed', { ok: '3', bad: '1' })).toBe(
      '3 succeeded · 1 failed'
    )
    expect(i18n.t('usage.title')).toBe('Usage')
  })

  it('en 复数：count 1 走 _one，其它走 _other', async () => {
    await i18n.changeLanguage('en')
    expect(i18n.t('overview.models', { count: 1 })).toBe('1 model')
    expect(i18n.t('overview.models', { count: 3 })).toBe('3 models')
    expect(
      i18n.t('usage.requestsTimes', { count: 2, in: '10', out: '20' })
    ).toBe('2 requests · in 10 / out 20')
    expect(
      i18n.t('usage.requestsTimes', { count: 1, in: '10', out: '20' })
    ).toBe('1 request · in 10 / out 20')
  })

  it('setLang 写 localStorage，换语言并同步 html lang 与 title', async () => {
    localStorage.removeItem('agentfacade.lang')
    await setLang('en')
    expect(localStorage.getItem('agentfacade.lang')).toBe('en')
    expect(i18n.language).toBe('en')
    expect(document.documentElement.lang).toBe('en')
    expect(document.title).toBe('AgentFacade Admin Panel')

    // 切回中文，现场还原。
    await setLang('zh')
    expect(document.documentElement.lang).toBe('zh-CN')
    expect(document.title).toBe('AgentFacade 管理面板')
    localStorage.removeItem('agentfacade.lang')
  })
})
