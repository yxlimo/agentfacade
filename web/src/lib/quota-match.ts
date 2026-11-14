import type { QuotaPlugin } from '@/gen/buddy/admin/v1/admin_pb'

/**
 * 平台地址 → 额度插件 的匹配。
 *
 * 插件在服务端登记时声明自己服务哪些地址（QuotaPlugin.baseUrls），平台行按
 * base_url 对上其中一个，它的额度插件就是那一个。对不上任何插件的平台就是
 * 没有额度接口：不显示额度区、不报错、不提示。
 *
 * 规则与后端一致（lib/quota-plugin-registry.ts 的 sameQuotaBase）：走 URL
 * 解析，比 origin 与 pathname，大小写、默认端口、尾部斜杠由标准库归一。
 */

/** 两个地址是不是「同一台同一段」。 */
export function sameQuotaBase(a: string, b: string): boolean {
  try {
    const norm = (u: URL): string =>
      u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname
    const left = new URL(a)
    const right = new URL(b)
    return left.origin === right.origin && norm(left) === norm(right)
  } catch {
    // 不是完整网址：认不出「同一台」，只好按原文比。
    return a === b
  }
}

/** 这串地址的额度插件；对不上任何一家就是 null（不是错误）。 */
export function quotaPluginForBaseUrl(
  plugins: QuotaPlugin[],
  baseUrl: string
): QuotaPlugin | null {
  const base = String(baseUrl ?? '').trim()
  if (!base) return null
  for (const plugin of plugins) {
    if (plugin.baseUrls.some((served) => sameQuotaBase(base, served))) {
      return plugin
    }
  }
  return null
}
