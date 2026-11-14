// lib/quota-plugins.ts — 「这个平台的额度怎么问」的插件注册表。
//
// 额度这件事一直散在两处：抓取在 lib/admin/upstreams.ts 的
// refreshHealthSnapshot() 里按平台写死一长串 if，读成面板视图在各
// lib/kinds/*.ts 的 quotas() 里。开放平台（用户在面板上加的那些平台）进不了这条
// 链 —— 它是数据，不是代码。
//
// 做成插件之后，插件只回答一件事：问一次上游，把答复或异常翻成一个结论
// （probe）。结论怎么处理（写冷却、算不算见底、什么时候恢复）是平台的事，写在
// lib/quota-state.ts 一处 —— 插件里再各写一遍，就会有七份不一样的判断。
// 开放平台按行上的地址认插件（lib/quota-plugin-registry.ts 的 quotaPluginForBaseUrl）。
//
// 插件的登记是模块求值期的副作用，集中在这里：本模块 import 各家的插件文件，
// 求值期登记就发生了。谁要用插件（面板、路由）import 本模块一处就够
// —— 之前是「各平台模块自己 import 自己的」，那批模块随厂商 kind 退场删掉之后
// 没人 import 插件了，登记表空着，开放平台挑不到插件，额度全变「不知道」。

// 登记表本身住在叶上（lib/quota-plugin-registry.ts）：插件文件求值期就登记，
// 而它们又在本模块的 import 表里 —— 环上的 const map 会撞 TDZ。
// 本模块是登记 hub：只做一件事 —— 引各家插件文件（引用即登记）。
// 登记表、类型与「没额度」的声明住在叶上
// （lib/quota-plugin-registry.ts，零依赖）：
//
//   * 谁只想读登记表，引叶；谁要触发登记（测试），引本模块。
//   * 纪律：在 open-platforms 的依赖子树里求值的模块（quota-state → admin/*
//     那一片）不许引本模块 —— 本模块引 open-platforms，从那边引回来会在
//     open-platforms 求值中途把整个应用图拉进来，它顶部的常量还没初始化
//     （TDZ，实测撞过两次）。

import {
  allQuotaPlugins,
  declareNoQuotaPlugin,
  noQuotaPluginReason,
  registerQuotaPlugin,
  quotaPluginForBaseUrl,
  quotaPluginOf,
  type QuotaField,
  type QuotaPlugin,
  type QuotaProbe,
} from "./quota-plugin-registry.ts";
// 引用即登记：四家在用的插件都在这一处进门。新增插件也加在这里 —— 别处 import
// 插件文件等于把「哪些插件登记了」这份知识散出去。
import "./qiniu/quota-plugin.ts";
import "./sensenova/quota-plugin.ts";
import "./intern-ai/quota-plugin.ts";
import "./tokenrhythm/quota-plugin.ts";

export {
  allQuotaPlugins,
  declareNoQuotaPlugin,
  noQuotaPluginReason,
  quotaPluginForBaseUrl,
  registerQuotaPlugin,
  quotaPluginOf,
  type QuotaField,
  type QuotaPlugin,
  type QuotaProbe,
};

/**
 * 已经报过「这个平台的额度插件没登记」的那些。
 *
 * 一个平台的这个插件说一次：这句话是配置错误，不该跟着启动的次数刷屏，也
 * 不能把真正的故障淹掉。
 */
const warnedUnknownPlugins = new Set<string>();

