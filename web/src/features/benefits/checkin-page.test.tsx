import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AccountSchema,
  BenefitStatusSchema,
  GetBenefitStatusResponseSchema,
  ListUpstreamsResponseSchema,
  RunBenefitNowResponseSchema,
  UpstreamSchema,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { CheckinState, type BenefitStatus } from '@/gen/agentfacade/admin/v1/admin_pb'
import { CheckinPage } from '@/features/benefits/checkin-page'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/** 平台清单里的一行。签到页的行集合来自它。 */
function platform(
  id: string,
  label = '',
  accounts: { id: string; alias: string; enabled?: boolean }[] = [],
) {
  return create(UpstreamSchema, {
    id,
    label,
    accounts: accounts.map((a) =>
      create(AccountSchema, { enabled: true, ...a }),
    ),
  })
}

/** 一份平台清单。 */
function platformList(upstreams: ReturnType<typeof platform>[]) {
  return create(ListUpstreamsResponseSchema, { upstreams })
}

/** 一条签到状态。 */
// `$typeName` is a literal on the message type: spreading it into MessageInit
// makes `undefined` assignments from Partial clash with it, so it is omitted.
function benefit(
  overrides: Partial<Omit<BenefitStatus, '$typeName'>> = {},
): BenefitStatus {
  return create(BenefitStatusSchema, {
    upstreamId: 'minimax',
    accountId: '1',
    summary: '今日已签到',
    lines: [],
    checkedAt: 0n,
    credits: 0,
    ok: true,
    ...overrides,
  })
}

type Options = {
  upstreams?: ReturnType<typeof platform>[]
  benefits?: BenefitStatus[]
  runLines?: string[]
  runOk?: boolean
}

/** 假客户端：记下每次请求。 */
function setup(options: Options = {}) {
  let statusCalls = 0
  let runCalls = 0

  const client = mockAdminClient({
    ListUpstreams: () => platformList(options.upstreams ?? []),
    GetBenefitStatus: () => {
      statusCalls += 1
      return create(GetBenefitStatusResponseSchema, {
        benefits: options.benefits ?? [],
      })
    },
    RunBenefitNow: () => {
      runCalls += 1
      return create(RunBenefitNowResponseSchema, {
        ok: options.runOk ?? true,
        lines: options.runLines ?? [],
      })
    },
  })

  return { client, statusCalls: () => statusCalls, runCalls: () => runCalls }
}

/**
 * 一个平台一行，默认收起。
 */
describe('签到页', () => {
  it('答复里没有的平台不占一行，有签到的平台占一行', async () => {
    const { client } = setup({
      upstreams: [platform('minimax'), platform('qiniu')],
      benefits: [
        benefit({
          upstreamId: 'minimax',
          accountId: 'a1',
          checkinState: CheckinState.SIGNED,
        }),
      ],
    })

    renderWithClient({ client, children: <CheckinPage /> })

    const minimax = await screen.findByRole('listitem', {
      name: 'minimax 签到行',
    })
    expect(within(minimax).getByText('今日已签到')).toBeInTheDocument()

    // 第三方开放平台没有签到，后端不把它放进答复，页面也就不给它占一行。
    expect(screen.queryByRole('listitem', { name: 'qiniu 签到行' })).toBeNull()
  })

  it('平台行聚合：全签、全没签、混合比例、有未知', async () => {
    const { client: allSigned } = setup({
      upstreams: [platform('minimax')],
      benefits: [
        benefit({ accountId: 'a1', checkinState: CheckinState.SIGNED }),
        benefit({ accountId: 'a2', checkinState: CheckinState.SIGNED }),
      ],
    })
    renderWithClient({ client: allSigned, children: <CheckinPage /> })
    expect(
      within(await screen.findByRole('listitem', { name: 'minimax 签到行' })).getByText(
        '今日已签到',
      ),
    ).toBeInTheDocument()
  })

  it('平台行聚合：全没签 → 今日尚未签到', async () => {
    const { client } = setup({
      upstreams: [platform('minimax')],
      benefits: [
        benefit({ accountId: 'a1', checkinState: CheckinState.NOT_SIGNED }),
        benefit({ accountId: 'a2', checkinState: CheckinState.NOT_SIGNED }),
      ],
    })
    renderWithClient({ client, children: <CheckinPage /> })
    expect(
      within(await screen.findByRole('listitem', { name: 'minimax 签到行' })).getByText(
        '今日尚未签到',
      ),
    ).toBeInTheDocument()
  })

  it('平台行聚合：混合时说清比例', async () => {
    const { client } = setup({
      upstreams: [platform('minimax')],
      benefits: [
        benefit({ accountId: 'a1', checkinState: CheckinState.SIGNED }),
        benefit({ accountId: 'a2', checkinState: CheckinState.NOT_SIGNED }),
        benefit({ accountId: 'a3', checkinState: CheckinState.NOT_SIGNED }),
      ],
    })
    renderWithClient({ client, children: <CheckinPage /> })
    expect(
      within(await screen.findByRole('listitem', { name: 'minimax 签到行' })).getByText(
        '3 个账号中 1 个已签到',
      ),
    ).toBeInTheDocument()
  })

  it('平台行聚合：有未知且没全签 → 今日签到状态未知', async () => {
    const { client } = setup({
      upstreams: [platform('minimax')],
      benefits: [
        benefit({ accountId: 'a1', checkinState: CheckinState.SIGNED }),
        benefit({ accountId: 'a2', checkinState: CheckinState.UNKNOWN }),
      ],
    })
    renderWithClient({ client, children: <CheckinPage /> })
    expect(
      within(await screen.findByRole('listitem', { name: 'minimax 签到行' })).getByText(
        '今日签到状态未知',
      ),
    ).toBeInTheDocument()
  })

  it('反证：UNKNOWN 不算「尚未签到」', async () => {
    const { client } = setup({
      upstreams: [platform('minimax')],
      benefits: [
        benefit({ accountId: 'a1', checkinState: CheckinState.UNKNOWN }),
        benefit({ accountId: 'a2', checkinState: CheckinState.UNKNOWN }),
      ],
    })
    renderWithClient({ client, children: <CheckinPage /> })
    const row = await screen.findByRole('listitem', { name: 'minimax 签到行' })
    expect(within(row).getByText('今日签到状态未知')).toBeInTheDocument()
    expect(within(row).queryByText('今日尚未签到')).toBeNull()
  })

  it('从没问过（UNKNOWN 且 checkedAt=0）不写「还没签过」：那一格不出时间信息', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({
      upstreams: [platform('minimax')],
      benefits: [
        benefit({
          upstreamId: 'minimax',
          accountId: 'a1',
          checkinState: CheckinState.UNKNOWN,
          checkedAt: 0n,
          summary: '还没查过',
        }),
      ],
    })

    renderWithClient({ client, children: <CheckinPage /> })

    const toggle = await screen.findByRole('button', { name: 'minimax 签到' })
    await user.click(toggle)

    const detail = screen.getByRole('region', { name: 'minimax 签到明细' })
    // 「不知道」不许被说成「还没签过」。
    expect(within(detail).queryByText('还没签过')).toBeNull()
    // 没查过就没有时刻可给。
    expect(within(detail).queryByText(/上次签到/)).toBeNull()
    expect(within(detail).queryByText(/上次查询/)).toBeNull()
  })

  it('停用的账号不在签到行里占位', async () => {
    const { client } = setup({
      upstreams: [
        platform('minimax', '', [
          { id: 'a1', alias: '主号' },
          { id: 'a2', alias: '停用号', enabled: false },
        ]),
      ],
      benefits: [
        benefit({ accountId: 'a1', checkinState: CheckinState.SIGNED }),
        benefit({
          accountId: 'a2',
          checkinState: CheckinState.UNKNOWN,
          summary: '状态未知',
        }),
      ],
    })

    renderWithClient({ client, children: <CheckinPage /> })

    const row = await screen.findByRole('listitem', { name: 'minimax 签到行' })
    // 全列只剩启用的那个，停用账号不再以「未知」占一行。
    expect(within(row).getByText('今日已签到')).toBeInTheDocument()
    expect(within(row).queryByText('停用号')).toBeNull()
    expect(within(row).queryByText('状态未知')).toBeNull()
  })

  it('平台显示名用 label，没有 label 用 id', async () => {
    const { client } = setup({
      upstreams: [platform('minimax', 'MiniMax'), platform('qoder-cn')],
      benefits: [
        benefit({ upstreamId: 'minimax', accountId: 'a1', checkinState: CheckinState.SIGNED }),
        benefit({ upstreamId: 'qoder-cn', accountId: 'b1' }),
      ],
    })

    renderWithClient({ client, children: <CheckinPage /> })

    const minimax = await screen.findByRole('listitem', {
      name: 'minimax 签到行',
    })
    expect(within(minimax).getByText('MiniMax')).toBeInTheDocument()

    const qoder = screen.getByRole('listitem', { name: 'qoder-cn 签到行' })
    expect(within(qoder).getByText('qoder-cn')).toBeInTheDocument()
  })

  it('默认收起：明细不在，点开才出现', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({
      upstreams: [platform('minimax')],
      benefits: [
        benefit({
          upstreamId: 'minimax',
          accountId: 'a1',
          summary: '今日已签到',
          lines: ['minimax: +12 点'],
          checkedAt: 1_700_000_000_000n,
          credits: 12,
          checkinState: CheckinState.SIGNED,
        }),
      ],
    })

    renderWithClient({ client, children: <CheckinPage /> })

    const toggle = await screen.findByRole('button', { name: 'minimax 签到' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(
      screen.queryByRole('region', { name: 'minimax 签到明细' }),
    ).toBeNull()

    await user.click(toggle)

    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const detail = screen.getByRole('region', { name: 'minimax 签到明细' })
    expect(within(detail).getByText('minimax: +12 点')).toBeInTheDocument()
    expect(within(detail).getByText(/上次签到/)).toBeInTheDocument()
  })

  it('展开明细按账号列出，账号用别名，拿不到退回 id', async () => {
    const user = userEvent.setup({ delay: null })
    const { client } = setup({
      upstreams: [
        platform('minimax', 'MiniMax', [
          { id: 'a1', alias: '主号' },
          { id: 'a2', alias: '' },
        ]),
      ],
      benefits: [
        benefit({ upstreamId: 'minimax', accountId: 'a1', credits: 5 }),
        benefit({
          upstreamId: 'minimax',
          accountId: 'a2',
          summary: '签到未成功',
          ok: false,
        }),
      ],
    })

    renderWithClient({ client, children: <CheckinPage /> })

    const toggle = await screen.findByRole('button', { name: 'minimax 签到' })
    await user.click(toggle)

    const detail = screen.getByRole('region', { name: 'minimax 签到明细' })
    expect(within(detail).getByText('主号')).toBeInTheDocument()
    // 没有别名的账号退回显示 id
    expect(within(detail).getByText('a2')).toBeInTheDocument()
    expect(within(detail).getByText('签到未成功')).toBeInTheDocument()
  })

  it('点「立即签到」调 RunBenefitNow 并逐条显示返回的 lines', async () => {
    const { client, runCalls, statusCalls } = setup({
      upstreams: [platform('minimax')],
      benefits: [benefit({ upstreamId: 'minimax', accountId: 'a1' })],
      runLines: ['minimax: +12 点', 'qoder-cn: +8 点'],
    })

    renderWithClient({ client, children: <CheckinPage /> })

    const button = await screen.findByRole('button', { name: '立即签到' })
    await userEvent.click(button)

    await waitFor(() => {
      expect(runCalls()).toBe(1)
    })
    const result = await screen.findByLabelText('本次签到')
    expect(within(result).getByText('minimax: +12 点')).toBeInTheDocument()
    expect(within(result).getByText('qoder-cn: +8 点')).toBeInTheDocument()

    // 签到跑完要重新取一次签到状态
    await waitFor(() => {
      expect(statusCalls()).toBeGreaterThan(1)
    })
  })
})
