import { afterEach, describe, expect, it } from 'vitest'
import { create } from '@bufbuild/protobuf'
import { render, screen } from '@testing-library/react'
import { PlatformKindSchema } from '@/gen/agentfacade/admin/v1/admin_pb'
import { setLang } from '@/lib/i18n'
import { PlatformDialog } from '@/features/open-platforms/platform-dialog'

/**
 * 建平台的弹窗在 en 下要说英文。断言的是行为：标签、按钮与提示都从词典取，
 * 不是在组件里写死的中文。
 */
describe('新增平台弹窗（英文）', () => {
  afterEach(async () => {
    await setLang('zh')
    localStorage.removeItem('agentfacade.lang')
  })

  it('类型、表单与按钮都跟着语言走', async () => {
    await setLang('en')

    render(
      <PlatformDialog
        open
        kinds={{
          status: 'ready',
          kinds: [
            create(PlatformKindSchema, {
              kind: 'openai',
              label: 'OpenAI compatible',
              defaultBaseUrl: '',
            }),
          ],
        }}
        existing={[]}
        pending={false}
        onSubmit={() => {}}
        onOpenChange={() => {}}
      />
    )

    expect(screen.getByText('Add platform')).toBeInTheDocument()
    expect(screen.queryByText('新增平台')).not.toBeInTheDocument()
    expect(screen.getByText('Kind')).toBeInTheDocument()
    expect(screen.getByText('Search templates')).toBeInTheDocument()
    expect(screen.getByText('Platform id')).toBeInTheDocument()
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByText('Address')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add' })).toBeInTheDocument()
    expect(
      screen.getByText('Still needed: platform id、name、address')
    ).toBeInTheDocument()
  })

  it('切回中文，界面跟着回来', async () => {
    await setLang('en')
    await setLang('zh')

    render(
      <PlatformDialog
        open
        kinds={{
          status: 'ready',
          kinds: [
            create(PlatformKindSchema, {
              kind: 'openai',
              label: 'OpenAI 兼容',
              defaultBaseUrl: '',
            }),
          ],
        }}
        existing={[]}
        pending={false}
        onSubmit={() => {}}
        onOpenChange={() => {}}
      />
    )

    expect(screen.getByText('新增平台')).toBeInTheDocument()
    expect(screen.queryByText('Add platform')).not.toBeInTheDocument()
  })
})
