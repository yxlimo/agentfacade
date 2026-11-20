import { create } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ListQuotaPluginsResponseSchema,
  ListUpstreamsResponseSchema,
  QuotaPluginSchema,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { QuotaPluginsPage } from '@/features/quota-plugins/index'
import { setLang } from '@/lib/i18n'
import { mockAdminClient } from '@/test/mock-transport'
import { listProviderKinds } from '@/test/provider-kinds-fixture'
import { renderWithClient } from '@/test/render'

describe('插件列表（英文）', () => {
  afterEach(async () => {
    await setLang('zh')
    localStorage.removeItem('agentfacade.lang')
  })

  function client(plugins: ReturnType<typeof createPlugin>[]) {
    return mockAdminClient({
      ListProviderKinds: listProviderKinds,
      ListQuotaPlugins: () =>
        create(ListQuotaPluginsResponseSchema, { plugins }),
      ListUpstreams: () => create(ListUpstreamsResponseSchema, {}),
    })
  }

  function createPlugin() {
    return create(QuotaPluginSchema, {
      id: 'demo',
      label: 'Demo Plugin',
      baseUrls: [],
      platforms: [],
      fields: [],
    })
  }

  it('空状态与列表标题是英文', async () => {
    await setLang('en')
    renderWithClient({
      client: client([]),
      children: <QuotaPluginsPage />,
    })
    expect(
      await screen.findByText('The gateway registered no quota plugins')
    ).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Plugins' })).toBeInTheDocument()
    expect(screen.queryByText('插件列表')).not.toBeInTheDocument()
  })

  it('插件来自服务端，展开动作与说明是英文', async () => {
    await setLang('en')
    const user = userEvent.setup({ delay: null })
    renderWithClient({
      client: client([createPlugin()]),
      children: <QuotaPluginsPage />,
    })

    const list = await screen.findByRole('list', { name: 'Plugin list' })
    const item = within(list).getByRole('listitem', {
      name: 'Quota plugin Demo Plugin',
    })
    expect(within(item).getByText('Demo Plugin')).toBeInTheDocument()
    expect(within(item).getByText('No base URL declared')).toBeInTheDocument()
    await user.click(
      within(item).getByRole('button', {
        name: 'Expand platforms and accounts for Demo Plugin',
      })
    )
    expect(within(item).getByText('No platforms use this plugin')).toBeInTheDocument()
  })
})
