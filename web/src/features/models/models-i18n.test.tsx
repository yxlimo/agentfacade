import { afterEach, describe, expect, it } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { screen } from '@testing-library/react'
import { ListUpstreamsResponseSchema } from '@/gen/agentfacade/admin/v1/admin_pb'
import { setLang } from '@/lib/i18n'
import { ModelDialog } from '@/features/models/model-dialog'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

/**
 * 主路由模型的弹窗在 en 下说英文：断言标题、标签与按钮取自词典。
 */
describe('主路由模型弹窗（英文）', () => {
  afterEach(async () => {
    await setLang('zh')
    localStorage.removeItem('agentfacade.lang')
  })

  it('标题、表单与页脚按钮都是英文', async () => {
    await setLang('en')

    renderWithClient({
      client: mockAdminClient({
        ListUpstreams: () => create(ListUpstreamsResponseSchema, {}),
      }),
      children: (
        <ModelDialog
          open
          model={undefined}
          busy={false}
          onOpenChange={() => {}}
          onSubmit={() => {}}
        />
      ),
    })

    expect(screen.getByText('Add main router model')).toBeInTheDocument()
    expect(screen.queryByText('新增主路由模型')).not.toBeInTheDocument()
    expect(screen.getByText('Basic')).toBeInTheDocument()
    expect(screen.getByText('Platform targets')).toBeInTheDocument()
    expect(screen.getByText('Public id')).toBeInTheDocument()
    expect(screen.getByText('Display name')).toBeInTheDocument()
    expect(screen.getByText('Context length')).toBeInTheDocument()
    expect(screen.getByText('Maximum output')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
  })

  it('切回中文，界面跟着回来', async () => {
    await setLang('en')
    await setLang('zh')

    renderWithClient({
      client: mockAdminClient({
        ListUpstreams: () => create(ListUpstreamsResponseSchema, {}),
      }),
      children: (
        <ModelDialog
          open
          model={undefined}
          busy={false}
          onOpenChange={() => {}}
          onSubmit={() => {}}
        />
      ),
    })

    expect(screen.getByText('新增主路由模型')).toBeInTheDocument()
    expect(screen.queryByText('Add main router model')).not.toBeInTheDocument()
  })
})
