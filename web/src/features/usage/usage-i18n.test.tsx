import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { setLang } from '@/lib/i18n'
import { UsageTable } from '@/features/usage/usage-table'

/**
 * 同一个组件，把语言切到 en 之后要渲染出英文。
 *
 * 断言的是行为：界面显示跟着 i18n.language 走，不是写死的中文。
 */
describe('用量明细（英文）', () => {
  afterEach(async () => {
    // 还原默认语言，别的用例还指望中文。
    await setLang('zh')
    localStorage.removeItem('agentfacade.lang')
  })

  it('空状态的句子与表头都是英文', async () => {
    await setLang('en')

    render(
      <UsageTable
        data={[]}
        search={{}}
        navigate={() => {}}
        upstreamOptions={[]}
        modelOptions={[]}
      />
    )

    expect(screen.getByText('No matching records.')).toBeInTheDocument()
    expect(screen.queryByText('没有匹配的记录。')).not.toBeInTheDocument()
    // 表头：表格列头是 columnheader。
    expect(screen.getByText('Time')).toBeInTheDocument()
    expect(screen.getByText('Latency')).toBeInTheDocument()
  })

  it('切回中文，界面跟着回来', async () => {
    await setLang('en')
    await setLang('zh')

    render(
      <UsageTable
        data={[]}
        search={{}}
        navigate={() => {}}
        upstreamOptions={[]}
        modelOptions={[]}
      />
    )

    expect(screen.getByText('没有匹配的记录。')).toBeInTheDocument()
    expect(screen.queryByText('No matching records.')).not.toBeInTheDocument()
  })
})
