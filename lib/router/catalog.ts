// lib/router/catalog.ts — the model lists.
//
// The clients ask for the list in two shapes: the OpenAI one (the default) and
// the Anthropic one, which pi reads. Both are rendered from the same models,
// so a model never shows up in one shape and not in the other.
//
// The list is per upstream: the plain `/v1/models` answers with everything and
// the prefixed form (`/qoder-cn/v1/models`) with one upstream, and the model
// ids are the real ones there — the path already says where the model lives.

import type { AggregateModel } from "../aggregate.ts";
import type { CatalogModel } from "../catalog-models.ts";
import type { ModelBilling } from "../catalog-billing.ts";
import { allPlatforms } from "../platforms.ts";
import { kindOf } from "../provider-kinds.ts";
import { platformAvailabilities, type PlatformAvailability } from "./availability.ts";
import {
  anthropicEntry,
  createdMemo,
  factsOf,
  openAIEntry,
  type CatalogDialect,
} from "./catalog-entry.ts";
import "../kinds/index.ts";

export { createdOf, type CatalogDialect } from "./catalog-entry.ts";

export type { CatalogModel };
export {
  internAiCatalogModels,
  minimaxCatalogModels,
  qoderCatalogModels,
  senseNovaCatalogModels,
  workbuddyCatalogModels,
  zcodeCatalogModels,
} from "../catalog-models.ts";

/**
 * A group is an upstream: one row of the provider table.
 *
 * The prefix the server puts in front of a model id is the upstream's id, so
 * two services of the same platform do not collide.
 */
export type UpstreamGroup = string;

/** One upstream's models. */
export interface CatalogGroup {
  group: UpstreamGroup;
  models: CatalogModel[];
}

/**
 * 每个平台的模型目录。
 *
 * A group is a platform, not an account: the path names the platform, and two
 * accounts of the same platform serve the same models. The catalogue itself is
 * the kind's (a platform's models do not depend on who is logged in), so the
 * first account of the platform is asked for it — an account row is what the
 * kind's `models()` takes.
 *
 * A platform with no usable account serves nothing: a request for one of its
 * models is refused, and listing them would say otherwise. 「可用」是开着**而且**
 * 有可用凭据的账号 —— 额度用尽与冷却不摘模型（那是「现在接不了这个请求」，
 * 不是「没有这个模型」）。
 *
 * availabilities 是这一轮算好的可用性：同一个请求里算过一次就传下来，别再读
 * 一遍那几张表。不给就自己算。
 */
export function platformGroups(availabilities?: Map<string, PlatformAvailability>): CatalogGroup[] {
  // allPlatforms() 每次调用读一次 platform 表（开放平台在那张表里）。
  const map = availabilities ?? platformAvailabilities(allPlatforms());
  const groups: CatalogGroup[] = [];
  for (const [group, availability] of map) {
    const kind = kindOf(availability.kind);
    if (!kind) continue;
    // 没有可用账号的平台不进 group。
    if (!availability.serving.length) continue;
    const models = [...availability.catalog];
    if (!models.length) continue;
    groups.push({ group, models });
  }
  return groups;
}

export function groupCatalog(group: UpstreamGroup, groups: CatalogGroup[], dialect: CatalogDialect): any {
  const found = groups.find((g) => g.group === group);
  const models = found?.models ?? [];
  const createdFor = createdMemo();
  const created = createdFor(group);
  if (dialect === "openai") {
    return {
      object: "list",
      data: models.map((m) => openAIEntry(m.id, m.displayName, group, created, factsOf(m))),
    };
  }
  const data = models.map((m) => {
    const entry = anthropicEntry(m.id, m.displayName, created, factsOf(m));
    return m.backend ? { ...entry, backend: m.backend } : entry;
  });
  return {
    data,
    has_more: false,
    first_id: data.length ? data[0].id : null,
    last_id: data.length ? data[data.length - 1].id : null,
  };
}

export interface AggregateTargetSpec {
  group: UpstreamGroup;
  upstreamModel: string;
  enabled: boolean;
  /**
   * How much of the traffic this target takes.
   *
   * It also decides the order: the bigger the weight, the earlier the target
   * is tried.
   */
  weight: number;
}

/** One model the root route publishes. */
export interface AggregateEntry {
  /** The id the agents use. */
  id: string;
  displayName: string;
  reasoning: boolean;
  toolCall: boolean;
  contextWindow?: number;
  /** 平台没报输出上限的时候没有这个数。 */
  maxOutputTokens?: number;
  effortOptions?: string[];
  /** 平台报的价格（上游自己的那份）。没有就是不知道，不是免费。 */
  billing?: ModelBilling;
  /** 平台报的模态。只带上游报了的那一侧。 */
  modalities?: { input?: string[]; output?: string[] };
  strategy: "single" | "fallback";
  targets: AggregateTargetSpec[];
}
/**
 * 目录里找那个模型。
 *
 * 名字不认大小写：MiniMax 的模型 id 是 "MiniMax-M3.1-Flash"，人写的是
 * "Minmax-M3.1-Flash"，两个是同一个东西。认不出就当没有 —— 那样模型不会
 * 被公布，客户端连不上，而没人知道为什么。
 */
function findModel(groups: CatalogGroup[], group: UpstreamGroup, id: string): CatalogModel | null {
  const entry = groups.find((g) => g.group === group);
  if (!entry) return null;
  const wanted = id.trim().toLowerCase();
  return (
    entry.models.find((m) => m.id === id) ??
    entry.models.find((m) => m.id.toLowerCase() === wanted) ??
    null
  );
}

/**
 * The thinking tiers a published model advertises.
 *
 * `reasoning: false` means the model does not think, or has no tier to pick: it
 * has no tiers at all, so publishing none is the honest answer. Publishing
 * `["off"]` there would claim the opposite of what the switch says — that it has
 * a thinking knob one can turn off.
 *
 * Every model that can think gets `off` for free, in front. `off` is the
 * shallowest tier, not a boolean, and the clients read the selectable levels out
 * of this list: pi keeps `off` in its own `THINKING_LEVEL_OPTIONS`, opencode
 * names its variants after what we publish. A list without `off` therefore takes
 * "think less" away from the caller — magic-context's local configuration can
 * only choose a level that was published. The column is user-written tiers and
 * the targets' common tiers are inherited ones; `off` is neither, it comes with
 * being able to think.
 *
 * Only the published value is overridden: the column keeps its tiers, so the
 * list is still there if reasoning is switched off and back on.
 *
 * `reasoning` NULL is not "off": NULL is "nobody said", and "not known to be
 * incapable" is not "incapable", so it is treated like `true`.
 */
function publishedEfforts(model: AggregateModel, commonEfforts: string[] | undefined): string[] | undefined {
  if (model.reasoning === false) return undefined;
  const tiers = model.effortOptions ?? (commonEfforts?.length ? commonEfforts : undefined) ?? [];
  // `off` first, and only once: the column may already carry it in the middle
  // of the list, where a client reading the levels in order would not see it as
  // the default.
  return ["off", ...tiers.filter((tier) => tier !== "off")];
}

/**
 * The models the root route publishes.
 *
 * The database is the catalog: the panel decides which models exist, what they
 * are called, and which upstream serves them. With nothing in the database
 * there is nothing to publish.
 *
 * The metadata of a published model comes from its targets, and where the
 * targets disagree the smallest value wins — the model can only promise what
 * every one of them can do.
 */
export function aggregateCatalog(groups: CatalogGroup[], configured: AggregateModel[]): AggregateEntry[] {
  const live = configured.filter((m) => m.enabled);
  const entries: AggregateEntry[] = [];
  for (const model of live) {
    const targets: AggregateTargetSpec[] = [];
    const found: CatalogModel[] = [];
    for (const target of model.targets) {
      if (!target.enabled) continue;
      const upstream = findModel(groups, target.group, target.upstreamModel);
      if (!upstream) continue; // The upstream no longer lists it.
      targets.push({
        group: target.group,
        upstreamModel: target.upstreamModel,
        enabled: true,
        weight: target.weight,
      });
      found.push(upstream);
    }
    if (targets.length === 0) continue;

    const contexts = found.map((m) => m.contextWindow).filter((v): v is number => typeof v === "number");
    const outputs = found.map((m) => m.maxOutputTokens).filter((v): v is number => typeof v === "number");
    const efforts = found
      .map((m) => m.effortOptions)
      .filter((v): v is string[] => Array.isArray(v));
    const commonEfforts = efforts.length
      ? efforts.reduce((a, b) => a.filter((v) => b.includes(v)))
      : undefined;

    // 价格与模态跟着目标走：第一个报了的那个说了算（目标之间不一致时，
    // 客户端看到的是一份能兑现的承诺，不是两个数里的一个）。
    const billing = found.find((m) => m.billing)?.billing;
    const modalities = found.find((m) => m.modalities)?.modalities;

    entries.push({
      id: model.id,
      displayName: model.displayName,
      reasoning: model.reasoning ?? found.some((m) => m.reasoning),
      toolCall: model.toolCall ?? found.every((m) => m.toolCall),
      contextWindow: model.contextWindow ?? (contexts.length ? Math.min(...contexts) : undefined),
      maxOutputTokens: model.maxOutputTokens ?? (outputs.length ? Math.min(...outputs) : undefined),
      effortOptions: publishedEfforts(model, commonEfforts),
      ...(billing ? { billing } : {}),
      ...(modalities ? { modalities } : {}),
      strategy: model.strategy,
      targets,
    });
  }
  return entries;
}

/**
 * The aggregate catalog in the OpenAI shape.
 *
 * The root route publishes one list, whether the models come from the
 * database or from the upstreams themselves.
 */
export function aggregateOpenAICatalog(entries: AggregateEntry[]): any {
  const createdFor = createdMemo();
  return {
    object: "list",
    data: entries.map((e) =>
      openAIEntry(
        e.id,
        e.displayName,
        e.targets[0]?.group ?? "buddy",
        createdFor(e.targets[0]?.group ?? ""),
        {
          reasoning: e.reasoning,
          toolCall: e.toolCall,
          contextWindow: e.contextWindow,
          maxOutputTokens: e.maxOutputTokens,
          effortOptions: e.effortOptions,
          modalities: e.modalities,
          billing: e.billing,
        },
      ),
    ),
  };
}

/**
 * The aggregate catalog in the Anthropic shape, with the metadata pi reads.
 */
export function aggregateAnthropicCatalog(entries: AggregateEntry[]): any {
  const createdFor = createdMemo();
  const data = entries.map((e) =>
    anthropicEntry(e.id, e.displayName, createdFor(e.targets[0]?.group ?? ""), {
      reasoning: e.reasoning,
      toolCall: e.toolCall,
      contextWindow: e.contextWindow,
      maxOutputTokens: e.maxOutputTokens,
      effortOptions: e.effortOptions,
    }),
  );
  return {
    data,
    has_more: false,
    first_id: data.length ? data[0].id : null,
    last_id: data.length ? data[data.length - 1].id : null,
  };
}
