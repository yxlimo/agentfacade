import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { AccountSchema, UpstreamSchema } from '@/gen/agentfacade/admin/v1/admin_pb'
import { disabledAccountIds } from '@/features/benefits/checkin-page'

function account(id: string, enabled: boolean) {
  return create(AccountSchema, { id, enabled })
}

describe('disabledAccountIds', () => {
  it('collects disabled accounts across two levels', () => {
    const upstreams = [
      create(UpstreamSchema, {
        id: 'a',
        accounts: [account('a1', true), account('a2', false)],
      }),
      create(UpstreamSchema, {
        id: 'b',
        accounts: [account('b1', false)],
      }),
    ]
    expect(disabledAccountIds(upstreams)).toEqual(new Set(['a2', 'b1']))
  })

  it('returns an empty set when every account is enabled', () => {
    const upstreams = [
      create(UpstreamSchema, { id: 'a', accounts: [account('a1', true)] }),
    ]
    expect(disabledAccountIds(upstreams).size).toBe(0)
  })

  it('accepts an upstream without accounts', () => {
    expect(disabledAccountIds([create(UpstreamSchema, { id: 'a' })]).size).toBe(
      0,
    )
  })
})
