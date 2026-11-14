// lib/quota-plugin-registry.ts — 额度插件登记表的那张 map。
//
// 单独成叶是有原因的：插件模块在自己的求值期就登记（import 即登记），而
// lib/quota-plugins.ts 作为集中登记点反过来 import 各家插件 —— 这是一张环。
// 环里谁先求值不一定，`const PLUGINS = new Map()` 若住在这张环上，先到的登记
// 就会撞上 TDZ（实测如此）。map 与登记函数没有任何依赖，放在环外最浅处，谁先
// 谁后都拿得到。
//
// 这个文件不做别的：登记表只有一张 map 与三个函数。读「这个平台怎么问额度」
// 的其余部分在 lib/quota-plugins.ts。

import type { QuotaState } from "./quota-state.ts";
import type { QuotaView } from "./provider-kinds.ts";
import type { ProviderRow } from "./providers.ts";

/** 面板按它渲染的一个输入框。 */
export interface QuotaField {
  /** 凭据里的那一段叫什么。 */
  name: string;
  /** 面板上给人看的名字。 */
  label: string;
  /** 面板上要遮起来显示。 */
  secret: boolean;
}

/** 插件问一次上游的结果。 */
export interface QuotaProbe {
  state: QuotaState;
  /** 面板上显示的那几行（余额/积分/套餐）。没有就是空数组。 */
  views: QuotaView[];
  /** 什么时候恢复（毫秒）；不知道就是 null。 */
  recoverAt: number | null;
  /** 给人看的一句话（日志与面板提示）。不要放凭据。 */
  message: string;
}

/**
 * 一个额度插件：问一次上游，把答复或异常翻成一个结论。
 *
 * 插件只做翻译：上游说了什么（见底了、账号停用了、凭据被拒、限流了），或者什么
 * 也没说出来（网络、解析）。结论怎么处理由平台统一做，插件不判「能不能接」。
 */
export interface QuotaPlugin {
  /** 插件 id：快照桶的键（plugins[<id>][<账号>]）。 */
  id: string;
  /**
   * 这个插件服务哪些平台地址（一个插件可以认多家）。
   *
   * 填的是各平台**推理**的规范地址：平台行按 base_url 对上这里的一个，它的额度
   * 插件就是这一个 —— 用户不选，也没有「没选」这一说。对不上任何插件的平台
   * 就是没有额度接口：不显示额度区、不报错。
   *
   * 两个插件声明同一个地址是代码错误：登记时直接抛（见 registerQuotaPlugin），
   * 否则「用的是哪一个」就没有答案。
   */
  baseUrls: readonly string[];
  /** 面板上给人看的名字。 */
  label: string;
  /** 查额度要哪些凭据。 */
  fields: QuotaField[];
  /** 去问一次，把答复或异常翻成状态。不许 reject：翻不动的都归到 unknown。 */
  probe(account: ProviderRow): Promise<QuotaProbe>;
}

/**
 * 两个地址是不是「同一台同一段」。
 *
 * 走 URL 解析，比解析后的 origin 与 pathname：大小写、默认端口、尾部斜杠这些
 * 差异由标准库归一。地址写进库里的时候已经去过尾部斜杠
 * （lib/open-platforms.ts 的 normalizeBaseUrl），这边再兜一层。
 */
export function sameQuotaBase(a: string, b: string): boolean {
  try {
    const norm = (u: URL): string => (u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname);
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && norm(left) === norm(right);
  } catch {
    // 不是完整网址：认不出「同一台」，只好按原文比。
    return a === b;
  }
}

const PLUGINS = new Map<string, QuotaPlugin>();

/**
 * 登记一个插件。
 *
 * 同一个 id 注册两次直接抛：那是代码写错了，不是运行时的状况。两个插件抢一个
 * id，「用的是哪一个」就没答案了，面板上会把一个平台的数字挂在另一个平台名下。
 */
export function registerQuotaPlugin(plugin: QuotaPlugin): QuotaPlugin {
  if (PLUGINS.has(plugin.id)) {
    throw new Error(`额度插件 ${plugin.id} 注册了两次`);
  }
  for (const base of plugin.baseUrls) {
    const owner = quotaPluginForBaseUrl(base);
    if (owner && owner.id !== plugin.id) {
      // 两个插件抢一个地址，「用的是哪一个」就没答案了：登记期就吵出来，
      // 别等到面板把一个平台的数字挂在另一个平台名下。
      throw new Error(`额度插件 ${plugin.id} 与 ${owner.id} 都声明了地址 ${base}`);
    }
  }
  PLUGINS.set(plugin.id, plugin);
  return plugin;
}

/** 这个 id 的插件；没登记就是 null。 */
export function quotaPluginOf(id: string): QuotaPlugin | null {
  return PLUGINS.get(id) ?? null;
}

/** 登记过的全部插件。 */
export function allQuotaPlugins(): QuotaPlugin[] {
  return [...PLUGINS.values()];
}

/**
 * 这个平台地址的额度插件；对不上任何一家就是 null —— 那是「没有额度接口」，
 * 不是「没配好」。调用方对 null 什么都不做：不显示额度、不报错、不提示。
 *
 * 匹配是数据的事（地址对地址），所以住在叶上：谁都在求值期许引它，它不许
 * 引 store/router —— 引用即登记的环已经踩过一次。
 */
export function quotaPluginForBaseUrl(baseUrl: string): QuotaPlugin | null {
  const base = String(baseUrl ?? "").trim();
  if (!base) return null;
  for (const plugin of PLUGINS.values()) {
    if (plugin.baseUrls.some((served) => sameQuotaBase(base, served))) return plugin;
  }
  return null;
}

/**
 * 「这个平台没有额度接口」的声明。
 *
 * 理由留着：「这个平台没有额度」与「还没顾上搬」是两回事，只有前者是决定。
 */
const NO_PLUGINS = new Map<string, string>();

/**
 * 显式声明这个平台没有额度接口。
 *
 * 不声明的话，启动校验分不出「没搬」与「没人问」—— 沉默的平台看着像漏了。
 */
export function declareNoQuotaPlugin(id: string, reason: string): void {
  NO_PLUGINS.set(id, reason);
}

/** 这个平台为什么没有额度插件；没声明过就是 null。 */
export function noQuotaPluginReason(id: string): string | null {
  return NO_PLUGINS.get(id) ?? null;
}
