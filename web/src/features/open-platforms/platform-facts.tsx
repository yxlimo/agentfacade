import type {
  QuotaPlugin,
  Upstream,
} from '@/gen/buddy/admin/v1/admin_pb'
import type { QuotaRegistry } from '@/features/accounts/provider-key-fields'
import { hasQuota, quotaStateText, QuotaSummary } from '@/features/balance/quota'
import { quotaPluginForBaseUrl } from '@/lib/quota-match'
import { formatLocalMoment } from '@/lib/format'

/** 一次「刷新模型目录」的结果：服务端给的，面板照它显示。 */
export type RefreshOutcome = {
  ok: boolean
  message: string
  models: string[]
}

/**
 * 开放平台的那几格：地址、模型目录、额度。
 *
 * 面板知道的都以服务端给的为准：
 *
 *   地址、模型目录、上次拉取的时刻        Upstream（ListUpstreams）
 *   额度插件与它的地址声明                额度插件登记表（ListQuotaPlugins）
 *   额度现在的结论                        Upstream.quota.quotaState
 *
 * 额度插件按平台地址匹配（不是平台上选的）：对不上任何插件的平台就是没有
 * 额度接口 —— 额度区整块不摆，不报错，也不提示。模拟客户端（预置的那几条）
 * 不摆地址：它们靠 id 与 kind 从清单里认出来（两个 Qoder 的 kind 相同）。
 *
 * 额度按服务端给的结论说：`ok` 给数字，其余各说一句（额度用尽、平台说这个账号
 * 不能用、凭据被拒、被限流、还没填凭据、未知），没有结论就不说这一栏。
 * 这些结论都不是 0：0 说的是「一点不剩」，那是替上游说它没说过的话。
 */
export function OpenPlatformFacts({
  upstream,
  registry,
  refresh,
}: {
  upstream: Upstream
  /** 额度插件登记表：三档（加载中 / 取不到 / 到手）。 */
  registry: QuotaRegistry
  /** 上一次刷新模型目录的结果。 */
  refresh?: RefreshOutcome
}) {
  // 额度插件按地址匹配；登记表没到手 / 取不到的时候认不出来，额度区整块不摆
  // （那种时候说「没有插件」是错的）。匹配不到就是没有额度接口：不显示、不报
  // 错、不提示。
  const plugin =
    registry.status === 'ready'
      ? quotaPluginForBaseUrl(registry.plugins, upstream.baseUrl)
      : undefined
  return (
    <div className='grid gap-0.5 text-xs whitespace-normal text-muted-foreground'>
      <span>{modelLine(upstream)}</span>
      {plugin ? quotaLine(upstream, plugin) : null}
      {refresh ? (
        <span className={refresh.ok ? undefined : 'text-destructive'}>
          刷新：{refresh.message}
        </span>
      ) : null}
    </div>
  )
}

/**
 * 模型目录：几个模型，外加上次拉取的时刻。
 *
 * 目录与时刻都是服务端给的（Upstream 上的那两格）。开放平台的目录一律从上游
 * 拉，所以不说来源。时刻是 0 的时候说「没拉过」—— 别显示 0，也别显示 1970
 * （那是 Unix 纪元，不是「没拉过」）。
 */
function modelLine(upstream: Upstream): string {
  const at =
    upstream.modelsFetchedAtMs > 0n
      ? formatLocalMoment(upstream.modelsFetchedAtMs)
      : '没拉过'
  return `模型目录：${upstream.models.length} 个模型 · 上次拉取：${at}`
}

/**
 * 额度那一栏。
 *
 * 先说结论，再说数字 —— 两样不会同时有（契约里只有 `ok` 带数字）：
 *
 *   `ok`                数字那几行
 *   `no_quota`          额度用尽（有恢复时刻就说什么时候恢复）
 *   `blocked`           平台说这个账号不能用 + 恢复时刻
 *   `unauthorized`      凭据被拒
 *   `rate_limited`      被限流 + 恢复时刻
 *   `missing`           还没填凭据
 *   `unknown`           未知
 *   其余值（服务端新加的） 原样显示
 *   空串（没有结论）     整栏不显示
 *
 * 结论只看 `quotaState`。数字那几行带插件名：能走到这一栏说明插件已经匹配到
 * 了，名字直接用它。
 */
function quotaLine(upstream: Upstream, plugin: QuotaPlugin) {
  const quota = upstream.quota
  if (!quota) return null

  const state = quotaStateText(quota)
  if (state) {
    return (
      <div className='grid gap-0.5'>
        <span>{state}</span>
        {/* 插件那句话放第二行：状态名在上面，不会因为这句话为空就变成猜。 */}
        {quota.message ? <span>{quota.message}</span> : null}
      </div>
    )
  }
  // 没有结论也没有数字：这一份答复对额度什么都没说。
  if (!hasQuota(quota)) return null
  return (
    <div className='grid gap-0.5'>
      <span>额度：{plugin.label}</span>
      <QuotaSummary quota={quota} align='start' />
    </div>
  )
}
