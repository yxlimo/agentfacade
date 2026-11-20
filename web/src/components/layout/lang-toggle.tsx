import { useEffect, useState } from 'react'
import { Languages } from 'lucide-react'
import i18n, { setLang } from '@/lib/i18n'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * 语言切换：中文 / English。
 *
 * 放在头部，主题切换旁边。切换立刻生效，选择记在 localStorage 里
 * （`agentfacade.lang`），刷新后仍然是选的语言。
 */
export function LangToggle() {
  const { t } = useTranslation()
  const [lang, setLangState] = useState(i18n.language === 'en' ? 'en' : 'zh')

  // 语言可能从别处改（切完之后 i18next 异步落地），跟住实例。
  useEffect(() => {
    const onChange = (next: string) => setLangState(next === 'en' ? 'en' : 'zh')
    i18n.on('languageChanged', onChange)
    return () => i18n.off('languageChanged', onChange)
  }, [])

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant='ghost' size='icon' aria-label={t('common.langLabel')}>
          <Languages className='size-4' />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        <DropdownMenuItem
          onSelect={() => setLang('zh')}
          aria-current={lang === 'zh' ? 'true' : undefined}
        >
          {t('lang.zh')}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => setLang('en')}
          aria-current={lang === 'en' ? 'true' : undefined}
        >
          {t('lang.en')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
