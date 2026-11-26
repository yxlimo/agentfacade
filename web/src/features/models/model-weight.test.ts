import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { PublishedModelSchema } from '@/gen/agentfacade/admin/v1/admin_pb'
import {
  fromDraft,
  resolvedWeight,
  targetWeight,
  toDraft,
} from '@/features/models/model-dialog'
import { newUid } from '@/lib/uid'

/**
 * 权重有两种含义，一个函数把两种都说清。
 *
 * single / fallback 下位次就是优先级：权重由位次推导（第一个最大），保存时手填的
 * 份额不算数。balance 下权重是份额（加权一致性哈希，越大分到的会话越多）：用草稿
 * 里填的，与位次无关；草稿里是 null 才退回位次（null 本来就是「按位次推导」）。
 */
describe('顺序与权重', () => {
  it('权重按位次从大到小填，第一个最大', () => {
    expect(targetWeight(0, 3)).toBe(3)
    expect(targetWeight(1, 3)).toBe(2)
    expect(targetWeight(2, 3)).toBe(1)
    // 只有一个目标时权重就是 1。
    expect(targetWeight(0, 1)).toBe(1)
  })

  it('fallback：发出去的权重照草稿的先后，第一个最大', () => {
    const draft = toDraft(
      create(PublishedModelSchema, {
        id: 'buddy-max',
        strategy: 'fallback',
      })
    )
    draft.targets = [
      { groupName: 'minimax', upstreamModel: 'MiniMax-M2', uid: newUid(), weight: null, weightText: '' },
      { groupName: 'qoder-cn', upstreamModel: 'claude-sonnet-4', uid: newUid(), weight: null, weightText: '' },
    ]

    const model = fromDraft(draft)
    expect(model.targets.map((target) => target.weight)).toEqual([2, 1])
  })

  it('single：只有一个目标，权重也按顺序填（就是 1）', () => {
    const draft = toDraft(
      create(PublishedModelSchema, {
        id: 'buddy-max',
        strategy: 'single',
      })
    )
    draft.targets = [
      { groupName: 'minimax', upstreamModel: 'MiniMax-M2', uid: newUid(), weight: null, weightText: '' },
    ]

    const model = fromDraft(draft)
    expect(model.strategy).toBe('single')
    expect(model.targets[0].weight).toBe(1)
  })

  it('目标上一律写 enabled，读的时候不看它', () => {
    const model = create(PublishedModelSchema, {
      id: 'buddy-max',
      strategy: 'fallback',
      targets: [
        { groupName: 'minimax', upstreamModel: 'MiniMax-M2', weight: 9, enabled: false },
        { groupName: 'qoder-cn', upstreamModel: 'claude-sonnet-4', weight: 4, enabled: true },
      ],
    })

    // 读：开着关着都一样画，草稿里没有这一格。
    const draft = toDraft(model)
    // uid 是草稿内部的行标识，每行各有一个；这里只看内容字段。
    expect(draft.targets.map(({ groupName, upstreamModel }) => ({ groupName, upstreamModel }))).toEqual([
      { groupName: 'minimax', upstreamModel: 'MiniMax-M2' },
      { groupName: 'qoder-cn', upstreamModel: 'claude-sonnet-4' },
    ])

    // 写：全部写开。不想去这个目标就把它删掉。
    expect(fromDraft(draft).targets.map((target) => target.enabled)).toEqual([
      true,
      true,
    ])
  })

  it('服务端的次序读进来就照原样摆：后端已经是权重从大到小', () => {
    const model = create(PublishedModelSchema, {
      id: 'buddy-max',
      strategy: 'fallback',
      targets: [
        { groupName: 'minimax', upstreamModel: 'MiniMax-M2', weight: 30, enabled: true },
        { groupName: 'qoder-cn', upstreamModel: 'claude-sonnet-4', weight: 20, enabled: true },
      ],
    })

    expect(toDraft(model).targets.map((target) => target.upstreamModel)).toEqual([
      'MiniMax-M2',
      'claude-sonnet-4',
    ])
  })

  it('resolvedWeight：balance 下用手填的份额，与位次无关', () => {
    // 第一行填 3、第二行填 7：份额比位次小也不会被「纠正」成 2、1 —— 会话按 7:3 分。
    expect(resolvedWeight({ weight: 3 }, 0, 2, 'balance')).toBe(3)
    expect(resolvedWeight({ weight: 7 }, 1, 2, 'balance')).toBe(7)
    // 三行也一样：填几就存几。
    expect(resolvedWeight({ weight: 9 }, 2, 3, 'balance')).toBe(9)
  })

  it('resolvedWeight：single / fallback 下不看份额，位次就是优先级', () => {
    expect(resolvedWeight({ weight: 7 }, 0, 2, 'fallback')).toBe(2)
    expect(resolvedWeight({ weight: 7 }, 1, 2, 'fallback')).toBe(1)
    expect(resolvedWeight({ weight: 9 }, 0, 3, 'single')).toBe(3)
  })

  it('resolvedWeight：草稿里没填（null）时退回位次', () => {
    expect(resolvedWeight({ weight: null }, 0, 2, 'balance')).toBe(2)
    expect(resolvedWeight({ weight: null }, 1, 2, 'balance')).toBe(1)
  })

  it('balance：库里存的份额原样回到草稿，存出去还是那个数', () => {
    const model = create(PublishedModelSchema, {
      id: 'buddy-max',
      strategy: 'balance',
      targets: [
        { groupName: 'minimax', upstreamModel: 'MiniMax-M2', weight: 7, enabled: true },
        { groupName: 'qoder-cn', upstreamModel: 'claude-sonnet-4', weight: 3, enabled: true },
      ],
    })

    const draft = toDraft(model)
    // 份额进草稿，跟位次无关：第一行 7、第二行 3。
    expect(draft.targets.map((target) => target.weight)).toEqual([7, 3])
    expect(draft.targets.map((target) => target.weightText)).toEqual(['7', '3'])
    // 再存回去还是 7、3 —— 不是按位次重算成 2、1。
    expect(fromDraft(draft).targets.map((target) => target.weight)).toEqual([7, 3])
  })

  it('single / fallback：服务端那串优先级不读进草稿（那是位次，不是份额）', () => {
    const model = create(PublishedModelSchema, {
      id: 'buddy-max',
      strategy: 'fallback',
      targets: [
        { groupName: 'minimax', upstreamModel: 'MiniMax-M2', weight: 30, enabled: true },
        { groupName: 'qoder-cn', upstreamModel: 'claude-sonnet-4', weight: 20, enabled: true },
      ],
    })

    const draft = toDraft(model)
    expect(draft.targets.map((target) => target.weight)).toEqual([null, null])
    expect(draft.targets.map((target) => target.weightText)).toEqual(['', ''])
    // 存出去仍然是位次推导出来的 2、1。
    expect(fromDraft(draft).targets.map((target) => target.weight)).toEqual([2, 1])
  })
})
