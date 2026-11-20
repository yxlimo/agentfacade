import { create } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import {
  AccountSchema,
  BenefitStatusSchema,
  GetBenefitStatusResponseSchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListProviderKindsResponseSchema,
  ListUpstreamsResponseSchema,
  ProviderPolicy,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { setLang } from '@/lib/i18n'
import { UpstreamsPage } from '@/features/upstreams/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/**
 * 平台页在英文下的界面文案。
 *
 * 断言的是行为：切到 en 之后表头、策略、签到区都从词典取英文；切回中文恢复。
 * 后端给的平台名、别名、上游原话不翻译，所以这里不碰它们。
 */
const client = mockAdminClient({
  ListUpstreams: () =>
    create(ListUpstreamsResponseSchema, {
      upstreams: [
        create(UpstreamSchema, {
          id: 'minimax',
          kind: 'minimax',
          label: 'MiniMax Code',
          region: 'cn',
          state: UpstreamState.READY,
          policy: ProviderPolicy.FALLBACK,
          policies: [ProviderPolicy.SINGLE, ProviderPolicy.FALLBACK],
          accountCount: 1,
          hasEnabledAccount: true,
          accounts: [
            create(AccountSchema, {
              id: 'minimax-1',
              platform: 'minimax',
              alias: '主账号',
              enabled: true,
              status: 'usable',
              credentialCount: 1,
            }),
          ],
        }),
      ],
    }),
  ListAccounts: () =>
    create(ListAccountsResponseSchema, { accounts: [] }),
  ListCredentials: () =>
    create(ListCredentialsResponseSchema, { credentials: [] }),
  ListProviderKinds: () => create(ListProviderKindsResponseSchema, {}),
  GetBenefitStatus: () =>
    create(GetBenefitStatusResponseSchema, {
      benefits: [
        create(BenefitStatusSchema, {
          upstreamId: 'minimax-1',
          accountId: 'minimax-1',
          summary: 'Signed in today',
          checkedAt: 0n,
          credits: 0,
          ok: false,
        }),
      ],
    }),
})

describe('平台页（英文）', () => {
  afterEach(async () => {
    await setLang('zh')
    localStorage.removeItem('agentfacade.lang')
  })

  it('表头、策略标签与按钮都是英文', async () => {
    await setLang('en')
    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(await screen.findByRole('heading', { name: 'Platforms' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Region' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Effective policy' })).toBeInTheDocument()
    expect(screen.getByText('Fallback')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add platform' })).toBeInTheDocument()
    expect(screen.queryByText('生效策略')).not.toBeInTheDocument()
  })

  it('展开后的账号表与签到区也是英文', async () => {
    await setLang('en')
    renderWithClient({ client, children: <UpstreamsPage /> })

    const expand = await screen.findByRole('button', {
      name: 'Expand accounts and credentials for minimax',
    })
    expand.click()

    expect(await screen.findByText('Daily check-in')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check in now' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Weight' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Enabled' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Log in' })).toBeInTheDocument()
    expect(screen.queryByText('每日签到')).not.toBeInTheDocument()
  })

  it('切回中文后恢复中文文案', async () => {
    await setLang('en')
    await setLang('zh')
    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(await screen.findByRole('heading', { name: '平台' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: '生效策略' })).toBeInTheDocument()
    expect(screen.queryByText('Effective policy')).not.toBeInTheDocument()
  })
})
