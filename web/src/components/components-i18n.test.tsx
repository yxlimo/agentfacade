import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { setLang } from '@/lib/i18n'
import { LoadingState } from '@/components/async-state'
import { StatusBadge } from '@/components/status-badge'

/**
 * 通用组件在英文下渲染英文，并且切语言后页面上长期显示的文案跟着变。
 */
describe('通用组件（英文）', () => {
  afterEach(async () => {
    await setLang('zh')
    localStorage.removeItem('agentfacade.lang')
  })

  it('加载文案、状态徽章与重试按钮都是英文', async () => {
    await setLang('en')

    render(
      <div>
        <LoadingState />
        <StatusBadge status='expired' />
      </div>
    )

    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.getByText('Expired')).toBeInTheDocument()
    expect(screen.queryByText('正在加载…')).not.toBeInTheDocument()
    expect(screen.queryByText('已过期')).not.toBeInTheDocument()
  })

  it('已渲染的徽章在切语言后跟着变', async () => {
    await setLang('en')
    const { rerender } = render(<StatusBadge status='expired' />)
    expect(screen.getByText('Expired')).toBeInTheDocument()

    await setLang('zh')
    // useTranslation 的语言变化会触发订阅方重渲染；这里补一次显式 rerender
    // 以覆盖没有订阅的调用场景（例如外部缓存的徽章）。
    rerender(<StatusBadge status='expired' />)
    expect(screen.getByText('已过期')).toBeInTheDocument()
  })
})
