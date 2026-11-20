import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LangToggle } from '@/components/layout/lang-toggle'
import { setLang } from '@/lib/i18n'

describe('零散页面文案（英文）', () => {
  afterEach(async () => {
    await setLang('zh')
    localStorage.removeItem('agentfacade.lang')
  })

  it('语言菜单里中文项的显示名跟着语言切', async () => {
    await setLang('en')
    render(<LangToggle />)
    const user = userEvent.setup({ delay: null })

    await user.click(screen.getByRole('button', { name: 'Language' }))
    expect(screen.getByRole('menuitem', { name: 'Chinese' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'English' })).toBeInTheDocument()
    expect(screen.queryByText('中文')).not.toBeInTheDocument()
  })
})
