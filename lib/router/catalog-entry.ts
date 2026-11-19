// lib/router/catalog-entry.ts — 一条目录条目长什么样（两种形状）。
//
// 形状的规则都在这里：哪些字段发、哪些不发、为什么。目录本身在
// lib/router/catalog.ts —— 那里决定「有哪些模型」，这里决定「一条模型在答复
// 里长什么样」。
//
// 一条贯穿的规矩：**不知道就不发**。缺键的意思是「谁也没说」；发 0、发
// false、发空数组都会被客户端读成「没有上限 / 不支持 / 什么都不是」—— 那
// 是我们替上游做的结论，而结论只有上游能下。

import type { ModelBilling } from "../catalog-billing.ts";
import type { CatalogModel } from "../catalog-models.ts";
import { openPlatformOf } from "../open-platforms.ts";

/** The two shapes the model list is served in. */
export type CatalogDialect = "openai" | "anthropic";

/** What we know about one model, in the fields the shapes carry. */
export interface ModelFacts {
  reasoning?: boolean;
  toolCall?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  effortOptions?: string[];
  modalities?: { input?: string[]; output?: string[] };
  billing?: ModelBilling;
}

/** The facts of a catalogue entry. */
export function factsOf(model: CatalogModel): ModelFacts {
  return {
    reasoning: model.reasoning,
    toolCall: model.toolCall,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    effortOptions: model.effortOptions,
    modalities: model.modalities,
    billing: model.billing,
  };
}

/**
 * The moment a model's catalogue was fetched, in epoch seconds.
 *
 * `created` / `created_at` have to be stable: clients cache a model list by
 * them, and a value that changes on every request says "published just now"
 * every time. The honest moment is when the platform's catalogue was fetched;
 * when there is none (a code catalogue, a platform that was never fetched) the
 * process start is used. Never `Date.now()` — that would make the same
 * catalogue look brand new on every call.
 */
export function createdOf(platformId: string): number {
  let fetchedAt = 0;
  try {
    fetchedAt = openPlatformOf(platformId)?.models.fetchedAt ?? 0;
  } catch {
    // 库读不出来时也要给得出一个答复：目录的时刻读不到就退到进程启动时刻，
    // 不能因为一个时间戳把整个目录弄成 500。
    fetchedAt = 0;
  }
  return fetchedAt > 0 ? Math.floor(fetchedAt / 1000) : PROCESS_START;
}

/** The process start, in epoch seconds: the fallback for "when was this published". */
const PROCESS_START = Math.floor(Date.now() / 1000);

/** One platform's moment, asked once per answer. */
export function createdMemo(): (platformId: string) => number {
  const cache = new Map<string, number>();
  return (platformId: string) => {
    const known = cache.get(platformId);
    if (known !== undefined) return known;
    const created = createdOf(platformId);
    cache.set(platformId, created);
    return created;
  };
}

/**
 * The price, in opencode-go's shape.
 *
 * Our prices are already per million USD — the same unit as its `price` — so
 * nothing is scaled here. The multipliers are left out on purpose: we kept the
 * factor but dropped the `when` window it applies to, and a factor without its
 * window would claim "always", which is a lie.
 */
function costOf(billing: ModelBilling | undefined): Record<string, unknown> | undefined {
  if (!billing || billing.mode !== "token" || billing.unknown) return undefined;
  const input = billing.inputPerMillion;
  const output = billing.outputPerMillion;
  const cacheRead = billing.cacheReadPerMillion;
  if (input === undefined && output === undefined) return undefined;
  const inputSide: Record<string, unknown> = {
    ...(input !== undefined ? { price: input } : {}),
    ...(cacheRead !== undefined ? { cache: { read: cacheRead } } : {}),
  };
  return {
    text: {
      // 空的那一侧整个不出现：只报了输出价的时候，输入那一侧不是「免费」。
      ...(Object.keys(inputSide).length ? { input: inputSide } : {}),
      ...(output !== undefined ? { output: { price: output } } : {}),
    },
  };
}

/**
 * One entry in the OpenAI shape, with the fields opencode-go's catalogue has.
 *
 * Every extra field is only there when we know it. A `0`, a `false` or an
 * empty array would be read as "no limit", "cannot call tools", "no modality" —
 * claims we cannot make. A missing key means "nobody said".
 */
export function openAIEntry(
  id: string,
  name: string,
  ownedBy: string,
  created: number,
  facts: ModelFacts,
): Record<string, unknown> {
  const limit: Record<string, number> = {};
  // 0 不发：窗口与输出上限是「多少」，0 不是「多少」—— 与 Anthropic 形状的
  // 平铺字段同一个口径（那里也是 0 不发）。
  if (facts.contextWindow) limit.context = facts.contextWindow;
  if (facts.maxOutputTokens) limit.output = facts.maxOutputTokens;
  const capabilities: Record<string, unknown> = {};
  if (facts.toolCall !== undefined) capabilities.tools = { supported: facts.toolCall };
  if (facts.reasoning !== undefined) {
    capabilities.reasoning = {
      supported: facts.reasoning,
      ...(facts.effortOptions ? { effort: [...facts.effortOptions] } : {}),
    };
  }
  const cost = costOf(facts.billing);
  return {
    id,
    object: "model",
    created,
    owned_by: ownedBy,
    name,
    ...(Object.keys(limit).length ? { limit } : {}),
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
    ...(facts.modalities ? { modalities: facts.modalities } : {}),
    ...(cost ? { cost } : {}),
  };
}

/**
 * One entry in the Anthropic shape.
 *
 * `created_at` is an RFC 3339 date-time **string** there (the Go SDK types it
 * as `time.Time`), not an epoch number.
 *
 * `capabilities` is `ModelCapabilities | null` in the Anthropic spec, and every
 * key inside it is required. We know only a part of them, so we send `null`:
 * a half-filled object fails a typed client's validation, and
 * `{supported: false}` would say "does not support" where we only mean "we do
 * not know". What we do know stays in the flat fields below — a client ignores
 * the fields the spec does not have, so they cost nothing.
 */
export interface AnthropicEntry {
  id: string;
  type: "model";
  display_name: string;
  created_at: string;
  reasoning?: boolean;
  tool_call?: boolean;
  context_window?: number;
  max_output_tokens?: number;
  effort_options?: string[];
  capabilities: null;
  backend?: string;
}

export function anthropicEntry(
  id: string,
  name: string,
  created: number,
  facts: ModelFacts,
): AnthropicEntry {
  return {
    id,
    type: "model",
    display_name: name,
    created_at: new Date(created * 1000).toISOString(),
    reasoning: facts.reasoning,
    tool_call: facts.toolCall,
    ...(facts.contextWindow ? { context_window: facts.contextWindow } : {}),
    ...(facts.maxOutputTokens ? { max_output_tokens: facts.maxOutputTokens } : {}),
    ...(facts.effortOptions ? { effort_options: [...facts.effortOptions] } : {}),
    capabilities: null,
  };
}
