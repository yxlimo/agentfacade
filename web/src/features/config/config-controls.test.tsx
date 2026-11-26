// web/src/features/config/config-controls.test.tsx — 配置项按契约渲染的钉子。
//
// 三件事：毫秒的项显示与填写都是秒（发出去还是毫秒）、数字项越界在面板层被拦住
// （不发请求）、布尔项是下拉框。这些走的是真实交互路径：点「改」、改值、点「保存」。

import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
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

/**
 * 库里存在非整秒的项：1500 毫秒 —— 有人按毫秒算错了数，或者手工写的库。
 *
 * 面板既不能把它显示成 "2 秒"（四舍五入就是替用户改值），也不能自己把它写成
 * 2000；初值照原样显示，用户不动手保存就被拦住。
 */
function fractionalSecondItem() {
  return create(ConfigItemSchema, {
    key: 'ROUTER_FIRST_FRAME_MS',
    label: '首帧时限',
    value: '1500',
    fallback: '180000',
    source: 'database',
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
    // 干净的布尔值不补脏值那句提示。
    expect(screen.queryByText(/服务端存的是/)).not.toBeInTheDocument()

    await user.click(trigger)
    await user.click(await screen.findByRole('option', { name: '关闭' }))
    await user.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => expect(sent).toEqual(['false']))
  })

  /**
   * 布尔项读出来的那一路：值列与下拉必须是同一套词。
   *
   * 值列写裸的 true/false 而下拉写「开启」/「关闭」，同一个页面两套口径 ——
   * 用户看不出这是同一件事。面板上不给机器字面量。
   */
  it('布尔项的值列说「开启」「关闭」，不出现 true/false', async () => {
    const user = userEvent.setup({ delay: null })
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            create(ConfigItemSchema, {
              key: 'ROUTER_CONTINUE_ON_IDLE',
              label: '静默后自动续写',
              value: 'true',
              fallback: 'true',
              source: 'database',
              group: 'gateway',
              kind: ConfigKind.BOOLEAN,
            }),
            create(ConfigItemSchema, {
              key: 'REQUIRE_API_KEY',
              label: '是否开启 API KEY 验证',
              value: 'false',
              fallback: 'false',
              source: 'default',
              group: 'gateway',
              kind: ConfigKind.BOOLEAN,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })
    await user.click(await screen.findByRole('tab', { name: /网关/ }))
    await screen.findByText('静默后自动续写')

    /** 找 label 那一行：「值列显示什么」只在行里判，不受表头之类干扰。 */
    const rowFor = (label: string): HTMLElement => {
      const row = screen
        .getAllByRole('row')
        .find((candidate) => candidate.textContent?.includes(label))
      if (!row) throw new Error(`界面上没有「${label}」这一行`)
      return row
    }

    const onRow = rowFor('静默后自动续写')
    expect(within(onRow).getByText('开启')).toBeInTheDocument()
    // 值列里没有机器字面量：true 只在库里，不在界面上。
    expect(onRow).not.toHaveTextContent('true')

    const offRow = rowFor('是否开启 API KEY 验证')
    expect(within(offRow).getByText('关闭')).toBeInTheDocument()
    expect(offRow).not.toHaveTextContent('false')

    // 与下拉是同一套词：打开弹窗，触发器上写的也是「开启」。
    await user.click(within(onRow).getByRole('button', { name: '改' }))
    expect(screen.getByLabelText('新值')).toHaveTextContent('开启')
  })

  it('库里是非整秒的值：初值照原样显示，不动手保存就拦住 —— 不替用户四舍五入', async () => {
    const user = userEvent.setup({ delay: null })
    const sent: string[] = []
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, { items: [fractionalSecondItem()] }),
      SetConfig: (input) => {
        sent.push(input.value ?? '')
        return create(SetConfigResponseSchema, { ok: true })
      },
    })

    renderWithClient({ client, children: <ConfigPage /> })
    await user.click(await screen.findByRole('tab', { name: /网关/ }))
    await screen.findByText('首帧时限')

    // 值列说的是 1.5 秒，不是四舍五入之后的 2 秒。
    expect(screen.getByText('1.5 秒')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '改' }))
    // 初值是精确的 1.5：显示成 2 的话，用户什么都没动就保存，落库就变成 2000。
    expect(screen.getByLabelText('新值')).toHaveValue(1.5)

    // 原样保存：小数不是合法的输入，面板拦住，一个请求都不发。
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(await screen.findByText('这一项要填整数')).toBeInTheDocument()
    expect(sent).toEqual([])
  })
  /**
   * 来源的闭集之外：上游（或别的版本）写进了一个面板不认识的来源。
   *
   * 说「未知」而不是把 vendor-x 这种机器字面量摆到界面上；原始名放 title，
   * 排查时悬停能看见 —— 组键的规矩一样。
   */
  it('来源不在闭集里时说「未知」，原始来源只在 title 里', async () => {
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            create(ConfigItemSchema, {
              key: 'ADMIN_CORS_ORIGINS',
              label: '允许的跨域来源',
              value: 'https://example.com',
              fallback: '',
              source: 'vendor-x',
              group: 'general',
              kind: ConfigKind.STRING,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })
    await screen.findByText('允许的跨域来源')

    const badge = screen.getByText('未知')
    // 来源名不丢：只在 title 里。
    expect(badge).toHaveAttribute('title', 'vendor-x')
    // 界面上没有机器字面量。
    expect(screen.queryByText(/vendor-x/)).not.toBeInTheDocument()
  })

  /**
   * 库里的布尔值既不是 true 也不是 false（有人手工改过库，或者旧版本写进去的）。
   *
   * 面板不猜它是开还是关：值列与触发器都照原文说，弹窗里再点明一句
   * 保存会把它改成用户选的那个。
   */
  it('布尔的脏值原样显示，弹窗里说明保存会改成选的那个', async () => {
    const user = userEvent.setup({ delay: null })
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            create(ConfigItemSchema, {
              key: 'REQUIRE_API_KEY',
              label: '是否开启 API KEY 验证',
              value: 'yes',
              fallback: 'false',
              source: 'database',
              group: 'gateway',
              kind: ConfigKind.BOOLEAN,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })
    await user.click(await screen.findByRole('tab', { name: /网关/ }))

    const row = screen
      .getAllByRole('row')
      .find((candidate) => candidate.textContent?.includes('是否开启 API KEY 验证'))
    if (!row) throw new Error('界面上没有「是否开启 API KEY 验证」这一行')

    // 值列：原样是 yes，不是「开启」，也不是「关闭」。
    expect(within(row).getByText('yes')).toBeInTheDocument()
    expect(within(row).queryByText('开启')).not.toBeInTheDocument()
    expect(within(row).queryByText('关闭')).not.toBeInTheDocument()

    await user.click(within(row).getByRole('button', { name: '改' }))

    // 触发器上也照原文，不编成「开启」。
    expect(screen.getByLabelText('新值')).toHaveTextContent('yes')
    // 弹窗里点明：库里的 yes 会在保存时被换掉。
    expect(
      screen.getByText('服务端存的是 yes，保存会改成你选的')
    ).toBeInTheDocument()
  })
})
