import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import { zh } from './catalogs/zh'
import { en } from './catalogs/en'

/**
 * 面板语言：zh（默认）/ en。
 *
 * 选择记在 localStorage（agentfacade.lang）。默认 zh —— 现有 e2e 断言的都是
 * 中文。后端给的字段（账号别名、平台名、模型 id、上游原话）永远不进词典。
 */
export type Lang = 'zh' | 'en'

export const LANG_STORAGE_KEY = 'agentfacade.lang'

function initialLang(): Lang {
  try {
    return localStorage.getItem(LANG_STORAGE_KEY) === 'en' ? 'en' : 'zh'
  } catch {
    // localStorage 不可用（隐私模式之类）：回落到默认。
    return 'zh'
  }
}

void i18next.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
  },
  lng: initialLang(),
  fallbackLng: 'zh',
  interpolation: { escapeValue: false },
  // React 自己转义，i18next 不再转一遍。
  react: { useSuspense: false },
})

/** 切语言。写 localStorage，并同步 <html lang> 与 document.title。 */
export function setLang(lang: Lang): Promise<void> {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang)
  } catch {
    // 存不进去就算了：本次会话内仍然生效。
  }
  return i18next.changeLanguage(lang).then(() => undefined)
}

function syncDocument(lang: string): void {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'
  document.title = i18next.t('common.docTitle')
}

i18next.on('languageChanged', syncDocument)
syncDocument(i18next.language)

export default i18next
