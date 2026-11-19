// 网关的 /v1/models 响应 → pi 的 provider 配置。纯函数，不碰网络、不读环境变量，
// 单测直接对着录制下来的响应跑。
//
// 映射规则是这一层自己的约定：档位怎么折、缺值怎么补都写在这里，期望值写死在测试里
// （test/pi-models-plugin-check.ts 的 EXPECTED），改这里就要同步改期望值 —— 两边一起
// 动是刻意的，避免「改了映射但测试还绿」。
//
// 有几处看着像 bug，但**不许顺手改**：网关报的档位里有 "default" 时 rank 里查不到，
// 排在最后，于是 pi 的 max 会映到 "default"（见 fixtures/gateway-v1-models.json 里的
// model-02）。那是上游报出来的真实形状，改掉就与网关对不上了。

/** pi 的思考档位，从浅到深。顺序即强弱，字母序会把 high 排到 low 前面 */
export const PI_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type PiLevel = (typeof PI_LEVELS)[number];

/** 上游「四档齐全」的那一组。判定齐全那一支走固定映射 */
const FULL_EFFORTS = ["low", "medium", "high", "max"];

/** 网关没说上下文/输出上限时的兜底，与 pi_provider() 的 DEFAULT_* 一致 */
export const DEFAULT_CONTEXT = 200000;
export const DEFAULT_OUTPUT = 4096;

/**
 * 每条模型都要带的两样：pi 不会替扩展注册的 provider 补它们。
 *
 * cost 全 0：网关不报价，pi 只拿它算「花了多少钱」的统计，0 表示不计价（与
 * models.json 那一路 pi 自己补的默认值相同）。
 * compat：两项都必须下发到模型级 —— 扩展注册路径不读 provider 级的那份。
 */
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const COMPAT = { forceAdaptiveThinking: true, sendSessionAffinityHeaders: true };

/** 网关 /v1/models 的一条 data 项：字段全都可缺（老网关不发 effort_options），
 *  所以这一层一律从 unknown 收，不做类型断言。 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** pi 的一条模型定义 */
export interface PiModelEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap: Record<PiLevel, string | null>;
  /**
   * 每条模型都自带 cost 与 compat，不能只写在 provider 上。
   *
   * pi 对两条注册路做归一化的程度不一样（1.5.2，dist/core/provider-composer.js）：
   *   · models.json：`modelFromJson()` 补 cost 默认值（`definition.cost ?? {…}`），
   *     `applyModelsJson()` 再把 provider 级 compat 并进每条模型（`mergeCompat`）；
   *   · 扩展注册：`extensionModelFromDefinition()` 只是把定义展开，provider 级的
   *     cost / compat 一个都不下发。
   *
   * 缺了会怎样（都在 pi 1.5.2 上实测）：
   *   · 没有 cost → 请求在第一个 SSE 事件上抛
   *     `Cannot read properties of undefined (reading 'tiers')`（calculateCost 读 model.cost.tiers）
   *   · 没有 compat → 不发 x-session-id，网关认不出会话（`502 upstream HTTP 400 MissingSessionID`），
   *     而且 forceAdaptiveThinking 一起没了 —— 算出来的 thinkingLevelMap 整条被绕过。
   */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  compat: { forceAdaptiveThinking: boolean; sendSessionAffinityHeaders: boolean };
}

/** pi 的 provider 配置（legacy 形式；refreshModels 由 index.ts 加） */
export interface PiProviderConfig {
  name: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  /** provider 级 compat 可选：扩展注册路径不读它，只有 models.json 那一路需要 */
  compat?: { forceAdaptiveThinking: boolean; sendSessionAffinityHeaders: boolean };
  models: PiModelEntry[];
}

/** 档位按强弱排，未知档位（default / none / midium 这种）排在已知的后面 */
export function sortEfforts(efforts: readonly string[]): string[] {
  const rank = new Map<string, number>(PI_LEVELS.map((level, i) => [level, i]));
  return [...efforts].sort((a, b) => {
    const ra = rank.get(a) ?? PI_LEVELS.length;
    const rb = rank.get(b) ?? PI_LEVELS.length;
    return ra === rb ? (a < b ? -1 : a > b ? 1 : 0) : ra - rb;
  });
}

/**
 * pi 的思考档位 → 上游真有的档位。往下取，不往上取。
 *
 * 往下取的原因：档位是成本与延迟的旋钮，
 * pi 默认 medium，往上取等于把「配置里没写档位」变成「思考拉满」。
 *
 * off 是阶梯最浅的一档，不是布尔开关：
 *   - 只有 off 一档 → 每个 pi 档位都映到 off（没有别的能发）。off 那格必须是
 *     "off" 而不是 null，pi 靠 map.off !== null 才允许 thinkingEnabled: false
 *   - off 与其它档并存 → off 只映 off，其它档照常往下取，且没有思考档被映到 off
 *   - 没有 off → 关不掉思考（off 那格是 null）
 */
export function levelMap(efforts: readonly string[] | null): Record<PiLevel, string | null> {
  const all = () => blankMap(null);
  if (!efforts || efforts.length === 0) return all();
  if (efforts.includes("off")) {
    const rest = efforts.filter((e) => e !== "off");
    if (rest.length === 0) return blankMap("off");
    const mapping = levelMapWithoutOff(rest);
    mapping.off = "off";
    return mapping;
  }
  return levelMapWithoutOff(efforts);
}

function blankMap(value: string | null): Record<PiLevel, string | null> {
  const out = {} as Record<PiLevel, string | null>;
  for (const level of PI_LEVELS) out[level] = value;
  return out;
}

/** off 之外的档位怎么映。四档齐全时是一张定表（顺序与 rank 排序不同，别合并） */
function levelMapWithoutOff(efforts: readonly string[]): Record<PiLevel, string | null> {
  const sortedGiven = [...efforts].sort();
  const sortedFull = [...FULL_EFFORTS].sort();
  if (sortedGiven.length === sortedFull.length && sortedGiven.every((e, i) => e === sortedFull[i])) {
    return {
      off: null,
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "high",
      max: "max",
    };
  }

  const rank = new Map<string, number>(PI_LEVELS.map((level, i) => [level, i]));
  const ordered = sortEfforts(efforts);
  const lowest = ordered[0];
  const highest = ordered[ordered.length - 1];

  // 不高于 level 的最近一档；上游连更低的一档都没有时只能往上取最低那档
  const atOrBelow = (level: PiLevel): string => {
    const limit = rank.get(level) ?? PI_LEVELS.length;
    const below = ordered.filter((e) => (rank.get(e) ?? PI_LEVELS.length) <= limit);
    return below.length > 0 ? below[below.length - 1] : lowest;
  };

  return {
    off: null,
    minimal: lowest,
    low: lowest,
    medium: atOrBelow("medium"),
    high: atOrBelow("high"),
    xhigh: atOrBelow("xhigh"),
    max: highest,
  };
}

/**
 * 网关给的档位 + 「这个模型支不支持思考」→ 实际可用的档位。
 *
 * 网关说没有思考能力（reasoning === false）却没给档位时兜底成 ["off"]：宁可多给
 * 一档，也不要把「不知道」当成「不支持」。网关给了档位就照它给的来，不看 reasoning
 * —— 档位是更具体的信息。
 */
export function effectiveEfforts(efforts: readonly string[] | null, reasoning: boolean | null): string[] {
  if (efforts && efforts.length > 0) return [...efforts];
  if (reasoning === false) return ["off"];
  return [];
}
/** 网关那一格可能是任意 JSON：不是非空字符串数组就当「没有这一格」 */
export function normalizeEfforts(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) out.push(item);
  }
  return out.length > 0 ? out : null;
}

/** 不是布尔就当「不知道」——不能当成 false，不知道就按支持思考处理 */
export function normalizeReasoning(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/** 0 和缺失都算默认 */
function positiveIntOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n !== 0 ? Math.trunc(n) : fallback;
}

/** 一条网关模型 → 一条 pi 模型 */
export function toPiModel(raw: unknown): PiModelEntry {
  const fields = asRecord(raw);
  const id = typeof fields.id === "string" ? fields.id : "";
  const display =
    typeof fields.display_name === "string" && fields.display_name.length > 0 ? fields.display_name : id;
  const efforts = normalizeEfforts(fields.effort_options);
  const reasoning = normalizeReasoning(fields.reasoning);
  return {
    id,
    name: display,
    // 支不支持思考按网关说的来；没说就按支持（不知道不等于不支持）
    reasoning: reasoning === null ? true : reasoning,
    input: ["text", "image"],
    contextWindow: positiveIntOr(fields.context_window, DEFAULT_CONTEXT),
    maxTokens: positiveIntOr(fields.max_output_tokens, DEFAULT_OUTPUT),
    thinkingLevelMap: levelMap(effectiveEfforts(efforts, reasoning)),
    cost: { ...COST },
    compat: { ...COMPAT },
  };
}

/** /v1/models 的 data → provider 的 models。没有 id 的项跳过 */
export function modelsFromPayload(rawModels: readonly unknown[]): PiModelEntry[] {
  const out: PiModelEntry[] = [];
  for (const raw of rawModels) {
    const model = toPiModel(raw);
    if (model.id === "") continue;
    out.push(model);
  }
  return out;
}

/**
 * provider 配置。baseUrl 是**根地址**（不带 /v1）：pi 走 Anthropic 方言，自己拼
 * /v1/messages。
 */
export function toProviderConfig(gateway: string, apiKey: string, models: readonly PiModelEntry[]): PiProviderConfig {
  return {
    name: "AgentFacade (main route)",
    baseUrl: gateway,
    api: "anthropic-messages",
    apiKey,
    // 不写 provider 级 compat：扩展注册路径不读它，每条模型上那份才生效
    models: [...models],
  };
}
