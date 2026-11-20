import { create } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  ConfigItemSchema,
  ListConfigResponseSchema,
  SetConfigResponseSchema,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { ConfigPage } from '@/features/config/index'
import { setLang } from '@/lib/i18n'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

function item(group: string, label: string, extra: object = {}) {
  return create(ConfigItemSchema, {
    key: 'SOME_KEY',
    group,
    label,
    value: 'true',
    source: 'environment',
    fallback: 'false',
    description: '',
    secret: false,
    hasValue: true,
    ...extra,
  })
}

describe('配置页（英文）', () => {
  afterEach(async () => {
    await setLang('zh')
    localStorage.removeItem('agentfacade.lang')
  })

  it('分组、表头与来源是英文，配置项名字由后端提供', async () => {
    await setLang('en')
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            item('general', 'Allowed origins'),
            item('gateway', 'Require API key', { source: 'default' }),
          ],
        }),
    })

    renderWithClient({ client, children: <ConfigPage /> })

    expect(await screen.findByRole('tab', { name: /General/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Gateway/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Setting' })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'Source' })).toBeInTheDocument()
    expect(screen.getByText('Allowed origins')).toBeInTheDocument()
    // 来源说明走词典，后端给的字段名不翻。
    expect(screen.getAllByText('Environment variable').length).toBeGreaterThan(0)
    expect(screen.queryByText('环境变量')).not.toBeInTheDocument()
  })

  it('弹窗提示与按钮随语言切换', async () => {
    await setLang('en')
    const user = userEvent.setup({ delay: null })
    let setCalls = 0
    const client = mockAdminClient({
      ListConfig: () =>
        create(ListConfigResponseSchema, {
          items: [
            item('general', 'Secret setting', {
              key: 'SECRET_KEY',
              secret: true,
              hasValue: true,
            }),
          ],
        }),
      SetConfig: () => {
        setCalls++
        return create(SetConfigResponseSchema, {})
      },
    })

    renderWithClient({ client, children: <ConfigPage /> })

    await user.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(screen.getByText('New value')).toBeInTheDocument()
    expect(
      screen.getByText(
        'This value cannot be read. Leave empty to keep it unchanged.'
      )
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    // 空值不发请求：空串会被后端当成清空密钥。
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(setCalls).toBe(0)
  })
})
