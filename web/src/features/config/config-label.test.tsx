import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import {
  ConfigItemSchema,
  ListConfigResponseSchema,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { ConfigPage } from '@/features/config/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/**
 * 配置页不该把 env 键名甩给人。
 *
 * 契约里 ConfigItem.label 是自然语言的名字（「是否开启 API KEY 验证」这种）。
 * 没有 label 就退回 description 的第一句。
 */
describe('配置页的名字', () => {
  it('主要显示是 label，键名不进可见文字（只在 title 里）', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            create(ConfigItemSchema, {
              key: 'REQUIRE_API_KEY',
              label: '是否开启 API KEY 验证',
              value: 'true',
              source: 'default',
              fallback: 'true',
              group: 'gateway',
              description: '开启后，调用网关的 agent 必须带 API KEY。',
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await screen.findByText('是否开启 API KEY 验证')
    // 键名不摆到界面上：那是给机器看的，用户不该看见。
    expect(screen.queryByText(/REQUIRE_API_KEY/)).not.toBeInTheDocument()
    // 键名不丢：悬停在名字上能看见（与「未知来源」「未知分组」同一套做法）。
    expect(screen.getByText('是否开启 API KEY 验证')).toHaveAttribute(
      'title',
      'REQUIRE_API_KEY'
    )
  })

  it('没有 label 就用 description 的第一句', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            create(ConfigItemSchema, {
              key: 'REQUIRE_API_KEY',
              label: '',
              value: 'true',
              source: 'default',
              fallback: 'true',
              group: 'gateway',
              description: '开启后，调用网关的 agent 必须带 API KEY。改完立刻生效。',
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await screen.findByText('开启后，调用网关的 agent 必须带 API KEY')
    // 描述的第一句当了标题，剩下那半句在下面，不重复一遍。
    expect(screen.getByText('改完立刻生效。')).toBeInTheDocument()
    expect(
      screen.queryByText('开启后，调用网关的 agent 必须带 API KEY。改完立刻生效。')
    ).not.toBeInTheDocument()
  })

  it('label 和 description 都没有时说「未知」，键名只在 title 里', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            create(ConfigItemSchema, {
              key: 'MYSTERY_KEY',
              label: '',
              value: '1',
              source: 'default',
              fallback: '1',
              group: 'general',
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })
    // 没有名字就说「未知」：键名不摆到界面上，只留在 title 里。
    const name = await screen.findByText('未知')
    expect(name).toHaveAttribute('title', 'MYSTERY_KEY')
    expect(screen.queryByText('MYSTERY_KEY')).not.toBeInTheDocument()
  })
})
