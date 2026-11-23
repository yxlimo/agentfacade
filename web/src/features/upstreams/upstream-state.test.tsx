import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import {
  ListUpstreamsResponseSchema,
  ProviderPolicy,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { UpstreamsPage } from '@/features/upstreams/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/**
 * 平台的状态徽章按 state 显示。
 *
 * 能不能接由后端说（state），面板不自己拼「有账号 && 账号开着 && 登录了」。
 */
function platform(
  id: string,
  label: string,
  state: UpstreamState,
  hasEnabledAccount = false
) {
  return create(UpstreamSchema, {
    id,
    label,
    state,
    policy: ProviderPolicy.SINGLE,
    policies: [ProviderPolicy.SINGLE],
    accountCount: 0,
    hasEnabledAccount,
  })
}


function row(
  id: string,
  label: string,
  fields: Omit<MessageInitShape<typeof UpstreamSchema>, '$typeName' | '$unknown'> = {}
) {
  return create(UpstreamSchema, {
    id,
    label,
    state: UpstreamState.READY,
    policy: ProviderPolicy.SINGLE,
    policies: [ProviderPolicy.SINGLE],
    ...fields,
  })
}

describe('上游页的状态徽章', () => {
  it('按 state 显示', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            platform('ready', '就绪的那个', UpstreamState.READY, true),
            platform('off', '关着的那个', UpstreamState.DISABLED),
            platform('no-cred', '没登录的那个', UpstreamState.NO_CREDENTIAL),
            platform('no-money', '没额度的那个', UpstreamState.OUT_OF_CREDITS),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(await screen.findByText('就绪')).toBeInTheDocument()
    expect(screen.getByText('已停用')).toBeInTheDocument()
    expect(screen.getByText('没登录')).toBeInTheDocument()
    expect(screen.getByText('额度用完')).toBeInTheDocument()
  })

  it('登录过期了、登录被拒了、正在登录也各有各的说法', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            platform('expired', '过期的', UpstreamState.CREDENTIAL_EXPIRED),
            platform('rejected', '被拒的', UpstreamState.CREDENTIAL_REJECTED),
            platform('logging', '登录中的', UpstreamState.LOGGING_IN),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(await screen.findByText('登录过期了')).toBeInTheDocument()
    expect(screen.getByText('登录被拒了')).toBeInTheDocument()
    // 徽标说「正在登录」一次；原因句不再重复同一句。
    expect(screen.getAllByText('正在登录')).toHaveLength(1)
  })

  it('正在登录：徽标说一次，原因句不再重复', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [platform('logging', '登录中的', UpstreamState.LOGGING_IN)],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    await screen.findByText('登录中的')
    const row = screen.getByText('登录中的').closest('tr')
    if (!row) throw new Error('找不到那一行')

    // 状态格里「正在登录」只出现一次 —— 徽标那一处。
    expect(within(row).getAllByText('正在登录')).toHaveLength(1)
    // 状态格除了徽标没有第二段原因文字（连未翻译的 key 也不许漏出来）。
    const stateCell = within(row).getByText('正在登录').closest('td')
    if (!stateCell) throw new Error('找不到状态格')
    expect(stateCell).toHaveTextContent(/^正在登录$/)
  })

  it('冷却中：徽章说冷却中，还说为什么、到什么时候', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'qoder',
              label: 'Qoder 全球区',
              state: UpstreamState.COOLING,
              policy: ProviderPolicy.SINGLE,
              policies: [ProviderPolicy.SINGLE],
              accountCount: 1,
              hasEnabledAccount: true,
              cooldownUntilMs: 1793160000000n,
              cooldownReason: 'refused',
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(await screen.findByText('冷却中')).toBeInTheDocument()
    // 冷却中是黄色，跟额度用完（红色，不行）区分开。
    expect(screen.getByText('冷却中').className).toContain('amber')
    // 后端给的是 state + 时刻 + 机器词；面板按语言渲染成一句。
    expect(screen.getByText(/^冷却到 .+（上游拒绝服务）$/)).toBeInTheDocument()
    expect(screen.queryByText(/refused/)).not.toBeInTheDocument()
  })



  it('额度用尽：窗口结束时刻跟着说', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            row('no-money', '没额度的', {
              state: UpstreamState.OUT_OF_CREDITS,
              creditsRecoverAtMs: 1793160000000n,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(
      await screen.findByText(/^额度用尽，窗口 .+ 结束$/)
    ).toBeInTheDocument()
  })

  it('平台能接，但名下账号有冷却与用尽：两种计数一起说', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            row('mixed', '账号有状况的', {
              enabledAccounts: 3,
              coolingAccounts: 1,
              exhaustedAccounts: 2,
              cooldownUntilMs: 1793160000000n,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(
      await screen.findByText(/^3 个账号里 1 个冷却到 .+，2 个额度用尽$/)
    ).toBeInTheDocument()
  })

  it('熔断跳过另起一句，用分号连在原因后面', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            row('tripped', '被熔断的', {
              coolingAccounts: 1,
              cooldownUntilMs: 1793160000000n,
              breakerSkipped: true,
              breakerUntilMs: 1793163600000n,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(
      await screen.findByText(/个冷却到 .+；已跳过，恢复时间 .+$/)
    ).toBeInTheDocument()
  })

  it('没有账号与有账号没凭据分别说明', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            row('empty', '没有账号的', {
              state: UpstreamState.NO_CREDENTIAL,
              accountCount: 0,
            }),
            row('no-key', '没有凭据的', {
              state: UpstreamState.NO_CREDENTIAL,
              accountCount: 1,
              enabledAccounts: 1,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(
      await screen.findByText('这个平台还没有账号：在「平台」页新增一个账号并登录')
    ).toBeInTheDocument()
    expect(
      screen.getByText('没有可用凭据：在「平台」页填写 API Key 或登录')
    ).toBeInTheDocument()
  })

  it('其余不能接的状态各有自己的原句', async () => {
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            row('off', '关着的', { state: UpstreamState.DISABLED }),
            row('expired', '过期的', {
              state: UpstreamState.CREDENTIAL_EXPIRED,
            }),
            row('rejected', '被拒的', {
              state: UpstreamState.CREDENTIAL_REJECTED,
            }),
            row('queued', '排队的', { state: UpstreamState.QUEUED }),
            row('logging', '登录中的', { state: UpstreamState.LOGGING_IN }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(
      await screen.findByText('这个平台的账号均已关闭：在「平台」页启用一个')
    ).toBeInTheDocument()
    expect(
      screen.getByText('凭据已过期：等待自动刷新，或重新登录')
    ).toBeInTheDocument()
    expect(screen.getByText('凭据被拒绝：重新登录')).toBeInTheDocument()
    expect(
      screen.getByText(
        '上游把模型排进队列，暂时发不出去：这里改不了什么，等它自己放行'
      )
    ).toBeInTheDocument()
    // 徽标说「正在登录」一次；原因句不再重复同一句。
    expect(screen.getAllByText('正在登录')).toHaveLength(1)
  })

  it('面板不自己拼状态：后端说没登录，就显示没登录', async () => {
    // 平台下有开着的账号，但后端说 state 是没登录 —— 面板照后端说。
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            create(UpstreamSchema, {
              id: 'minimax',
              label: 'MiniMax Code',
              state: UpstreamState.NO_CREDENTIAL,
              policy: ProviderPolicy.SINGLE,
              policies: [ProviderPolicy.SINGLE],
              accountCount: 1,
              hasEnabledAccount: true,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(await screen.findByText('没登录')).toBeInTheDocument()
    expect(screen.queryByText('就绪')).not.toBeInTheDocument()
  })
})
