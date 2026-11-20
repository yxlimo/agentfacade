import type { zh } from './catalogs/zh'

/**
 * t() 的键从中文词典的类型来：键名写错、键不存在，tsc 当场报错。
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: {
      translation: typeof zh
    }
  }
}
