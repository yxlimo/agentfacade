import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import {
  ListUpstreamsResponseSchema,
  ProviderPolicy,
  UpstreamSchema,
  UpstreamState,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { setLang } from '@/lib/i18n'
import { UpstreamsPage } from '@/features/upstreams/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

function row(id: string, fields: Omit<MessageInitShape<typeof UpstreamSchema>, '$typeName' | '$unknown'> = {}) {
  return create(UpstreamSchema, {
    id,
    label: id,
    state: UpstreamState.READY,
    policy: ProviderPolicy.SINGLE,
    policies: [ProviderPolicy.SINGLE],
    ...fields,
  })
}

describe('平台行的状态原因（英文）', () => {
  afterEach(async () => {
    await setLang('zh')
    localStorage.removeItem('agentfacade.lang')
  })

  it('冷却、账号计数与熔断都用英文词典', async () => {
    await setLang('en')
    const client = mockAdminClient({
      ListUpstreams: () =>
        create(ListUpstreamsResponseSchema, {
          upstreams: [
            row('cooling', {
              state: UpstreamState.COOLING,
              cooldownUntilMs: 1793160000000n,
              cooldownReason: 'refused',
            }),
            row('mixed', {
              enabledAccounts: 3,
              coolingAccounts: 1,
              exhaustedAccounts: 2,
              cooldownUntilMs: 1793160000000n,
              breakerSkipped: true,
              breakerUntilMs: 1793163600000n,
            }),
          ],
        }),
    })

    renderWithClient({ client, children: <UpstreamsPage /> })

    expect(
      await screen.findByText(/^Cooling until .+ \(Upstream refused the request\)$/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        /^Of 3 accounts, 1 account cooling until .+, 2 accounts out of credits; Skipped, resumes at .+$/
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/冷却到/)).not.toBeInTheDocument()
  })
})
