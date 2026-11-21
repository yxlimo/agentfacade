// lib/admin/platform-header-injection.ts — 开放平台转发头的注入点。
//
// 客户端头按 deny-list 透传之后（clientForwardHeaders），把平台自己配的头模板盖上
// 去。只有开放平台会走到这里：模拟端（qoder/workbuddy/minimax/zcode）的请求是照
// 客户端指纹重建的，它们不读 forwardedHeaders，也不读这里的任何东西。
//
// 会话标识只从 lib/session-id.ts 的 extractSessionKey 取（它走 SESSION_HEADER 设置），
// 这里不写第二套提取逻辑。取不到时整个请求在上游往返之前被打回，绝不带着一个没
// 展开的 {session-id} 去问上游。

import { clientForwardHeaders, type HeaderBag } from "../agent.ts";
import type { Json } from "../json.ts";
import { log } from "../log.ts";
import { openPlatformOf } from "../open-platforms.ts";
import { extractSessionKey } from "../session-id.ts";
import {
  missingSessionMessage,
  renderHeaderTemplates,
  usesSession,
  type HeaderTemplate,
} from "./platform-headers.ts";

/** 注入结果：成功带回可以发给上游的头；失败带回给客户端的中文正文。 */
export type HeaderInjection =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; message: string };

/**
 * 把平台的头模板盖到客户端透传头上。
 *
 * 顺序：先用 deny-list 透传客户端头（同名头以小写归一），再按模板顺序覆盖/新增。
 * 模板没配的那条同名头保持现状 —— 继续透传客户端原来那个值。
 *
 * 有模板值带 {session-id} 时才取会话。取不到就整请求失败：这是配置或调用方的问题，
 * 不是上游的问题，在上游往返之前返回，也不记用量。
 *
 * 日志只记平台 id、头名、source，不记会话标识的值（那是客户端的会话身份）。
 */
export function resolveForwardedHeaders(
  platformId: string,
  platformLabel: string,
  requestHeaders: HeaderBag,
  body: Json,
): HeaderInjection {
  const forwarded = clientForwardHeaders(requestHeaders);
  const templates: HeaderTemplate[] = openPlatformOf(platformId)?.headers ?? [];
  if (!templates.length) return { ok: true, headers: forwarded };

  // 先在渲染之前把会话取到，取不到一次就打回，不用逐条试。
  const needed = templates.find(usesSession);
  let sessionId: string | null = null;
  if (needed) {
    const found = extractSessionKey(requestHeaders, body);
    if (!found) {
      log.info(
        `[PLATFORM-HEADERS] 平台 ${platformId} 的头 ${needed.name} 需要会话标识，取不到，返回 400`,
      );
      return { ok: false, message: missingSessionMessage(platformLabel, needed.name) };
    }
    sessionId = found.id;
    log.info(`[PLATFORM-HEADERS] 平台 ${platformId} 的头 ${needed.name} source=${found.source}`);
  }

  // 渲染后的模板覆盖同名透传头；没有占位符的常量头也走这条路。
  for (const item of renderHeaderTemplates(templates, sessionId)) {
    forwarded[item.name.toLowerCase()] = item.value;
  }
  return { ok: true, headers: forwarded };
}
