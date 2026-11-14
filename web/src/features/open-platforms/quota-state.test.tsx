import { create } from '@bufbuild/protobuf'
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  CreditSummarySchema,
  UpstreamQuotaSchema,
  UpstreamSchema,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { MessageInitShape } from '@bufbuild/protobuf'
import { OpenPlatformFacts } from '@/features/open-platforms/platform-facts'
import { formatLocalMoment } from '@/lib/format'

/**
 * 额度那一栏按服务端给的结论说。
 *
 * 七种状态各说一句，不能并成「未知」，也不能写成 0：写成 0 是替上游说「一点
 * 不剩」，那是它没说过的话。状态名由面板定，`message` 是插件写的一句话（可能
 * 为空）——只靠它的话，没钱与账号不能用会挤成同一句。
 */

/** 服务端说的上一次拉目录的时刻。 */
const FETCHED_AT = BigInt(Date.UTC(2026, 10, 3, 4, 0, 0))
/** 服务端说的恢复时刻。 */
const RECOVER_AT = BigInt(Date.UTC(2027, 0, 15, 11, 30, 0))

/** 一个开放平台的额度栏。 */
function facts(
  quota: MessageInitShape<typeof UpstreamQuotaSchema>,
  /** 平台行带来的插件三格：缺省是有插件（服务端匹配好了）。 */
  plugin: { id?: string; label?: string } = { id: 'qiniu-portal', label: '七牛门户' }
) {
  const upstream = create(UpstreamSchema, {
    id: 'my-gateway',
    label: '我的中转站',
    kind: 'openai',
    baseUrl: 'https://api.example.com/v1',
    isOpenPlatform: true,
    models: ['gpt-4o'],
    modelsFetchedAtMs: FETCHED_AT,
    quotaPluginId: plugin.id ?? '',
    quotaPluginLabel: plugin.label ?? '',
    quota: create(UpstreamQuotaSchema, quota),
  })
  return <OpenPlatformFacts upstream={upstream} />
}

/** 全页文字：断言「哪里都没有 0」时用它。 */
function text(): string {
  return document.body.textContent ?? ''
}

describe('额度那一栏按结论说', () => {
  it('ok：显示数字，不显示状态名', () => {
    render(
      facts({
        quotaState: 'ok',
        credits: create(CreditSummarySchema, {
          total: 2000,
          used: 800,
          remaining: 1200,
        }),
      })
    )

    expect(screen.getByText('额度：七牛门户')).toBeInTheDocument()
    expect(screen.getByText('剩 1,200 点')).toBeInTheDocument()
    expect(screen.queryByText('额度用尽')).not.toBeInTheDocument()
    expect(screen.queryByText('未知')).not.toBeInTheDocument()
  })

  it('no_quota：额度用尽，带恢复时刻，不显示 0', () => {
    render(
      facts({
        quotaState: 'no_quota',
        recoverAtMs: RECOVER_AT,
        message: '资源包已用尽',
      })
    )

    const when = formatLocalMoment(RECOVER_AT)
    expect(
      screen.getByText(`额度用尽 · ${when} 恢复`)
    ).toBeInTheDocument()
    // 插件那一句话另起一行：状态名不靠它，它只是补充。
    expect(screen.getByText('资源包已用尽')).toBeInTheDocument()
    // 没有数字：不显示那一行，也不显示 0。
    expect(screen.queryByText(/额度：七牛门户/)).not.toBeInTheDocument()
    expect(text()).not.toMatch(/剩 0|¥0|0 点/)
  })

  it('blocked：平台说这个账号不能用，带恢复时刻', () => {
    render(
      facts({
        quotaState: 'blocked',
        recoverAtMs: RECOVER_AT,
        message: '账号被停用',
      })
    )

    const when = formatLocalMoment(RECOVER_AT)
    expect(
      screen.getByText(`平台说这个账号不能用 · ${when} 恢复`)
    ).toBeInTheDocument()
    // 与「额度用尽」不是同一句：两种不能接，原因不同。
    expect(screen.queryByText(/额度用尽/)).not.toBeInTheDocument()
    expect(text()).not.toMatch(/剩 0|¥0|0 点/)
  })

  it('unauthorized：凭据被拒，不说恢复时刻', () => {
    render(
      facts({
        quotaState: 'unauthorized',
        message: '会话被拒',
      })
    )

    expect(screen.getByText('凭据被拒')).toBeInTheDocument()
    expect(screen.queryByText(/恢复/)).not.toBeInTheDocument()
    expect(text()).not.toMatch(/剩 0|¥0|0 点/)
  })

  it('恢复时刻只看服务端给没给：我没列过的状态带了也显示', () => {
    // 哪几种状态会带「什么时候恢复」是服务端定的，面板不另列一份名单 ——
    // 两份名单一旦不同步，服务端给的时刻就被面板藏掉了。
    render(facts({ quotaState: 'unauthorized', recoverAtMs: RECOVER_AT }))

    const when = formatLocalMoment(RECOVER_AT)
    expect(screen.getByText(`凭据被拒 · ${when} 恢复`)).toBeInTheDocument()
  })

  it('rate_limited：被限流，带恢复时刻', () => {
    render(
      facts({
        quotaState: 'rate_limited',
        recoverAtMs: RECOVER_AT,
        message: '同一个会话问得太勤',
      })
    )

    const when = formatLocalMoment(RECOVER_AT)
    expect(screen.getByText(`被限流 · ${when} 恢复`)).toBeInTheDocument()
    expect(screen.queryByText(/额度用尽|不能用|凭据被拒/)).not.toBeInTheDocument()
  })

  it('missing：还没填凭据', () => {
    render(facts({ quotaState: 'missing' }))

    expect(screen.getByText('还没填凭据')).toBeInTheDocument()
    expect(screen.queryByText('未知')).not.toBeInTheDocument()
  })

  it('unknown：未知（问了但问不到）', () => {
    render(facts({ quotaState: 'unknown', message: '网络断了' }))

    expect(screen.getByText('未知')).toBeInTheDocument()
    expect(screen.getByText('网络断了')).toBeInTheDocument()
    expect(text()).not.toMatch(/剩 0|¥0|0 点/)
  })

  it('quotaState 空串：整栏不渲染', () => {
    render(facts({ quotaState: '' }))

    // 没有结论就什么都不说：不写「未知」，不写 0，也不摆一个空位。
    expect(screen.queryByText(/^额度：/)).not.toBeInTheDocument()
    expect(screen.queryByText('未知')).not.toBeInTheDocument()
    expect(screen.queryByText('—')).not.toBeInTheDocument()
    // 插件那一行已经退场：卡片上只有目录，没有插件行。
    expect(screen.queryByText(/额度插件/)).not.toBeInTheDocument()
  })

  it('没结论但有数字（不走插件的种类）：数字照旧显示', () => {
    render(
      facts({
        quotaState: '',
        credits: create(CreditSummarySchema, {
          total: 2000,
          used: 800,
          remaining: 1200,
        }),
      })
    )

    // 套餐额度/积分/余额这几样在插件之外的老路径上，`quota_state` 是空的 ——
    // 数字是服务端给的，不能因为没有状态名就丢掉。
    expect(screen.getByText('额度：七牛门户')).toBeInTheDocument()
    expect(screen.getByText('剩 1,200 点')).toBeInTheDocument()
  })
})

/**
 * 登记表没到手：插件认不出来，额度区整块不摆。
 *
 * 匹配按地址进行，登记表没到手就说不准「这个地址有没有插件」——那种时候既
 * 不能摆「额度插件：还在加载」，也不能把服务端给的结论硬挂在一个认不出的
 * 插件名下。整块不显示、不报错。
 */
describe('登记表没到手', () => {
  it('quota_plugin_id 空：没有额度接口，额度区整块不摆', () => {
    render(facts({ quotaState: 'no_quota' }, { id: '', label: '' }))

    expect(screen.queryByText('额度用尽')).not.toBeInTheDocument()
    expect(text()).not.toMatch(/额度插件|未知插件|没登记/)
  })

  it('quota_plugin_id 空且有数字：数字也不显示（没有插件可挂）', () => {
    render(
      facts(
        {
          quotaState: 'ok',
          credits: create(CreditSummarySchema, {
            total: 2000,
            used: 800,
            remaining: 1200,
          }),
        },
        { id: '', label: '' }
      )
    )

    expect(screen.queryByText(/额度：/)).not.toBeInTheDocument()
    expect(screen.queryByText(/剩 1,200 点/)).not.toBeInTheDocument()
  })
})

/**
 * 认不出的状态原样显示。
 *
 * 服务端给的是一串字符串：`constructor`、`toString` 这样的值要是不查自己的表、
 * 退到 Object 原型上，界面上就是一段函数体 —— 那是面板自己的 bug，不是服务端
 * 的结论。
 */
describe('认不出的状态', () => {
  for (const state of ['constructor', 'toString', 'hasOwnProperty']) {
    it(`原值显示：${state}`, () => {
      render(facts({ quotaState: state }))

      expect(screen.getByText(state)).toBeInTheDocument()
      expect(text()).not.toMatch(/native code|function|\[object/)
    })
  }
})

/**
 * 预置的模拟客户端：地址与插件行不摆。
 *
 * 地址在库里是空串（由模拟端定），空地址对不上任何插件 —— 额度区与插件行
 * 整块不摆，不留一个空的行、一句「额度插件：未选」。
 */
describe('模拟客户端那一行', () => {
  /** 一条模拟客户端平台：地址是空串（归代码）。 */
  function simulated(id: string, kind: string) {
    const upstream = create(UpstreamSchema, {
      id,
      kind,
      label: id,
      baseUrl: '',
      isOpenPlatform: true,
      models: ['MiniMax-M2'],
    })
    return <OpenPlatformFacts upstream={upstream} />
  }

  it('地址与额度插件两行都不摆', () => {
    render(simulated('minimax', 'minimax'))

    expect(screen.queryByText(/额度插件/)).not.toBeInTheDocument()
    // 地址那一行是空串：整行不摆，也不留一个空白行。
    expect(text()).not.toMatch(/^\s*$/m)
    expect(screen.queryByText(/^https?:/)).not.toBeInTheDocument()
  })
})
