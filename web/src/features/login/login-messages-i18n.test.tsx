import { create } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  LoginWithPasswordResponseSchema,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { credentialKindLabel } from '@/lib/credential-kind'
import { setLang } from '@/lib/i18n'
import { useLoginWithPassword } from '@/features/login/api'
import { ProviderKeysDialog } from '@/features/accounts/provider-keys-dialog'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: toastError,
    success: toastSuccess,
  }),
  Toaster: () => null,
}))

function LoginButton() {
  const login = useLoginWithPassword()
  return (
    <button
      type='button'
      onClick={() =>
        login.mutate({
          upstreamId: 'demo',
          accountId: 'acc',
          username: 'name',
          password: 'password',
          remember: false,
        })
      }
    >
      Go
    </button>
  )
}

describe('登录反馈与凭据说法（英文）', () => {
  afterEach(async () => {
    toastError.mockClear()
    toastSuccess.mockClear()
    await setLang('zh')
    localStorage.removeItem('agentfacade.lang')
  })

  it('凭据类型有英文说法，没登记的值原样显示', async () => {
    await setLang('en')
    expect(credentialKindLabel('session')).toBe('Login session')
    expect(credentialKindLabel('api_key')).toBe('Inference key')
    expect(credentialKindLabel('cookie')).toBe('Quota cookie')
    expect(credentialKindLabel('plan_key')).toBe('plan_key')
  })

  it('登录失败时上报英文的兜底提示', async () => {
    await setLang('en')
    const client = mockAdminClient({
      LoginWithPassword: () =>
        create(LoginWithPasswordResponseSchema, { ok: false, message: '' }),
    })
    renderWithClient({ client, children: <LoginButton /> })

    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Go' }))

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith('Login failed')
    })
    expect(toastError.mock.calls.join()).not.toContain('登录没成功')
  })

  it('凭据弹窗的提示与按钮是英文', async () => {
    await setLang('en')
    const onSubmit = vi.fn()
    render(
      <ProviderKeysDialog
        open
        onOpenChange={vi.fn()}
        pending={false}
        onSubmit={onSubmit}
        layout={{
          title: 'Demo credentials',
          fields: [{ id: 'key', label: 'Inference key' }],
        }}
      />
    )

    expect(
      screen.getByText('Leave a field empty to clear that credential.')
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Save' }))
    expect(onSubmit).toHaveBeenCalledWith([''])
  })
})
