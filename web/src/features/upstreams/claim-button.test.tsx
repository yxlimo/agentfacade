import { create } from '@bufbuild/protobuf'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AccountSchema,
  ClaimZcodePlanResponseSchema,
  GetZcodeClaimStatusResponseSchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListUpstreamsResponseSchema,
  ProviderPolicy,
  UpstreamSchema,
  UpstreamState,
  ZcodeClaimOutcome,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { UpstreamsPage } from '@/features/upstreams/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'
import type { TracelessResult } from '@/features/upstreams/aliyun-captcha'

const { runTraceless } = vi.hoisted(() => ({
  runTraceless: vi.fn<() => Promise<TracelessResult>>(),
}))

vi.mock('@/features/upstreams/aliyun-captcha', () => ({
  runTracelessVerification: () => runTraceless(),
}))

/** 与真实封装同形状的假结果。 */
function verification(param: string): TracelessResult {
  return { ok: true, param, certifyId: 'cert-TESTONLY' }
}

function zcodePlatform() {
  return create(UpstreamSchema, {
    id: 'zcode',
    kind: 'zcode',
    label: 'ZCode',
    state: UpstreamState.READY,
    policy: ProviderPolicy.SINGLE,
    policies: [ProviderPolicy.SINGLE],
    accountCount: 1,
    hasEnabledAccount: true,
    accounts: [
      create(AccountSchema, {
        id: 'zcode-1',
        platform: 'zcode',
        alias: '领取账号',
        enabled: true,
        status: 'usable',
        credentialCount: 1,
      }),
    ],
  })
}

type StatusOptions = {
  captchaAvailable?: boolean
  offers?: { campaignId: string; planId: string; name: string; priority: number; alreadyClaimed: boolean }[]
}

function setup(options: {
  status?: StatusOptions
  claimOutcome?: ZcodeClaimOutcome
  planName?: string
  effectiveAtMs?: bigint
  upstreamMessage?: string
  claimOk?: boolean
} = {}) {
  const claimInputs: Record<string, unknown>[] = []
  const client = mockAdminClient({
    ListUpstreams: () =>
      create(ListUpstreamsResponseSchema, { upstreams: [zcodePlatform()] }),
    ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [] }),
    ListCredentials: () =>
      create(ListCredentialsResponseSchema, { credentials: [] }),
    GetZcodeClaimStatus: () =>
      create(GetZcodeClaimStatusResponseSchema, {
        ok: true,
        captchaAvailable: options.status?.captchaAvailable ?? true,
        captcha: {
          present: true,
          enabled: true,
          sceneId: 'scene-TESTONLY',
          prefix: 'prefix-TESTONLY',
          region: 'cn',
        },
        offers: (options.status?.offers ?? [
          {
            campaignId: 'camp-1',
            planId: 'plan-1',
            name: '周积分包',
            priority: 10,
            alreadyClaimed: false,
          },
        ]).map((offer) => ({
          campaignId: offer.campaignId,
          planId: offer.planId,
          name: offer.name,
          priority: offer.priority,
          alreadyClaimed: offer.alreadyClaimed,
        })),
      }),
    ClaimZcodePlan: (input) => {
      claimInputs.push(input as unknown as Record<string, unknown>)
      return create(ClaimZcodePlanResponseSchema, {
        ok: options.claimOk ?? true,
        outcome: options.claimOutcome ?? ZcodeClaimOutcome.CLAIMED,
        planName: options.planName ?? '周积分包',
        effectiveAtMs: options.effectiveAtMs ?? 0n,
        upstreamMessage: options.upstreamMessage ?? '',
      })
    },
  })
  return { client, claimInputs }
}

/** 展开 zcode 平台，让账号那一行出现在页面上。 */
async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole('button', { name: '展开 zcode 的账号与凭据' })
  )
}

describe('ZCode 账号行的领取按钮', () => {
  beforeEach(() => {
    runTraceless.mockReset()
    window.history.replaceState(null, '', '/')
  })

  it('验证码配置不可用时没有领取按钮', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({ status: { captchaAvailable: false } })
    renderWithClient({ client, children: <UpstreamsPage /> })
    await open(user)
    await screen.findByText('领取账号')
    expect(screen.queryByRole('button', { name: '领取' })).not.toBeInTheDocument()
  })

  it('没有 offer 时没有领取按钮', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({ status: { captchaAvailable: true, offers: [] } })
    renderWithClient({ client, children: <UpstreamsPage /> })
    await open(user)
    await screen.findByText('领取账号')
    expect(screen.queryByRole('button', { name: '领取' })).not.toBeInTheDocument()
  })

  it('已领取：显示不可点的状态', async () => {
    const user = userEvent.setup({ delay: null })
    const { client, claimInputs } = setup({
      status: {
        captchaAvailable: true,
        offers: [{
          campaignId: 'camp-1', planId: 'plan-1', name: '周积分包',
          priority: 10, alreadyClaimed: true,
        }],
      },
    })
    renderWithClient({ client, children: <UpstreamsPage /> })
    await open(user)
    expect(await screen.findByText('已领取')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '领取' })).not.toBeInTheDocument()
    await user.click(screen.getByText('领取账号'))
    expect(claimInputs).toHaveLength(0)
  })

  it('多个 offer 按 priority 取第一个；按钮点下去先跑验证码，再带正确参数发领取', async () => {
    const user = userEvent.setup({ delay: null })
    runTraceless.mockResolvedValue(verification('param-TESTONLY'))
    const { client, claimInputs } = setup({
      status: {
        captchaAvailable: true,
        offers: [
          { campaignId: 'camp-2', planId: 'plan-2', name: '后排', priority: 99, alreadyClaimed: false },
          { campaignId: 'camp-1', planId: 'plan-1', name: '优先', priority: 1, alreadyClaimed: false },
        ],
      },
      planName: '优先',
    })
    renderWithClient({ client, children: <UpstreamsPage /> })
    await open(user)
    const button = await screen.findByRole('button', { name: '领取' })
    await user.click(button)

    await waitFor(() => expect(runTraceless).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(claimInputs).toHaveLength(1))
    expect(claimInputs[0]).toMatchObject({
      providerId: 'zcode-1',
      planId: 'plan-1',
      campaignId: 'camp-1',
      captchaVerifyParam: 'param-TESTONLY',
      captchaRegion: 'cn',
    })
    expect(await screen.findByText(/已领到.*优先/)).toBeInTheDocument()
  })

  it('验证码失败：不发领取请求，显示「这台浏览器没能通过验证码」+ 建议去官方客户端', async () => {
    const user = userEvent.setup({ delay: null })
    runTraceless.mockResolvedValue({
      ok: false, stage: 'verification', code: 'DYNAMICJS_FAIL', message: '',
    })
    const { client, claimInputs } = setup()
    renderWithClient({ client, children: <UpstreamsPage /> })
    await open(user)
    await user.click(await screen.findByRole('button', { name: '领取' }))

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('这台浏览器没能通过验证码')
    expect(status).toHaveTextContent('建议去官方客户端点一次')
    expect(status).not.toHaveTextContent('验证码错误请重试')
    expect(status).toHaveAttribute('data-tone', 'error')
    expect(claimInputs).toHaveLength(0)
  })

  it('验证码超时：说不知道，不说没通过', async () => {
    const user = userEvent.setup({ delay: null })
    runTraceless.mockResolvedValue({
      ok: false, stage: 'timeout', code: 'TIMEOUT', message: '',
    })
    const { client, claimInputs } = setup()
    renderWithClient({ client, children: <UpstreamsPage /> })
    await open(user)
    await user.click(await screen.findByRole('button', { name: '领取' }))

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('还不知道')
    expect(status).toHaveAttribute('data-tone', 'neutral')
    expect(claimInputs).toHaveLength(0)
  })

  it.each([
    [ZcodeClaimOutcome.ALREADY, '已经领过了', 'neutral'],
    [ZcodeClaimOutcome.NO_OFFER, '此刻没有可领的', 'neutral'],
    [ZcodeClaimOutcome.UNKNOWN, '还不知道', 'neutral'],
  ])('outcome %s 的话是 %s（语气 %s）', async (outcome, text, tone) => {
    const user = userEvent.setup({ delay: null })
    runTraceless.mockResolvedValue(verification('param-TESTONLY'))
    const { client } = setup({ claimOutcome: outcome })
    renderWithClient({ client, children: <UpstreamsPage /> })
    await open(user)
    await user.click(await screen.findByRole('button', { name: '领取' }))

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent(text)
    expect(status).toHaveAttribute('data-tone', tone)
  })

  it('FAILED：失败带上游原话', async () => {
    const user = userEvent.setup({ delay: null })
    runTraceless.mockResolvedValue(verification('param-TESTONLY'))
    const { client } = setup({
      claimOutcome: ZcodeClaimOutcome.FAILED,
      upstreamMessage: '上游说配额不足',
    })
    renderWithClient({ client, children: <UpstreamsPage /> })
    await open(user)
    await user.click(await screen.findByRole('button', { name: '领取' }))

    const status = await screen.findByRole('status')
    expect(status).toHaveTextContent('上游说配额不足')
    expect(status).toHaveAttribute('data-tone', 'error')
  })

  it('CLAIMED 带计划名与生效时刻', async () => {
    const user = userEvent.setup({ delay: null })
    runTraceless.mockResolvedValue(verification('param-TESTONLY'))
    const { client } = setup({
      planName: '周积分包',
      effectiveAtMs: BigInt(new Date(2026, 0, 2, 13, 0).getTime()),
    })
    renderWithClient({ client, children: <UpstreamsPage /> })
    await open(user)
    await user.click(await screen.findByRole('button', { name: '领取' }))

    const row = await screen.findByText(/已领到/)
    expect(within(row.parentElement ?? row).getByText(/13:00 生效/)).toBeInTheDocument()
  })
})
