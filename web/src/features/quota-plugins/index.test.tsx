import { create } from '@bufbuild/protobuf'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  AccountSchema,
  ListAccountsResponseSchema,
  ListCredentialsResponseSchema,
  ListPublishedModelsResponseSchema,
  ListQuotaPluginsResponseSchema,
  ListUpstreamsResponseSchema,
  ProviderPolicy,
  QuotaPluginFieldSchema,
  QuotaPluginSchema,
  SetProviderKeysResponseSchema,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { QuotaPlugin, Upstream } from '@/gen/buddy/admin/v1/admin_pb'
import { QuotaPluginsPage } from '@/features/quota-plugins/index'
import { mockAdminClient } from '@/test/mock-transport'
import { listProviderKinds } from '@/test/provider-kinds-fixture'
import { renderWithClient } from '@/test/render'

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: toastError,
    success: toastSuccess,
  }),
  Toaster: () => null,
}))

/** 七牛的插件：地址对得上下面那个平台的地址，要一段额度 Cookie。 */
function qiniuPlugin(): QuotaPlugin {
  return create(QuotaPluginSchema, {
    id: 'qiniu',
    label: '七牛云资源包',
    baseUrls: ['https://api.qiniu.example.com/v1'],
    fields: [
      create(QuotaPluginFieldSchema, {
        name: 'account',
        label: '额度 Cookie',
        secret: true,
      }),
    ],
  })
}

/** TokenRhythm 的插件：没有任何平台的地址对得上它。 */
function lonelyPlugin(): QuotaPlugin {
  return create(QuotaPluginSchema, {
    id: 'tokenrhythm-wallet',
    label: 'TokenRhythm 钱包',
    baseUrls: ['https://api.tokenrhythm.example.com/v1'],
    fields: [],
  })
}

/** 一个开放平台：地址对得上七牛的插件，名下一个账号。 */
function matchedPlatform(): Upstream {
  return create(UpstreamSchema, {
    id: 'my-qiniu',
    kind: 'openai',
    label: '我的七牛',
    baseUrl: 'https://api.qiniu.example.com/v1',
    state: UpstreamState.NO_CREDENTIAL,
    policy: ProviderPolicy.SINGLE,
    policies: [ProviderPolicy.SINGLE],
    accountCount: 1,
    isOpenPlatform: true,
    fromRow: true,
    accounts: [
      create(AccountSchema, {
        id: 'my-qiniu-1',
        platform: 'my-qiniu',
        alias: '七牛一号',
        enabled: true,
        status: 'missing',
        credentialCount: 0,
      }),
    ],
  })
}

/** 一个开放平台：地址对不上任何插件。 */
function unmatchedPlatform(): Upstream {
  return create(UpstreamSchema, {
    id: 'my-plain',
    kind: 'openai',
    label: '普通中转',
    baseUrl: 'https://api.plain.example.com/v1',
    state: UpstreamState.NO_CREDENTIAL,
    policy: ProviderPolicy.SINGLE,
    policies: [ProviderPolicy.SINGLE],
    accountCount: 0,
    isOpenPlatform: true,
    fromRow: true,
    accounts: [],
  })
}

function clientOf(
  plugins: QuotaPlugin[],
  upstreams: Upstream[],
  sent: string[][]
) {
  return mockAdminClient({
    ListProviderKinds: listProviderKinds,
    ListQuotaPlugins: () =>
      create(ListQuotaPluginsResponseSchema, { plugins }),
    ListUpstreams: () =>
      create(ListUpstreamsResponseSchema, { upstreams }),
    ListAccounts: () => create(ListAccountsResponseSchema, { accounts: [] }),
    ListCredentials: () =>
      create(ListCredentialsResponseSchema, { credentials: [] }),
    ListPublishedModels: () =>
      create(ListPublishedModelsResponseSchema, { models: [] }),
    SetProviderKeys: (input) => {
      sent.push([...(input.keys ?? [])])
      return create(SetProviderKeysResponseSchema, {
        count: (input.keys ?? []).length,
      })
    },
  })
}

/** 展开一个插件的那一行。 */
async function expand(
  user: ReturnType<typeof userEvent.setup>,
  label: string
) {
  await user.click(
    await screen.findByRole('button', {
      name: `展开 ${label} 的平台与账号`,
    })
  )
}

describe('插件列表页', () => {
  beforeEach(() => {
    toastSuccess.mockClear()
    toastError.mockClear()
    window.history.replaceState(null, '', '/')
  })

  it('一行一个插件：名字与它声明的地址都摆出来', async () => {
    const client = clientOf([qiniuPlugin(), lonelyPlugin()], [], [])

    renderWithClient({ client, children: <QuotaPluginsPage /> })

    const list = await screen.findByRole('list', { name: '插件列表' })
    expect(
      within(list).getByRole('listitem', { name: '额度插件 七牛云资源包' })
    ).toBeInTheDocument()
    expect(
      within(list).getByText('https://api.qiniu.example.com/v1')
    ).toBeInTheDocument()
    expect(
      within(list).getByText('https://api.tokenrhythm.example.com/v1')
    ).toBeInTheDocument()
  })

  it('展开插件：列出当前匹配到它的平台与账号，逐账号填凭据', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[][] = []
    const client = clientOf(
      [qiniuPlugin()],
      [matchedPlatform(), unmatchedPlatform()],
      sent
    )

    renderWithClient({ client, children: <QuotaPluginsPage /> })

    await expand(user, '七牛云资源包')

    // 匹配到它的平台与它的账号都在。
    expect(await screen.findByText('我的七牛')).toBeInTheDocument()
    expect(screen.getByText('七牛一号')).toBeInTheDocument()
    // 地址对不上插件的平台不挂在这个插件名下。
    expect(screen.queryByText('普通中转')).not.toBeInTheDocument()

    // 凭据格子沿用平台那套：推理 Key 在前，插件要的那段在后。
    await user.click(await screen.findByRole('button', { name: '凭据' }))
    await user.type(await screen.findByLabelText('推理 Key'), 'sk-infer')
    await user.type(await screen.findByLabelText('额度 Cookie'), 'c=1')
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(sent).toEqual([['sk-infer', 'c=1']])
    })
  })

  it('没有任何平台匹配的插件：展开区说明「暂无平台使用这个插件」', async () => {
    const user = userEvent.setup({ delay: null })
    const client = clientOf(
      [qiniuPlugin(), lonelyPlugin()],
      [matchedPlatform()],
      []
    )

    renderWithClient({ client, children: <QuotaPluginsPage /> })

    await expand(user, 'TokenRhythm 钱包')

    // 这是唯一的提示文案：它说的是事实，不是错误。
    expect(
      await screen.findByText('暂无平台使用这个插件')
    ).toBeInTheDocument()
  })
})
