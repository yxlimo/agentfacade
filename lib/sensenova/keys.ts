// lib/sensenova/keys.ts — 账号的 API key。
//
// 控制台里有两种 key，各走各的接口：
//
//   订阅模式（积分池）   {platform}/lite/console/v1/metered/api-keys
//                        body 里的 key_type = API_KEY_TYPE_TOKEN_PLAN
//   按量计费             同一个接口
//                        body 里的 key_type = API_KEY_TYPE_METERED
//
// key_type 就是「用哪一类的额度」：TOKEN_PLAN 走积分池（分池、分窗口），
// METERED 走按量计费（按调用量算钱）。这是唯一能指定的地方——池子本身不
// 在 key 上选，池子由「调哪个模型」决定：Flash-Lite 系列先扣专属池，
// 其余模型只扣通用池。详见 lib/sensenova/quota.ts。
//
// key_type 省略时，平台按控制台默认给（我们这边显式写死，免得平台改默认）。
//
// 完整的 key 只在创建的那一次回答里出现（api_key_plain），列表里永远是
// 掩码。所以账号要用的那把 key 由用户自己在面板上填， 网关不替人建：建出来
// 的那把用户既不知道也换不掉。

import { consoleApi } from "./platform.ts";
import type { SenseNovaSession } from "./auth.ts";

/** key 的两种计费类型。 */
export type SenseNovaKeyType = "API_KEY_TYPE_TOKEN_PLAN" | "API_KEY_TYPE_METERED";

/** 订阅模式：走积分池。 */
export const KEY_TYPE_TOKEN_PLAN: SenseNovaKeyType = "API_KEY_TYPE_TOKEN_PLAN";

/** 按量计费：按调用量算钱。 */
export const KEY_TYPE_METERED: SenseNovaKeyType = "API_KEY_TYPE_METERED";

/** 一个 key。 */
export interface SenseNovaApiKey {
  id: string;
  /** 人起的名字。 */
  displayname: string;
  /** 计费类型。 */
  keyType: string;
  /** 掩码后的 key（列表里就是这个）。 */
  maskedKey: string;
  /** 完整的 key：只有创建的时候才有。 */
  plainKey?: string;
  createTime: string | null;
  status: string;
  isDefault: boolean;
}

/** 把接口返回的一行读成 key。 */
export function parseApiKeyRow(row: any): SenseNovaApiKey {
  const key = String(row?.api_key ?? "");
  return {
    id: String(row?.id ?? ""),
    displayname: String(row?.displayname ?? ""),
    keyType: String(row?.key_type ?? ""),
    // 短 key 不掩码——掩了就没法认了。
    maskedKey: key.length > 8 ? `${key.slice(0, 3)}••••${key.slice(-4)}` : key,
    plainKey: row?.api_key_plain ? String(row.api_key_plain) : undefined,
    createTime: row?.create_time ?? null,
    status: String(row?.status ?? ""),
    isDefault: row?.is_default === true,
  };
}

/**
 * 账号现有的 key。
 *
 * 面板还没做 key 管理：这一族接口是前瞻代码，现在只有网关自己与探针在用。
 */
export async function listApiKeys(session: SenseNovaSession, pageSize = 20): Promise<SenseNovaApiKey[]> {
  const data = await consoleApi<any>("/console/v1/metered/api-keys", session, {
    query: { page_size: pageSize },
  });
  const rows = Array.isArray(data?.api_keys) ? data.api_keys : [];
  return rows.map(parseApiKeyRow);
}

/**
 * 建一个 key。
 *
 * 完整的 key 在回答里的 api_key_plain，列表里以后只有掩码，所以拿到的
 * 时候要马上存。
 */
export async function createApiKey(
  session: SenseNovaSession,
  name: string,
  keyType: SenseNovaKeyType = KEY_TYPE_TOKEN_PLAN,
): Promise<SenseNovaApiKey> {
  const data = await consoleApi<any>("/console/v1/metered/api-keys", session, {
    method: "POST",
    body: { displayname: name, key_type: keyType },
  });
  const row = data?.api_key ?? data;
  const key = parseApiKeyRow({ ...row, api_key_plain: data?.api_key_plain });
  return key;
}

/** 注销一个 key。 */
export async function revokeApiKey(session: SenseNovaSession, id: string): Promise<void> {
  await consoleApi<any>(`/console/v1/metered/api-keys/${encodeURIComponent(id)}`, session, {
    method: "DELETE",
  });
}
