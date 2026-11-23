// lib/admin/service/model-view.ts — 模型的人工元数据与计费，面板看的形状。
//
// 从 service.ts 上半原样搬来。读侧（面板看的 ModelOverride）与写侧（面板发来的
// 那一条按「写了的字段」读）都在这里：presence 就是「沿用上游」与「人说了算」
// 的分界，两件事不能糊成一个。

import { create } from "@bufbuild/protobuf";
import { EffortListSchema, ModelBillingSchema, ModelOverrideSchema, type ModelOverride } from "../../gen/agentfacade/admin/v1/admin_pb.ts";
// 计费的形状在 lib/catalog-billing.ts 一处定：这一层只把它摆成契约里的样子。
import type { ModelBilling } from "../../catalog-billing.ts";
import type { ModelOverrideRow } from "../../model-overrides.ts";

/** 一个模型的人工元数据，面板看的形状。 */
export function modelOverrideMessage(row: ModelOverrideRow) {
  return create(ModelOverrideSchema, {
    id: row.id,
    displayName: row.displayName,
    contextWindow: row.contextWindow,
    maxOutputTokens: row.maxOutputTokens,
    reasoning: row.reasoning,
    toolCall: row.toolCall,
    // 这一格有 presence：写了空列表 = 不能选档，这时也要回一个空的 EffortList；
    // 没写就不给这一格 —— 反过来读（空 = 没写）的话，面板把读到的原样存回来
    // 会把代码表里的档位抹掉。
    effortOptions:
      row.effortOptions === undefined ? undefined : create(EffortListSchema, { levels: [...row.effortOptions] }),
    credits: row.credits,
    // 计费那几格全是 optional：没写就要真的缺键 —— 面板靠缺/在分辨「沿用上游」
    // 与「人说不收费」，多送一个空串就把两件事糊成一个了。
    billingMode: row.billingMode,
    billingCurrency: row.billingCurrency,
    billingInputPerMillion: row.billingInputPerMillion,
    billingOutputPerMillion: row.billingOutputPerMillion,
    billingCacheReadPerMillion: row.billingCacheReadPerMillion,
    billingMultiplier: row.billingMultiplier,
  });
}

/**
 * 面板发过来的那一条，按「写了的字段」读。
 *
 * `effortOptions` 裹在 EffortList 里就是为了 presence：没给 = 没写（沿用原来的
 * 档位），给了空列表 = 明确不能选档。
 */
export function modelOverrideRow(message: ModelOverride): ModelOverrideRow {
  // 读不懂的档位当作没写（跟 readRow 里「类型不对的字段当作没写」同一条）：从解码
  // 过的请求过来时，这一格一定是个 EffortList。
  const levels = Array.isArray(message.effortOptions?.levels) ? message.effortOptions.levels : undefined;
  return {
    id: String(message.id ?? ""),
    ...(message.displayName !== undefined ? { displayName: message.displayName } : {}),
    ...(message.contextWindow !== undefined ? { contextWindow: message.contextWindow } : {}),
    ...(message.maxOutputTokens !== undefined ? { maxOutputTokens: message.maxOutputTokens } : {}),
    ...(message.reasoning !== undefined ? { reasoning: message.reasoning } : {}),
    ...(message.toolCall !== undefined ? { toolCall: message.toolCall } : {}),
    ...(levels === undefined ? {} : { effortOptions: [...levels] }),
    ...(message.credits !== undefined ? { credits: message.credits } : {}),
    ...billingOverrideRow(message),
  };
}

/**
 * 面板发过来的计费那几格。
 *
 * 只搬原文：认不得的方式与币种不在这里断言，写入那一处会拒（checkRow →
 * billingError）。没写的格就不出现 —— 契约里 presence 就是「沿用上游」与
 * 「人说不收费」的分界。
 */
function billingOverrideRow(message: ModelOverride): Partial<ModelOverrideRow> {
  const out: Partial<ModelOverrideRow> = {};
  if (message.billingMode !== undefined) {
    out.billingMode = message.billingMode as ModelOverrideRow["billingMode"];
  }
  if (message.billingCurrency !== undefined) {
    out.billingCurrency = message.billingCurrency as ModelOverrideRow["billingCurrency"];
  }
  if (message.billingInputPerMillion !== undefined) {
    out.billingInputPerMillion = message.billingInputPerMillion;
  }
  if (message.billingOutputPerMillion !== undefined) {
    out.billingOutputPerMillion = message.billingOutputPerMillion;
  }
  if (message.billingCacheReadPerMillion !== undefined) {
    out.billingCacheReadPerMillion = message.billingCacheReadPerMillion;
  }
  if (message.billingMultiplier !== undefined) out.billingMultiplier = message.billingMultiplier;
  return out;
}

/**
 * 上游报的计费 → 契约那一头的形状。
 *
 * 分时段倍率只送 factor：`when` 是个嵌套的时段表达式，面板这一格用不上，抄过去
 * 只会多一份没人读的解析。
 */
export function modelBillingMessage(billing: ModelBilling) {
  return create(ModelBillingSchema, {
    mode: billing.mode,
    // 没有币种就空串：契约里这一格是 string（没 presence），空串是「不知道」。
    currency: billing.currency ?? "",
    ...(billing.inputPerMillion === undefined ? {} : { inputPerMillion: billing.inputPerMillion }),
    ...(billing.outputPerMillion === undefined ? {} : { outputPerMillion: billing.outputPerMillion }),
    ...(billing.cacheReadPerMillion === undefined
      ? {}
      : { cacheReadPerMillion: billing.cacheReadPerMillion }),
    ...(billing.credits === undefined ? {} : { credits: billing.credits }),
    multipliers: (billing.multipliers ?? []).map((multiplier) => multiplier.factor),
    // 上游报了但不是价格（全 0 又没说币种与单位）：这是结论，不是空。
    unknown: billing.unknown === true,
    // 这一份是人写的，不是上游报的。
    overridden: billing.overridden === true,
  });
}
