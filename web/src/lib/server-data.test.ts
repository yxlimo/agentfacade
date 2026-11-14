import { describe, expect, it } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { queryKeys } from '@/lib/query-keys'
import { invalidateServerData } from '@/lib/server-data'

describe('invalidateServerData', () => {
  it('改了平台：插件相关查询也失效', () => {
    const client = new QueryClient()
    client.setQueryData(queryKeys.quotaPlugins.all, [])

    invalidateServerData(client, 'platforms')

    expect(
      client.getQueryState(queryKeys.quotaPlugins.all)?.isInvalidated,
    ).toBe(true)
  })
})
