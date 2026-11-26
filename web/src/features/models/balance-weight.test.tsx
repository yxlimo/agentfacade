import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
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

/** 两个平台，各自有模型目录（和面板上真的一样，模型是下拉选的）。 */
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

/** 两个目标的模型：余额策略下权重由这个函数给定，位次照服务端回的摆。 */
function twoTargets(strategy: string, weights: [number, number]): PublishedModel {
  const target = (upstreamModel: string, weight: number) =>
    create(PublishedTargetSchema, {
      groupName: 'tokenrhythm',
      upstreamModel,
      weight,
      enabled: true,
    })
  return create(PublishedModelSchema, {
    id: 'buddy-max',
    displayName: 'buddy-max',
    enabled: true,
    strategy,
    targets: [target('glm-5.3-flash', weights[0]), target('neohorse-1-9b', weights[1])],
  })
}

/** 目标卡片里的行（不排序时候的卡片）。 */
function rows(): HTMLElement[] {
  return within(screen.getByRole('list', { name: '目标顺序' })).getAllByRole('listitem')
}

/** 各行的权重输入框（type=number → spinbutton）。 */
function weightInputs(): HTMLInputElement[] {
  return screen.getAllByRole<HTMLInputElement>('spinbutton')
}

/** 各行的权重数值，按显示的次序。 */
function weightValues(): string[] {
  return weightInputs().map((input) => input.value)
}

/** 进「平台目标」页签。 */
async function openTargets(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('tab', { name: /平台目标/ }))
}

/** 在「基本」页签里把策略换成 label 那一个。 */
async function pickStrategy(
  user: ReturnType<typeof userEvent.setup>,
  label: string
) {
  await user.click(screen.getByRole('tab', { name: /^基本/ }))
  await user.click(screen.getByRole('combobox', { name: '策略' }))
  await user.click(await screen.findByRole('option', { name: label }))
}

/** 改第 index 行的权重原文。输入框是受控的，直接派 change 把原文交进去。 */
function typeWeight(index: number, text: string) {
  fireEvent.change(weightInputs()[index], { target: { value: text } })
}

/** 挂一个弹窗，收集交上去的模型。 */
function renderDialog(model: PublishedModel, submitted: PublishedModel[]) {
  return renderWithClient({
    client: catalogClient(),
    children: (
      <ModelDialog
        open
        model={model}
        onOpenChange={() => {}}
        onSubmit={(saved) => submitted.push(saved)}
      />
    ),
  })
}

describe('balance 下的权重是份额', () => {
  it('single / fallback 下没有权重输入框，只有那行只读的位次权重', async () => {
    const user = userEvent.setup({ delay: null })
    renderDialog(twoTargets('fallback', [2, 1]), [])

    await openTargets(user)

    // 位次就是权重：只读的那行字。
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0)
    expect(screen.getByText('权重 2')).toBeInTheDocument()
    expect(screen.getByText('权重 1')).toBeInTheDocument()
  })

  it('切到 balance 的那一刻，权重按位次填好（两行 → 2、1），不是空也不是 0', async () => {
    const user = userEvent.setup({ delay: null })
    renderDialog(twoTargets('fallback', [2, 1]), [])

    await pickStrategy(user, '按会话负载均衡')
    await openTargets(user)

    expect(weightValues()).toEqual(['2', '1'])
    // 只读的那行字让位给输入框：不再两个都摆。
    expect(screen.queryByText('权重 2')).not.toBeInTheDocument()
    // 说明：权重是份额。
    expect(
      screen.getByText('权重是份额，比重按比例分会话：7 和 3 就是七三分，改它不用动顺序')
    ).toBeInTheDocument()
  })

  it('balance：填 7 / 3 保存，发出去的就是 7 / 3，与位次无关', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: PublishedModel[] = []
    renderDialog(twoTargets('balance', [2, 1]), submitted)

    await openTargets(user)
    typeWeight(0, '7')
    typeWeight(1, '3')
    expect(weightValues()).toEqual(['7', '3'])

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(
      submitted[0].targets.map((target) => [target.upstreamModel, target.weight])
    ).toEqual([
      ['glm-5.3-flash', 7],
      ['neohorse-1-9b', 3],
    ])
  })

  it('balance：0、负数、小数、空都拦下，不发请求', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: PublishedModel[] = []
    renderDialog(twoTargets('balance', [2, 1]), submitted)

    await openTargets(user)
    const save = screen.getByRole('button', { name: '保存' })

    for (const bad of ['0', '-1', '1.5', '']) {
      typeWeight(0, bad)

      // 格子里说清是哪一条，保存灰着。
      expect(weightInputs()[0]).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByText('只填大于 0 的整数')).toBeInTheDocument()
      expect(save).toBeDisabled()

      // 判别力所在：点下去也不交东西。
      await user.click(save)
      expect(submitted).toEqual([])
    }

    // 填对了：提示没了，保存又能点。
    typeWeight(0, '1')
    expect(screen.queryByText('只填大于 0 的整数')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(save).toBeEnabled()
    })
    await user.click(save)
    expect(submitted[0].targets.map((target) => target.weight)).toEqual([1, 1])
  })

  it('切回依次回退：权重回到位次推导（7 / 3 不跨策略留着）', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: PublishedModel[] = []
    renderDialog(twoTargets('balance', [7, 3]), submitted)

    await openTargets(user)
    expect(weightValues()).toEqual(['7', '3'])

    await pickStrategy(user, '依次回退')
    await openTargets(user)

    // 没有输入框了，只读那行字按位次摆。
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0)
    expect(screen.getByText('权重 2')).toBeInTheDocument()
    expect(screen.getByText('权重 1')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(submitted[0].strategy).toBe('fallback')
    expect(submitted[0].targets.map((target) => target.weight)).toEqual([2, 1])
  })

  it('balance 下排序仍然可用：排完次序换了，份额原样不动', async () => {
    const user = userEvent.setup({ delay: null })
    const submitted: PublishedModel[] = []
    renderDialog(twoTargets('balance', [7, 3]), submitted)

    await openTargets(user)
    // 排序按钮在（balance 下顺序仍然决定次选先后）。
    await user.click(screen.getByRole('button', { name: '排序' }))
    const sortRows = within(
      await screen.findByRole('list', { name: '目标顺序' })
    ).getAllByRole('listitem')
    expect(sortRows.map((row) => row.textContent)).toEqual([
      'tokenrhythm / glm-5.3-flash',
      'tokenrhythm / neohorse-1-9b',
    ])

    // 键盘把第一行往下挪一位：位次换了，份额跟着各自的目标走 —— 7 还是
    // glm-5.3-flash 的份额，不会因为挪了位置就变成别人的（那是优先级在变，不是份
    // 额在变）。
    fireEvent.keyDown(sortRows[0], { key: 'ArrowDown', altKey: true })
    await user.click(screen.getByRole('button', { name: '完成排序' }))

    expect(rows().map((row) => within(row).getAllByRole('combobox')[1].textContent)).toEqual([
      'neohorse-1-9b',
      'glm-5.3-flash',
    ])
    expect(weightValues()).toEqual(['3', '7'])

    await user.click(screen.getByRole('button', { name: '保存' }))
    expect(
      submitted[0].targets.map((target) => [target.upstreamModel, target.weight])
    ).toEqual([
      ['neohorse-1-9b', 3],
      ['glm-5.3-flash', 7],
    ])
  })
})
