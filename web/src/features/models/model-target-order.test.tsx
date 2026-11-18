import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  CatalogModelSchema,
  CredentialState,
  CredentialStatusSchema,
  ListModelsResponseSchema,
  ListUpstreamsResponseSchema,
  PublishedModelSchema,
  PublishedTargetSchema,
  UpstreamSchema,
  UpstreamState,
  type PublishedModel,
} from '@/gen/agentfacade/admin/v1/admin_pb'
import { ModelDialog } from '@/features/models/model-dialog'
import { mockAdminClient } from '@/test/mock-transport'
import { renderWithClient } from '@/test/render'
import { pointerDrag, stubRowGeometry } from '@/test/row-geometry'

/** 一个开着的、已登录的上游。 */
function usableUpstream(id: string, label: string) {
  return create(UpstreamSchema, {
    id,
    label,
    enabled: true,
    state: UpstreamState.READY,
    modelCount: 2,
    credential: create(CredentialStatusSchema, {
      status: CredentialState.AUTHENTICATED,
      kind: 'session',
    }),
  })
}

/** 两个平台，各自有模型目录。 */
function catalogClient() {
  return mockAdminClient({
    ListUpstreams: () =>
      create(ListUpstreamsResponseSchema, {
        upstreams: [
          usableUpstream('tokenrhythm', 'TokenRhythm'),
          usableUpstream('workbuddy-cn', 'WorkBuddy 国内区'),
        ],
      }),
    ListModels: (input) =>
      create(ListModelsResponseSchema, {
        models: (
          input.upstreamId === 'workbuddy-cn'
            ? ['glm-5.3-flash', 'glm-5.3-air']
            : ['glm-5.3-flash', 'neohorse-1-9b']
        ).map((id) => create(CatalogModelSchema, { id, displayName: id })),
      }),
  })
}

/**
 * 三个目标，次序照服务端回的（已经是权重从大到小）：a、b、c。
 *
 * 三个都填全了、组合互不相同，一打开就存得下去。
 */
function threeTargets(): PublishedModel {
  const target = (
    groupName: string,
    upstreamModel: string,
    weight: number
  ) =>
    create(PublishedTargetSchema, {
      groupName,
      upstreamModel,
      weight,
      enabled: true,
    })
  return create(PublishedModelSchema, {
    id: 'buddy-max',
    displayName: 'buddy-max',
    enabled: true,
    strategy: 'fallback',
    targets: [
      target('tokenrhythm', 'glm-5.3-flash', 30),
      target('tokenrhythm', 'neohorse-1-9b', 20),
      target('workbuddy-cn', 'glm-5.3-air', 10),
    ],
  })
}

/**
 * 拖拽走指针事件：悬停位按行高中点切，jsdom 里先钉住几何再拖。
 */
function dragRowTo(from: HTMLElement, toClientY: number) {
  stubRowGeometry()
  pointerDrag(from, toClientY)
}

/** 目标列表里的各行。 */
function rows(): HTMLElement[] {
  return within(
    screen.getByRole('list', { name: '目标顺序' })
  ).getAllByRole('listitem')
}

/** 进排序模式：目标压成一行，拖着排。 */
async function enterSortMode(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: /平台目标/ }))
  await user.click(screen.getByRole('button', { name: '排序' }))
  await screen.findByRole('list', { name: '目标顺序' })
}

/** 排序模式下各行的「平台组 / 上游模型」，按显示的次序。 */
function listedCombos(): string[] {
  return rows().map((row) => row.textContent ?? '')
}

/** 界面上各行的上游模型 id，按显示的次序。 */
function listedModels(): string[] {
  return rows().map((row) => {
    const combos = within(row).getAllByRole('combobox')
    return combos[combos.length - 1].textContent ?? ''
  })
}

/** 界面上各行的权重那一行字。 */
function listedWeights(): string[] {
  return rows().map((row) => {
    const node = within(row).queryByText(/^权重 /)
    return node?.textContent ?? ''
  })
}

function dialog(submitted: PublishedModel[]) {
  return (
    <ModelDialog
      open
      model={threeTargets()}
      onOpenChange={() => {}}
      onSubmit={(model) => submitted.push(model)}
    />
  )
}

describe('目标的顺序即权重', () => {
  it('排序模式下拖动一行放到另一行上：次序跟着换，权重按新的位次重算', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: PublishedModel[] = []
    renderWithClient({ client: catalogClient(), children: dialog(submitted) })

    await user.click(screen.getByRole('tab', { name: /平台目标/ }))
    expect(listedModels()).toEqual([
      'glm-5.3-flash',
      'neohorse-1-9b',
      'glm-5.3-air',
    ])
    expect(listedWeights()).toEqual(['权重 3', '权重 2', '权重 1'])

    await user.click(screen.getByRole('button', { name: '排序' }))
    await screen.findByRole('list', { name: '目标顺序' })

    // 第一行拖到最后一行上：它换到那个位次。
    dragRowTo(rows()[0], 120)

    expect(listedCombos()).toEqual([
      'tokenrhythm / neohorse-1-9b',
      'workbuddy-cn / glm-5.3-air',
      'tokenrhythm / glm-5.3-flash',
    ])

    // 退出排序：回到完整卡片，顺序与权重都照新的位次。
    await user.click(screen.getByRole('button', { name: '完成排序' }))
    expect(listedModels()).toEqual([
      'neohorse-1-9b',
      'glm-5.3-air',
      'glm-5.3-flash',
    ])
    // 权重跟着位次走：第一个最大。
    expect(listedWeights()).toEqual(['权重 3', '权重 2', '权重 1'])

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(
      submitted[0].targets.map((target) => [
        target.upstreamModel,
        target.weight,
      ])
    ).toEqual([
      ['neohorse-1-9b', 3],
      ['glm-5.3-air', 2],
      ['glm-5.3-flash', 1],
    ])
  })

  it('排序模式下焦点在行上时 Alt + 下箭头把这一行往下挪一位', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: PublishedModel[] = []
    renderWithClient({ client: catalogClient(), children: dialog(submitted) })

    await enterSortMode(user)
    fireEvent.keyDown(rows()[0], { key: 'ArrowDown', altKey: true })

    expect(listedCombos()).toEqual([
      'tokenrhythm / neohorse-1-9b',
      'tokenrhythm / glm-5.3-flash',
      'workbuddy-cn / glm-5.3-air',
    ])

    await user.click(screen.getByRole('button', { name: '完成排序' }))
    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(
      submitted[0].targets.map((target) => [
        target.upstreamModel,
        target.weight,
      ])
    ).toEqual([
      ['neohorse-1-9b', 3],
      ['glm-5.3-flash', 2],
      ['glm-5.3-air', 1],
    ])
  })

  it('重排后每行的 data-sort-id 跟着内容走：id 稳定且互不重复', async () => {
    const user = userEvent.setup({ delay: null })
    renderWithClient({ client: catalogClient(), children: dialog([]) })

    await enterSortMode(user)
    stubRowGeometry()

    /** 排序模式下某内容所在行的 data-sort-id。 */
    const sortIdOf = (content: string) =>
      rows()
        .find((row) => row.textContent?.includes(content))
        ?.getAttribute('data-sort-id')

    const flashId = sortIdOf('tokenrhythm / glm-5.3-flash')
    const ids = rows().map((row) => row.getAttribute('data-sort-id'))
    // 每行都有自己的 id：用下标当 id 的话这里就只有 '0' '1' '2'，重排
    // 后永远对不上行，落位过渡量不出位移。
    expect(new Set(ids).size).toBe(ids.length)
    expect(flashId).toBeDefined()

    // 键盘换位：内容跟着自己的 id 走。
    fireEvent.keyDown(rows()[0], { key: 'ArrowDown', altKey: true })
    expect(sortIdOf('tokenrhythm / glm-5.3-flash')).toBe(flashId)

    // 拖动换位：同理。
    pointerDrag(rows()[0], 120)
    expect(sortIdOf('tokenrhythm / glm-5.3-flash')).toBe(flashId)
  })

  it('目标卡片上不再有「上移 / 下移」按钮：排序只能进排序模式', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: PublishedModel[] = []
    renderWithClient({ client: catalogClient(), children: dialog(submitted) })

    await user.click(screen.getByRole('tab', { name: /平台目标/ }))
    expect(screen.queryByRole('button', { name: '上移目标 1' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '下移目标 1' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '下移目标 3' })).not.toBeInTheDocument()
    expect(
      screen.queryByLabelText(/^上移 |^下移 /)
    ).not.toBeInTheDocument()

    // 排序按钮在，能进出。
    await user.click(screen.getByRole('button', { name: '排序' }))
    expect(await screen.findByRole('list', { name: '目标顺序' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '完成排序' }))

    // 退出后各字段的输入原样回来。
    expect(listedModels()).toEqual([
      'glm-5.3-flash',
      'neohorse-1-9b',
      'glm-5.3-air',
    ])

    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(submitted[0].targets.map((target) => target.upstreamModel)).toEqual([
      'glm-5.3-flash',
      'neohorse-1-9b',
      'glm-5.3-air',
    ])
  })

  it('删掉的目标不再出现在保存结果里，剩下的权重重新排', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: PublishedModel[] = []
    renderWithClient({ client: catalogClient(), children: dialog(submitted) })

    await user.click(screen.getByRole('tab', { name: /平台目标/ }))
    await user.click(screen.getByRole('button', { name: '删除目标 2' }))

    expect(listedModels()).toEqual(['glm-5.3-flash', 'glm-5.3-air'])
    expect(listedWeights()).toEqual(['权重 2', '权重 1'])

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(
      submitted[0].targets.map((target) => [
        target.upstreamModel,
        target.weight,
      ])
    ).toEqual([
      ['glm-5.3-flash', 2],
      ['glm-5.3-air', 1],
    ])
  })

  it('目标上没有启用开关：保存时一律写开', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: PublishedModel[] = []
    renderWithClient({ client: catalogClient(), children: dialog(submitted) })

    await user.click(screen.getByRole('tab', { name: /平台目标/ }))

    for (const row of rows()) {
      expect(within(row).queryAllByRole('switch')).toHaveLength(0)
    }

    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(submitted[0].targets.map((target) => target.enabled)).toEqual([
      true,
      true,
      true,
    ])
  })
})
