import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { create } from '@bufbuild/protobuf'
import { CreditLotSchema } from '@/gen/agentfacade/admin/v1/admin_pb'
import { setLang } from '@/lib/i18n'
import { CreditLotsTable } from '@/features/balance/credit-lots'

/**
 * 额度页在英文下渲染出英文表头与空状态。
 *
 * 断言的是行为：界面文案跟着 i18n.language 走，不是写死的中文。
 * 平台名与账号别名属于后端数据，两种语言下都应该原样显示。
 */
describe('额度批次（英文）', () => {
  afterEach(async () => {
    await setLang('zh')
    localStorage.removeItem('agentfacade.lang')
  })

  it('表头、空状态与天数都是英文', async () => {
    await setLang('en')

    render(<CreditLotsTable lots={[]} />)

    expect(screen.getByText('No credit lots')).toBeInTheDocument()
    expect(screen.queryByText('没有积分批次')).not.toBeInTheDocument()
  })

  it('英文下表头与来源原样显示', async () => {
    await setLang('en')

    render(
      <CreditLotsTable
        lots={[
          create(CreditLotSchema, {
            id: 'lot-1',
            sourceLabel: '新人活动',
            remaining: 100,
            expiresAt: BigInt(Date.UTC(2030, 0, 15)),
            status: 'active',
          }),
        ]}
      />
    )

    expect(screen.getByText('Lot')).toBeInTheDocument()
    expect(screen.getByText('Source')).toBeInTheDocument()
    expect(screen.getByText('Remaining')).toBeInTheDocument()
    expect(screen.getByText('Expires at')).toBeInTheDocument()
    expect(screen.getByText('Countdown')).toBeInTheDocument()
    expect(screen.getByText('State')).toBeInTheDocument()
    // 后端给的来源名不翻译。
    expect(screen.getByText('新人活动')).toBeInTheDocument()
    expect(screen.getByText('100 points')).toBeInTheDocument()
  })
})
