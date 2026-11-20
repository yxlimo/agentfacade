import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { setLang } from '@/lib/i18n'
import { LangToggle } from '@/components/layout/lang-toggle'

/**
 * 语言切换器：键盘可达（Radix 下拉菜单本来就支持），选择立刻生效。
 */
describe('语言切换器', () => {
  afterEach(async () => {
    await setLang('zh')
    localStorage.removeItem('agentfacade.lang')
  })

  it('键盘打开菜单，选 English 之后界面语言跟着变', async () => {
    const user = userEvent.setup({ delay: null })
    render(<LangToggle />)

    const trigger = screen.getByRole('button', { name: '语言' })
    trigger.focus()
    await user.keyboard('{Enter}')
    await user.click(await screen.findByText('English'))

    expect(document.documentElement.lang).toBe('en')
    expect(localStorage.getItem('agentfacade.lang')).toBe('en')
    // 触发器自己的可访问名也跟着换。
    expect(screen.getByRole('button', { name: 'Language' })).toBeInTheDocument()
  })

  it('切回中文，html lang 回到 zh-CN', async () => {
    const user = userEvent.setup({ delay: null })
    await setLang('en')
    render(<LangToggle />)

    await user.click(screen.getByRole('button', { name: 'Language' }))
    await user.click(await screen.findByText('中文'))

    expect(document.documentElement.lang).toBe('zh-CN')
    expect(localStorage.getItem('agentfacade.lang')).toBe('zh')
  })
})
