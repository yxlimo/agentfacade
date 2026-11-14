// lib/qiniu/account.ts — 七牛云账号的凭据。
//
// 一个账号上有两段凭据，各管各的，各自有自己的位置：
//
//   推理 key     key:provider:<账号>:key       开放平台那把推理 key（lib/open-platform-credentials.ts）
//   门户 cookie  key:provider:<账号>:account   额度插件要的那一段（lib/quota-plugin-credentials.ts）
//
// 两者不能互换：用 key 去问门户问不出额度，用 cookie 去推理也不行。
// 所以额度读不到不是错误 —— 推理照走，额度是「不知道」。
//
// 两段的位置都不是这里定的：推理 key 那一段是开放平台通用的（面板上写凭据的
// 那条路写的就是它），门户 cookie 那一段是额度插件声明的字段名。这个文件只
// 负责把门户 cookie 那一段读出来 —— 推理 key 那把不归七牛管。

import { providerSecretId } from "../credential-ids.ts";
import { pluginFieldOf } from "../quota-plugin-credentials.ts";

/**
 * 账号凭据在库里的那一段（id 的后缀）。
 *
 * 额度插件要的那一段凭据说的就是它（lib/quota-plugin-credentials.ts）：插件字段的
 * name 就是这个后缀 —— 名字只有这一个来源，两处各写一份就会读不到。
 */
export const QINIU_ACCOUNT_FIELD = "account";

/** 这个账号的凭据在数据库里的 id。 */
export function qiniuAccountId(providerId: string): string {
  return providerSecretId(providerId, QINIU_ACCOUNT_FIELD);
}

/** 这个账号的门户 cookie。没有就空字符串。 */
export function qiniuPortalCookie(providerId: string): string {
  return pluginFieldOf(providerId, QINIU_ACCOUNT_FIELD);
}
