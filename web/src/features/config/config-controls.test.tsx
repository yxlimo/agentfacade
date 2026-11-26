// web/src/features/config/config-controls.test.tsx — 配置项按契约渲染的钉子。
//
// 三件事：毫秒的项显示与填写都是秒（发出去还是毫秒）、数字项越界在面板层被拦住
// （不发请求）、布尔项是下拉框。这些走的是真实交互路径：点「改」、改值、点「保存」。

import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ConfigItemSchema,
  ConfigKind,
  ConfigUnit,
  ListConfigResponseSchema,
  SetConfigResponseSchema,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { ConfigPage } from '@/features/config/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/** 一个毫秒的项（首帧时限）：传输是毫秒，面板上是秒。 */
function millisecondItem() {
  return create(ConfigItemSchema, {
    key: 'ROUTER_FIRST_FRAME_MS',
    label: '首帧时限',
    value: '180000',
    fallback: '180000',
    source: 'default',
    group: 'gateway',
    kind: ConfigKind.NUMBER,
    unit: ConfigUnit.MILLISECONDS,
    hasMax: true,
    maxValue: 600000n,
  })
}

describe('配置页按契约渲染控件', () => {
  it('毫秒的项显示与填写都是秒，保存发回的仍是毫秒', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, { items: [millisecondItem()] }),
      SetConfig: (input) => {
        sent.push(input.value ?? '')
        return create(SetConfigResponseSchema, { ok: true })
      },
    })

    renderWithClient({ client, children: <ConfigPage /> })
    await user.click(await screen.findByRole('tab', { name: /网关/ }))
    await screen.findByText('首帧时限')

    // 值列说的是秒，不是毫秒。
    expect(screen.getByText('180 秒')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '改' }))
    const input = screen.getByLabelText('新值') as HTMLInputElement
    expect(input.value).toBe('180')
    expect(input.type).toBe('number')

    await user.clear(input)
    await user.type(input, '90')
    await user.click(screen.getByRole('button', { name: '保存' }))

    // 传输层不变：秒写进去，落库的仍是毫秒。
    await waitFor(() => expect(sent).toEqual(['90000']))
  })

  it('越界的数字在面板层被拦住，不发请求', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, { items: [millisecondItem()] }),
      SetConfig: (input) => {
        sent.push(input.value ?? '')
        return create(SetConfigResponseSchema, { ok: true })
      },
    })

    renderWithClient({ client, children: <ConfigPage /> })
    await user.click(await screen.findByRole('tab', { name: /网关/ }))
    await user.click(await screen.findByRole('button', { name: '改' }))

    const input = screen.getByLabelText('新值')
    await user.clear(input)
    await user.type(input, '700')
    await user.click(screen.getByRole('button', { name: '保存' }))

    // 界是 600 秒（契约里的 600000 毫秒），填 700 秒越界。
    expect(await screen.findByText('不能大于 600 秒')).toBeInTheDocument()
    expect(screen.getByLabelText('新值')).toHaveAttribute(
      'aria-invalid',
      'true'
    )
    expect(sent).toEqual([])
  })

  it('布尔项是下拉框，选的值发回 true/false', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            create(ConfigItemSchema, {
              key: 'REQUIRE_API_KEY',
              label: '是否开启 API KEY 验证',
              value: 'true',
              fallback: 'false',
              source: 'default',
              group: 'gateway',
              kind: ConfigKind.BOOLEAN,
            }),
          ],
        }),
      SetConfig: (input) => {
        sent.push(input.value ?? '')
        return create(SetConfigResponseSchema, { ok: true })
      },
    })

    renderWithClient({ client, children: <ConfigPage /> })
    await user.click(await screen.findByRole('tab', { name: /网关/ }))
    await screen.findByText('是否开启 API KEY 验证')

    await user.click(screen.getByRole('button', { name: '改' }))
    const trigger = screen.getByLabelText('新值')
    // 当前值是 true：触发器上写「开启」，不是让人手打 true。
    expect(trigger).toHaveTextContent('开启')

    await user.click(trigger)
    await user.click(await screen.findByRole('option', { name: '关闭' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(sent).toEqual(['false']))
  })
})
