import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from '@/components/theme-provider'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * 主题切换：浅色 / 深色 / 跟随系统。
 *
 * 放在右上角。切换立刻生效，选择记在 localStorage 里（next-themes 管）。
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const { t } = useTranslation()
  const [mounted, setMounted] = useState(false)

  // 服务端渲染时不知道用户的主题，先渲染成一个中性的图标，挂上之后再换。
  useEffect(() => {
    setMounted(true)
  }, [])

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button variant='ghost' size='icon' aria-label={t('shell.toggleTheme')}>
          {mounted && theme === 'dark' ? (
            <Moon className='size-4' />
          ) : mounted && theme === 'light' ? (
            <Sun className='size-4' />
          ) : (
            <Monitor className='size-4' />
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align='end'>
        <DropdownMenuItem onSelect={() => setTheme('light')}>
          <Sun className='size-4' />
          {t('shell.themeLight')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme('dark')}>
          <Moon className='size-4' />
          {t('shell.themeDark')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setTheme('system')}>
          <Monitor className='size-4' />
          {t('shell.themeSystem')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
