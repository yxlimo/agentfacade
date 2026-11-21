import { create, type MessageInitShape } from '@bufbuild/protobuf'
import { afterEach, describe, expect, it } from 'vitest'
import { screen } from '@testing-library/react'
import {
  ListPublishedModelsResponseSchema,
  PublishedModelSchema,
  PublishedTargetSchema,
  TargetBlocker,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { setLang } from '@/lib/i18n'
import { PublishedModelsPage } from '@/features/models/index'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'

type TargetFields = Omit<
  MessageInitShape<typeof PublishedTargetSchema>,
  '$typeName' | '$unknown'
>

function target(blocker: TargetBlocker, fields: TargetFields = {}) {
  return create(PublishedTargetSchema, {
    groupName: 'g',
    upstreamModel: 'm',
    blocked: true,
    blocker,
    ...fields,
  })
}

function renderTargets(targets: ReturnType<typeof target>[]) {
  const client = mockAdminClient({
    ListPublishedModels: () =>
      create(ListPublishedModelsResponseSchema, {
        models: [
          create(PublishedModelSchema, {
            id: 'model',
            enabled: true,
            published: true,
            targets,
          }),
        ],
      }),
  })
  renderWithClient({ client, children: <PublishedModelsPage /> })
}

describe('模型目标接不了的原因', () => {
  afterEach(async () => {
    await setLang('zh')
    localStorage.removeItem('agentfacade.lang')
  })

  it('每种 blocker 都有自己的中文句子，title 与可见文本一致', async () => {
    const cases: [TargetBlocker, string][] = [
      [TargetBlocker.UPSTREAM_DISABLED, '接不了：平台已停用'],
      [TargetBlocker.NO_CREDENTIAL, '接不了：没有可用凭据'],
      [TargetBlocker.CREDENTIAL_EXPIRED, '接不了：凭据已过期'],
      [TargetBlocker.CREDENTIAL_REJECTED, '接不了：凭据被拒绝'],
      [TargetBlocker.OUT_OF_CREDITS, '接不了：额度用尽'],
      [TargetBlocker.COOLING, '接不了：冷却中'],
      [TargetBlocker.QUEUED, '接不了：排队中'],
      [TargetBlocker.LOGGING_IN, '接不了：正在登录'],
      [TargetBlocker.UNKNOWN, '接不了：这个目标现在接不了'],
    ]
    renderTargets(cases.map(([blocker]) => target(blocker)))

    expect(await screen.findByText(cases[0][1])).toBeInTheDocument()
    for (const [blocker, sentence] of cases) {
      const badge = screen.getByText(sentence)
      expect(badge.getAttribute('title')).toBe(sentence.slice('接不了：'.length))
      expect(badge.textContent).toBe(sentence)
      void blocker
    }
  })

  it('冷却与额度用尽补恢复时刻，括号里的机器词走共享映射', async () => {
    renderTargets([
      target(TargetBlocker.COOLING, {
        recoversAtMs: 1793160000000n,
        blockerReason: 'refused',
      }),
      target(TargetBlocker.OUT_OF_CREDITS, {
        recoversAtMs: 1793163600000n,
        blockerReason: 'quota',
      }),
    ])

    expect(
      await screen.findByText(/^接不了：冷却中，.+ 恢复（上游拒绝服务）$/)
    ).toBeInTheDocument()
    const credits = screen.getByText(/^接不了：额度用尽，.+ 恢复（quota）$/)
    expect(credits.getAttribute('title')).toBe(
      credits.textContent?.slice('接不了：'.length)
    )
  })

  it('UNSPECIFIED 不显示，blocked=false 也不显示', async () => {
    renderTargets([
      target(TargetBlocker.UNSPECIFIED),
      target(TargetBlocker.COOLING, { blocked: false }),
    ])

    await screen.findByText('主路由当前公布 1 个（共 1 个）。')
    expect(screen.queryByText(/^接不了：/)).not.toBeInTheDocument()
  })

  it('英文下冷却原因与 title 都用英文', async () => {
    await setLang('en')
    renderTargets([
      target(TargetBlocker.COOLING, {
        recoversAtMs: 1793160000000n,
        blockerReason: 'refused',
      }),
    ])

    const badge = await screen.findByText(
      /^Unavailable: Cooling down, .+ \(Upstream refused the request\)$/
    )
    expect(badge.getAttribute('title')).toBe(
      badge.textContent?.replace(/^Unavailable: /, '')
    )
    expect(screen.queryByText(/接不了/)).not.toBeInTheDocument()
  })
})
