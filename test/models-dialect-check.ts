// test/models-dialect-check.ts — /v1/models 的形状：默认 OpenAI，Anthropic 要显式要。
//
//   node --experimental-strip-types test/models-dialect-check.ts
//
// 离线：代码里的目录与一份手写的凭据，上游一个都不问。
//
// 覆盖：
//   1. 默认形状是 OpenAI（不带 query、不带特殊头）；
//   2. Anthropic 的头（anthropic-version / anthropic-beta / x-api-key）换形状；
//   3. ?dialect=openai 与 ?dialect=anthropic 各自盖过请求头；
//   4. ?dialect=foo 是 400，不静默回落成另一种形状；
//   5. created 稳定（不是逐请求取 now）；
//   6. created_at 是 RFC 3339 字符串（Anthropic 规范要的是字符串，不是 epoch）；
//   7. Anthropic 的 capabilities 是 null（不是半份对象）；
//   8. OpenAI 的 limit / capabilities / modalities / cost：知道的才发；
//   9. 不知道的键整个不出现 —— 不是 0，不是 false，不是空数组。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "models-dialect-"));
process.env.FACADE_DATA_DIR = tmp;

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log("");
  console.log(title);
}

/* ------------------------------------------------------------------ *
 * 一个假的 Koa 上下文：只带 serveModels 用得着的那些
 * ------------------------------------------------------------------ */

interface FakeCtx {
  status: number;
  body: any;
  headers: Record<string, string>;
  request: { body: unknown; headers: Record<string, string> };
  query: Record<string, string>;
  params: Record<string, string>;
  res: { headersSent: boolean; setHeader: (k: string, v: string) => void; end: () => void };
  set: (name: unknown, value?: string) => void;
}

function fakeCtx(options: {
  query?: Record<string, string>;
  params?: Record<string, string>;
  headers?: Record<string, string>;
} = {}): FakeCtx {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  return {
    status: 200,
    body: undefined,
    headers,
    request: { body: {}, headers: { ...(options.headers ?? {}) } },
    query: options.query ?? {},
    params: options.params ?? {},
    res: { headersSent: false, setHeader: () => {}, end: () => {} },
    set() {},
  };
}

/* ------------------------------------------------------------------ *
 * 一个真的账号（代码里的 MiniMax 目录），凭据是手写的
 * ------------------------------------------------------------------ */

await import("../lib/kinds/index.ts");
const { addAccount } = await import("../lib/providers.ts");
const { setSecret } = await import("../lib/store.ts");
const { serveModels } = await import("../lib/router/catalog-routes.ts");
const { groupCatalog } = await import("../lib/router/catalog.ts");
const { parseModelList } = await import("../lib/open-platform-catalog.ts");
const { saveAggregateModel, reloadAggregate } = await import("../lib/aggregate.ts");

const added = addAccount({ platform: "minimax" });
if (!added.ok) throw new Error(`cannot seed the account: ${added.message}`);
const now = Date.now();
setSecret(`session:provider:${added.id}`, "session", {
  schemaVersion: 1,
  clientId: "minimax-code",
  audience: "minimax",
  scopes: ["agent.default"],
  region: "cn",
  accessToken: "test-token",
  refreshToken: "test-refresh",
  tokenType: "Bearer",
  expiresAtMs: now + 3600_000,
  generation: 1,
  loginAtMs: now,
  refreshedAtMs: now,
});

const MODEL = "MiniMax-M3.1-Flash";

/** 平台那条路由（/minimax/v1/models）的答复。 */
function platformModels(options: Parameters<typeof fakeCtx>[0] = {}): FakeCtx {
  const ctx = fakeCtx({ ...options, params: { platform: "minimax" } });
  serveModels(ctx as any);
  return ctx;
}

/* ------------------------------------------------------------------ *
 * 1) 默认形状
 * ------------------------------------------------------------------ */

section("1. 默认形状是 OpenAI");

const plain = platformModels();
check("答 200", plain.status === 200, String(plain.status));
check("是 OpenAI 形状（object: list）", plain.body?.object === "list", JSON.stringify(plain.body).slice(0, 200));
check(
  "条目是 object: model",
  (plain.body?.data ?? []).every((m: any) => m.object === "model"),
  JSON.stringify(plain.body?.data ?? []).slice(0, 200),
);
check("列得出目录里的模型", (plain.body?.data ?? []).some((m: any) => m.id === MODEL), JSON.stringify(plain.body?.data ?? []).slice(0, 200));

/* ------------------------------------------------------------------ *
 * 2) 请求头判据
 * ------------------------------------------------------------------ */

section("2. 请求头判据");

const versioned = platformModels({ headers: { "anthropic-version": "2023-06-01" } });
check("anthropic-version → Anthropic 形状", versioned.body?.has_more === false, JSON.stringify(versioned.body).slice(0, 200));
check("Anthropic 形状没有 object: list", versioned.body?.object === undefined, JSON.stringify(versioned.body).slice(0, 200));

const beta = platformModels({ headers: { "anthropic-beta": "something" } });
check("anthropic-beta → Anthropic 形状", beta.body?.has_more === false, JSON.stringify(beta.body).slice(0, 200));

const xApiKey = platformModels({ headers: { "x-api-key": "k" } });
check("x-api-key 且没有 authorization → Anthropic 形状", xApiKey.body?.has_more === false, JSON.stringify(xApiKey.body).slice(0, 200));

const bearer = platformModels({ headers: { authorization: "Bearer x" } });
check("authorization: Bearer → OpenAI 形状", bearer.body?.object === "list", JSON.stringify(bearer.body).slice(0, 200));

const both = platformModels({ headers: { authorization: "Bearer x", "x-api-key": "k" } });
check("两个头都在 → OpenAI 形状（authorization 说了算）", both.body?.object === "list", JSON.stringify(both.body).slice(0, 200));

/* ------------------------------------------------------------------ *
 * 3) query 盖过请求头
 * ------------------------------------------------------------------ */

section("3. ?dialect= 盖过请求头");

const asked = platformModels({ query: { dialect: "anthropic" }, headers: { authorization: "Bearer x" } });
check("?dialect=anthropic → Anthropic 形状", asked.body?.has_more === false, JSON.stringify(asked.body).slice(0, 200));

const askedOpenai = platformModels({ query: { dialect: "openai" }, headers: { "anthropic-version": "2023-06-01" } });
check("?dialect=openai → OpenAI 形状", askedOpenai.body?.object === "list", JSON.stringify(askedOpenai.body).slice(0, 200));

/* ------------------------------------------------------------------ *
 * 4) 不认识的 dialect：400，不静默回落
 * ------------------------------------------------------------------ */

section("4. ?dialect=foo 是 400");

const bogus = platformModels({ query: { dialect: "foo" } });
check("状态是 400", bogus.status === 400, String(bogus.status));
const message = String(bogus.body?.error?.message ?? "");
check("正文说得清只认两种", message.includes("openai") && message.includes("anthropic"), message);
check("正文点了那个不认识的值", message.includes("foo"), message);

/* ------------------------------------------------------------------ *
 * 5) created 稳定
 * ------------------------------------------------------------------ */

section("5. created 稳定");

const first = platformModels();
const second = platformModels();
const firstCreated = (first.body?.data ?? [])[0]?.created;
const secondCreated = (second.body?.data ?? [])[0]?.created;
check("两次请求的 created 一样", firstCreated === secondCreated, `${firstCreated} vs ${secondCreated}`);
check("created 是一个秒数", Number.isFinite(firstCreated) && firstCreated > 0, String(firstCreated));
// 进程启动之后不会再变：不是「刚刚」。
check("created 不是逐请求取的 now", firstCreated <= Math.floor(Date.now() / 1000), String(firstCreated));

/* ------------------------------------------------------------------ *
 * 6) Anthropic 的 created_at 是 RFC 3339 字符串
 * ------------------------------------------------------------------ */

section("6. created_at 是 RFC 3339 字符串");

const anthropicShape = platformModels({ query: { dialect: "anthropic" } });
const entry = (anthropicShape.body?.data ?? [])[0] ?? {};
check("created_at 是字符串", typeof entry.created_at === "string", JSON.stringify(entry.created_at));
check(
  "created_at 能被 Date.parse 解析",
  typeof entry.created_at === "string" && !Number.isNaN(Date.parse(entry.created_at)),
  String(entry.created_at),
);
check(
  "created_at 长得像 RFC 3339",
  typeof entry.created_at === "string" && /^\d{4}-\d\d-\d\dT/.test(entry.created_at),
  String(entry.created_at),
);

/* ------------------------------------------------------------------ *
 * 7) Anthropic 的 capabilities 是 null
 * ------------------------------------------------------------------ */

section("7. Anthropic 的 capabilities 是 null");

check("capabilities 是 null", entry.capabilities === null, JSON.stringify(entry.capabilities));
check("capabilities 不是半份对象", typeof entry.capabilities !== "object" || entry.capabilities === null, JSON.stringify(entry.capabilities));

/* ------------------------------------------------------------------ *
 * 8) OpenAI 的附加字段：知道的才发
 * ------------------------------------------------------------------ */

section("8. OpenAI 的附加字段");

/** 一个假的目录：一组模型，按 id 索引。 */
function fakeGroup(models: any[]): any[] {
  return [{ group: "acme", models }];
}

const priced = groupCatalog(
  "acme",
  fakeGroup([
    {
      id: "m-price",
      displayName: "M Price",
      reasoning: true,
      toolCall: true,
      contextWindow: 1000000,
      maxOutputTokens: 384000,
      effortOptions: ["low", "high", "max"],
      modalities: { input: ["text", "image/jpeg"], output: ["text"] },
      billing: {
        mode: "token",
        currency: "USD",
        inputPerMillion: 0.15,
        outputPerMillion: 0.6,
        cacheReadPerMillion: 0.003,
      },
    },
  ]),
  "openai",
);
const pricedEntry = (priced.data ?? [])[0] ?? {};

check("limit.context", pricedEntry.limit?.context === 1000000, JSON.stringify(pricedEntry.limit));
check("limit.output", pricedEntry.limit?.output === 384000, JSON.stringify(pricedEntry.limit));
check("capabilities.tools.supported", pricedEntry.capabilities?.tools?.supported === true, JSON.stringify(pricedEntry.capabilities));
check("capabilities.reasoning.supported", pricedEntry.capabilities?.reasoning?.supported === true, JSON.stringify(pricedEntry.capabilities));
check(
  "capabilities.reasoning.effort",
  JSON.stringify(pricedEntry.capabilities?.reasoning?.effort) === JSON.stringify(["low", "high", "max"]),
  JSON.stringify(pricedEntry.capabilities?.reasoning?.effort),
);
check(
  "modalities 照上游的说",
  JSON.stringify(pricedEntry.modalities) === JSON.stringify({ input: ["text", "image/jpeg"], output: ["text"] }),
  JSON.stringify(pricedEntry.modalities),
);
check("cost.text.input.price", pricedEntry.cost?.text?.input?.price === 0.15, JSON.stringify(pricedEntry.cost));
check("cost.text.output.price", pricedEntry.cost?.text?.output?.price === 0.6, JSON.stringify(pricedEntry.cost));
check("cost.text.input.cache.read", pricedEntry.cost?.text?.input?.cache?.read === 0.003, JSON.stringify(pricedEntry.cost));

const plain2 = groupCatalog("acme", fakeGroup([{ id: "m-plain", displayName: "M Plain" }]), "openai");
const plainEntry = (plain2.data ?? [])[0] ?? {};
check("没有价格就没有 cost 这个键", !("cost" in plainEntry), JSON.stringify(plainEntry));
check("没有模态就没有 modalities 这个键", !("modalities" in plainEntry), JSON.stringify(plainEntry));
check("不知道能力就没有 capabilities 这个键", !("capabilities" in plainEntry), JSON.stringify(plainEntry));
check("不知道窗口就没有 limit 这个键", !("limit" in plainEntry), JSON.stringify(plainEntry));

const halfKnown = groupCatalog(
  "acme",
  fakeGroup([{ id: "m-half", displayName: "M Half", maxOutputTokens: 128 }]),
  "openai",
);
const halfEntry = (halfKnown.data ?? [])[0] ?? {};
check("只有输出上限时 limit 里没有 context", !("context" in (halfEntry.limit ?? {})), JSON.stringify(halfEntry.limit));
check("只有输出上限时 limit.output 在", halfEntry.limit?.output === 128, JSON.stringify(halfEntry.limit));

// 倍率计费：只存了 factor，丢了时段 —— 半个倍率是说谎，所以不发 cost。
const multiplier = groupCatalog(
  "acme",
  fakeGroup([
    {
      id: "m-mult",
      displayName: "M Mult",
      billing: { mode: "multiplier", credits: 0.15, multipliers: [{ factor: 0.5 }] },
    },
  ]),
  "openai",
);
const multEntry = (multiplier.data ?? [])[0] ?? {};
check("倍率计费不发 cost", !("cost" in multEntry), JSON.stringify(multEntry));

/* ------------------------------------------------------------------ *
 * 9) 上游报了模态才解析
 * ------------------------------------------------------------------ */

section("9. 模态只在上游报了的时候才有");

const withModalities = parseModelList({
  data: [{ id: "m", modalities: { input: ["text", "image/jpeg"], output: ["text"] } }],
});
check(
  "上游报了模态就解析出来",
  JSON.stringify(withModalities?.[0]?.traits?.modalitiesInput) === JSON.stringify(["text", "image/jpeg"]),
  JSON.stringify(withModalities?.[0]?.traits),
);
check(
  "输出模态也在",
  JSON.stringify(withModalities?.[0]?.traits?.modalitiesOutput) === JSON.stringify(["text"]),
  JSON.stringify(withModalities?.[0]?.traits),
);
const withoutModalities = parseModelList({ data: [{ id: "m" }] });
check(
  "上游没报模态就没有",
  withoutModalities?.[0]?.traits?.modalitiesInput === undefined &&
    withoutModalities?.[0]?.traits?.modalitiesOutput === undefined,
  JSON.stringify(withoutModalities?.[0]?.traits),
);

/* ------------------------------------------------------------------ *
 * 10) 根路由：发布的模型，默认也是 OpenAI 形状
 * ------------------------------------------------------------------ */

section("10. 根路由的默认形状");

saveAggregateModel({
  id: "shape-main",
  displayName: "Shape Main",
  strategy: "single",
  targets: [{ group: "minimax", upstreamModel: MODEL, weight: 1, position: 0, enabled: true }],
});
reloadAggregate();

const root = fakeCtx();
serveModels(root as any);
check("根路由默认是 OpenAI 形状", root.body?.object === "list", JSON.stringify(root.body).slice(0, 200));
check(
  "根路由列得出发布的模型",
  (root.body?.data ?? []).some((m: any) => m.id === "shape-main"),
  JSON.stringify(root.body?.data ?? []).slice(0, 200),
);
const rootAnthropic = fakeCtx({ query: { dialect: "anthropic" } });
serveModels(rootAnthropic as any);
check("根路由要 Anthropic 形状也给", rootAnthropic.body?.has_more === false, JSON.stringify(rootAnthropic.body).slice(0, 200));
check(
  "根路由的 Anthropic 形状里 capabilities 是 null",
  ((rootAnthropic.body?.data ?? [])[0] ?? {}).capabilities === null,
  JSON.stringify((rootAnthropic.body?.data ?? [])[0] ?? {}).slice(0, 200),
);

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

console.log("");
console.log("结果");
console.log(`  pass=${pass} fail=${fail}`);
if (fail) process.exitCode = 1;
