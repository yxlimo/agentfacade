import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { create } from '@bufbuild/protobuf'
import { BenefitStatusSchema, CheckinState } from '@/gen/agentfacade/admin/v1/admin_pb'
import { setLang } from '@/lib/i18n'
import { PlatformCheckinRow } from '@/features/benefits/platform-checkin-row'

/** 平台行在英文下渲染出英文状态，账号别名属于后端数据保持原样。 */
describe('签到平台行（英文）', () => {
  afterEach(async () => {
    await setLang('zh')
    localStorage.removeItem('agentfacade.lang')
  })

  it('三态摘要是英文', async () => {
    await setLang('en')

    render(
      <ul>
        <PlatformCheckinRow
          upstreamId='demo'
          title='Demo Platform'
          benefits={[
            create(BenefitStatusSchema, {
              accountId: 'acc-1',
              checkinState: CheckinState.SIGNED,
            }),
          ]}
          accountAliases={new Map()}
        />
      </ul>
    )

    expect(screen.getByText('Checked in today')).toBeInTheDocument()
    expect(screen.queryByText('今日已签到')).not.toBeInTheDocument()
  })

  it('账号别名原样显示，不被翻译', async () => {
    await setLang('en')

    render(
      <ul>
        <PlatformCheckinRow
          upstreamId='demo'
          title='Demo Platform'
          benefits={[
            create(BenefitStatusSchema, {
              accountId: 'acc-1',
              checkinState: CheckinState.UNKNOWN,
            }),
          ]}
          accountAliases={new Map([['acc-1', '主账号']])}
        />
      </ul>
    )

    expect(screen.getByText('Today’s check-in status is unknown')).toBeInTheDocument()

    await userEvent.setup().click(
      screen.getByRole('button', { name: 'demo check-in' })
    )
    expect(screen.getByText('主账号')).toBeInTheDocument()
  })
})
