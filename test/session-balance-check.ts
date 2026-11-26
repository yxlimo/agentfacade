// test/session-balance-check.ts — 根路由 balance 策略的自测（全部离线）。
//
//   node --experimental-strip-types test/session-balance-check.ts
//
// 覆盖：
//   1. 会话键提取：内置头逐个命中、优先级、SESSION_HEADER 追加不覆盖；
//   2. body 兜底：prompt_cache_key、metadata.user_id 两种形态；
//   3. 卫生判据：空、空白、超长、控制字符一律当没有；
//   4. 粘性：同一会话反复算（含子进程）落同一个目标；
//   5. 比例：权重 7:3，2 万个会话，份额 70±3 / 30±3；
//   6. 降级确定性：命中目标失败时同一会话永远落同一个次选；
//   7. 400：balance 模型没有会话标识 → 400 且提到 SESSION_HEADER；
//      single 模型没有会话标识 → 照常路由（handler 级，假上游）。
//   8. 权重语义不变：single/fallback 仍是大权重优先。
//
// 假上游只有 Qoder 那一个：400 发生在任何上游调用之前，上游只是让
// 「single 照常路由」这一半有个能答话的地方。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configOverride, reloadConfig } from "../lib/config.ts";
import { sessionTargetOrder, select } from "../lib/router/selection.ts";
import { extractSessionKey, sessionHeaderNames, SESSION_HEADERS } from "../lib/session-id.ts";
import type { Json } from "../lib/json.ts";
import { startFakeQoder } from "./fake-qoder-upstream.ts";
import { startGateway, type Gateway } from "./harness.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE = "/agentfacade.admin.v1.AdminService";

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    problems.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log("");
  console.log(title);
}

/** 不带自定义头的提取（本文件前半段都跑在 SESSION_HEADER 为空的状态下）。 */
function clearSessionHeader(): void {
  configOverride("SESSION_HEADER", "");
  reloadConfig();
}

/** 提取的简写。 */
function extract(headers: Record<string, string>, body: Json = {}): { id: string; source: string } | null {
  return extractSessionKey(headers, body);
}

/* ------------------------------------------------------------------ *
 * 一、提取顺序
 * ------------------------------------------------------------------ */

section("提取顺序：内置头逐个命中");

const shapes: [string, string, string][] = [
  // 各家真实头形状各一条：名字 → 值 → 应报的 source
  ["x-claude-code-session-id", "cc-abc123", "header:x-claude-code-session-id"],
  ["session-id", "sid-001", "header:session-id"],
  ["session_id", "sid_002", "header:session_id"],
  ["x-session-id", "xs-003", "header:x-session-id"],
  ["x-session-affinity", "aff-004", "header:x-session-affinity"],
  ["x-client-request-id", "req-005", "header:x-client-request-id"],
];
for (const [name, value, source] of shapes) {
  const got = extract({ [name]: value });
  check(`${name} 命中并报对 source`, got !== null && got.id === value && got.source === source, JSON.stringify(got));
}

{
  // 多条同时存在：按内置表优先级命中第一个
  const got = extract({
    "x-client-request-id": "req-lowest",
    "x-session-id": "xs-middle",
    "x-claude-code-session-id": "cc-highest",
  });
  check("多条并存时按优先级命中第一个", got?.source === "header:x-claude-code-session-id", JSON.stringify(got));
}

/* ------------------------------------------------------------------ *
 * 二、SESSION_HEADER 追加在末尾
 * ------------------------------------------------------------------ */

section("SESSION_HEADER：追加，不覆盖");

{
  clearSessionHeader();
  configOverride("SESSION_HEADER", "x-my-session");
  reloadConfig();
  try {
    // 内置头存在时它不抢
    const withBuiltin = extract({ "session-id": "builtin", "x-my-session": "custom" });
    check("内置头存在时自定义头不抢", withBuiltin?.source === "header:session-id", JSON.stringify(withBuiltin));
    // 内置头都没有时才用它
    const onlyCustom = extract({ "x-my-session": "custom" });
    check("内置头都没有时用自定义头", onlyCustom?.source === "header:x-my-session", JSON.stringify(onlyCustom));
    // 逗号分隔的多个按顺序试
    configOverride("SESSION_HEADER", "x-first, x-second");
    reloadConfig();
    const two = extract({ "x-second": "second-value" });
    check("逗号分隔的多个按顺序试", two?.source === "header:x-second", JSON.stringify(two));
    // 内置表不被自定义头挤掉：报过的头名仍是六条内置在前
    const names = sessionHeaderNames();
    check(
      "自定义头追加在内置表末尾",
      names.length === SESSION_HEADERS.length + 2 &&
        names.slice(0, SESSION_HEADERS.length).join() === SESSION_HEADERS.join() &&
        names.slice(-2).join() === "x-first,x-second",
      names.join(","),
    );
  } finally {
    clearSessionHeader();
  }
}

/* ------------------------------------------------------------------ *
 * 三、body 兜底
 * ------------------------------------------------------------------ */

section("body 兜底");

{
  const a = extract({}, { prompt_cache_key: "pc-001" });
  check("prompt_cache_key 命中", a?.source === "body:prompt_cache_key" && a.id === "pc-001", JSON.stringify(a));
  // metadata.user_id 形态一：JSON 字符串，取里面的 session_id
  const b = extract({}, { metadata: { user_id: JSON.stringify({ session_id: "json-sess" }) } });
  check(
    "metadata.user_id（JSON 形态）取 session_id",
    b?.source === "body:metadata.user_id" && b.id === "json-sess",
    JSON.stringify(b),
  );
  // 形态二：老的 ..._session_<uuid>，取最后一段
  const c = extract({}, { metadata: { user_id: "user42_session_550e8400-e29b-41d4-a716-446655440000" } });
  check(
    "metadata.user_id（_session_ 形态）取最后一段",
    c?.source === "body:metadata.user_id" && c.id === "550e8400-e29b-41d4-a716-446655440000",
    JSON.stringify(c),
  );
  // 都没有 → 空
  const none = extract({}, { metadata: { user_id: "plain-user" } });
  check("认不出的 user_id 当没有", none === null, JSON.stringify(none));
  check("完全空的请求也是没有", extract({}, {}) === null);
}

/* ------------------------------------------------------------------ *
 * 四、卫生判据
 * ------------------------------------------------------------------ */

section("卫生判据：坏的值当没有，不 400 也不截断");

{
  const cases: [string, Record<string, string>][] = [
    ["空串", { "x-session-id": "" }],
    ["只有空白", { "x-session-id": "   \t " }],
    ["超过 256 字符", { "x-session-id": "x".repeat(257) }],
    ["含控制字符", { "x-session-id": "abc\r\nX-Injected: 1" }],
    ["含换行", { "x-session-id": "abc\nsecond" }],
  ];
  for (const [name, headers] of cases) {
    const got = extract(headers, { prompt_cache_key: "fallback-key" });
    check(`${name}：当没有，落到下一条（body 兜底）`, got?.source === "body:prompt_cache_key", JSON.stringify(got));
  }
  // 整条链上都是坏值 → null，不是 400 也不是截断后的半个 id
  const allBad = extract({ "x-session-id": "  " }, { prompt_cache_key: "" });
  check("全是坏值 → null", allBad === null, JSON.stringify(allBad));
}

/* ------------------------------------------------------------------ *
 * 五、HRW：粘性、比例、降级确定性
 * ------------------------------------------------------------------ */

section("HRW：粘性");

const targets = (weights: number[]) =>
  weights.map((weight, index) => ({
    id: `upstream-${index}`,
    weight,
    run: async () => `from-${index}`,
  }));

{
  // 同一个会话反复算 50 次 + 打乱输入顺序，结果都一样
  const winners = new Set<string>();
  for (let round = 0; round < 50; round++) {
    const candidates = targets([5, 3, 2]).reverse();
    const order = sessionTargetOrder(candidates, "session-stable-1");
    winners.add(order[0].id);
  }
  check("同一会话 50 次（含乱序输入）都落同一个目标", winners.size === 1, [...winners].join(","));
  // 换一个会话名，允许换目标（粘性不等于全员同一个目标）
  const other = sessionTargetOrder(targets([5, 3, 2]), "session-stable-2")[0].id;
  check("不同会话可以落在不同目标", winners.size === 1 && typeof other === "string", other);
}

{
  // 子进程里重新算一遍：跨进程稳定（sha256，不是进程内随机）
  const probe = path.join(os.tmpdir(), "session-balance-probe.mjs");
  fs.writeFileSync(
    probe,
    `import { sessionTargetOrder } from "${pathToFileUrl(path.join(ROOT, "lib/router/selection.ts"))}";
const candidates = [{ id: "upstream-0", weight: 5 }, { id: "upstream-1", weight: 3 }, { id: "upstream-2", weight: 2 }];
const out = ["session-stable-1", "session-stable-2"].map(
  (s) => sessionTargetOrder(candidates, s)[0].id,
);
console.log(JSON.stringify(out));
`,
  );
  const out = execFileSync(process.execPath, [probe], { cwd: ROOT, encoding: "utf8" });
  fs.rmSync(probe, { force: true });
  const subWinners = JSON.parse(out.trim()) as string[];
  const here = ["session-stable-1", "session-stable-2"].map(
    (s) => sessionTargetOrder(targets([5, 3, 2]), s)[0].id,
  );
  const inSub = ["session-stable-1", "session-stable-2"].map(
    (s) =>
      sessionTargetOrder(
        // 排序只读 id 与 weight；run 是接口必填的，这里补一个不会被调的实现。
        [
          { id: "upstream-0", weight: 5, run: async () => "" },
          { id: "upstream-1", weight: 3, run: async () => "" },
          { id: "upstream-2", weight: 2, run: async () => "" },
        ],
        s,
      )[0].id,
  );
  check("子进程算出的赢家与本进程一致", JSON.stringify(subWinners) === JSON.stringify(inSub), out.trim());
  check("赢家与本进程另一份实现调用一致", JSON.stringify(here) === JSON.stringify(inSub), here.join(","));
}

function pathToFileUrl(p: string): string {
  return "file://" + p;
}

section("HRW：比例（权重 7:3）");

{
  const two = targets([7, 3]);
  let a = 0;
  const total = 20_000;
  for (let i = 0; i < total; i++) {
    // 确定性会话名：不用真随机，免得份额抖动
    const id = `sess-${i}-fixed`;
    if (sessionTargetOrder(two, id)[0].id === "upstream-0") a++;
  }
  const shareA = (a / total) * 100;
  check(`权重 7:3 的份额在 70±3 / 30±3 内（实测 ${shareA.toFixed(2)}%）`, shareA >= 67 && shareA <= 73, `${shareA}%`);
}

section("HRW：weight<=0 不参与");

{
  const order = sessionTargetOrder([...targets([5, 3]), { id: "upstream-dead", weight: 0, run: async () => "dead" }], "s1");
  check("weight 0 的目标不在顺序里", !order.some((c) => c.id === "upstream-dead"), order.map((c) => c.id).join(","));
  check("其余目标仍有完整顺序", order.length === 2, order.map((c) => c.id).join(","));
}

section("HRW：降级确定性（select 级）");

{
  const boom = new Error("the first target is down");
  // 同一个会话，命中目标永远失败：select 走的次选必须每次都一样。
  const triedSets = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const tried: string[] = [];
    // handler 每条请求都重算一遍顺序：这里同样每轮重算，粘性才有得测
    const ordered = sessionTargetOrder(targets([5, 3, 2]), "session-stable-1");
    const candidates = ordered.map((c, index) =>
      index === 0
        ? { ...c, run: async () => { tried.push(c.id); throw boom; } }
        : { ...c, run: async () => { tried.push(c.id); return c.run(); } },
    );
    await select({ strategy: "balance", candidates });
    triedSets.add(tried.join(">"));
    if (i === 0) {
      // tried 记到第一个成功的为止：首目标（HRW 第一名）失败，接手的是第二名
      check("首目标失败后落到 HRW 顺序的次选", tried.join(">") === [ordered[0].id, ordered[1].id].join(">"), tried.join(">"));
    }
  }
  check("20 次重试走的降级链完全一致", triedSets.size === 1, [...triedSets].join(" | "));
}

section("权重语义不变（single / fallback 仍是大权重优先）");

{
  const tried: string[] = [];
  await select({ strategy: "fallback", candidates: targets([1, 9]).map((c) => ({
    ...c,
    run: async () => { tried.push(c.id); return `from ${c.id}`; },
  })) });
  check("fallback 仍先试大权重的", tried[0] === "upstream-1", tried.join(","));
  const triedSingle: string[] = [];
  await select({ strategy: "single", candidates: targets([1, 9]).map((c) => ({
    ...c,
    run: async () => { triedSingle.push(c.id); return `from ${c.id}`; },
  })) });
  check("single 仍只试大权重的", triedSingle.join(",") === "upstream-1", triedSingle.join(","));
}

/* ------------------------------------------------------------------ *
 * 六、handler 级：balance 没有会话 → 400；single 没有会话 → 照常路由
 * ------------------------------------------------------------------ */

section("handler 级（假上游 + 真网关）");

const fake = await startFakeQoder();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-balance-"));

execFileSync(
  process.execPath,
  ["--experimental-strip-types", "test/aggregate-setup.ts", "seed"],
  { cwd: ROOT, env: { ...process.env, FACADE_DATA_DIR: dataDir }, stdio: "ignore" },
);

const gw: Gateway = await startGateway({
  dataDir,
  env: {
    BENEFITS_DISABLED: "1",
    QODER_GLOBAL_LEGACY_BASE: `${fake.base}/qoder-global-legacy`,
    QODER_GLOBAL_OPENAPI_BASE: `${fake.base}/openapi-global`,
    QODER_LEGACY_RETRY_MS: "50",
  },
});
const token = fs.readFileSync(path.join(gw.dataDir, "admin-token"), "utf8").trim();

async function admin(method: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${gw.base}${SERVICE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text, httpStatus: res.status };
  }
}

async function chat(model: string, headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${gw.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "say ok" }], ...extra }),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

async function publish(id: string, strategy: string): Promise<any> {
  return admin("SavePublishedModel", {
    model: {
      id,
      displayName: id,
      enabled: true,
      strategy,
      targets: [
        { groupName: "qoder", upstreamModel: "GLM-5.3", weight: 7, position: 0, enabled: true },
        { groupName: "qoder", upstreamModel: "DeepSeek-V4-Pro", weight: 3, position: 1, enabled: true },
      ],
    },
  });
}

{
  const seeded = await admin("ListUpstreams", {});
  const qoderRow = (seeded.upstreams ?? []).find((u: any) => u.id === "qoder");
  const qoderAccount = (qoderRow?.accounts ?? [])[0];
  check("Qoder 有一个账号可开", Boolean(qoderAccount?.id), JSON.stringify(qoderRow?.accounts ?? []));
  await admin("SetAccountEnabled", { accountId: qoderAccount?.id ?? "qoder", enabled: true });

  const savedBalance = await publish("bal-model", "balance");
  const savedSingle = await publish("single-model", "single");
  check("balance 模型发布成功", savedBalance.id === "bal-model", JSON.stringify(savedBalance));
  check("single 模型发布成功", savedSingle.id === "single-model", JSON.stringify(savedSingle));

  // balance + 无会话标识 → 400，正文提到 SESSION_HEADER，不碰上游
  fake.reset();
  const refused = await chat("bal-model");
  check("balance 没有会话标识 → 400", refused.status === 400, `${refused.status} ${refused.text.slice(0, 200)}`);
  check("400 正文提到 SESSION_HEADER", refused.text.includes("SESSION_HEADER"), refused.text.slice(0, 300));
  check("400 正文列了试过的头名", refused.text.includes("x-claude-code-session-id"), refused.text.slice(0, 300));
  check("400 没有碰上游", fake.seen.length === 0, String(fake.seen.length));

  // balance + 带会话标识 → 正常路由
  fake.reset();
  const ok = await chat("bal-model", { "x-claude-code-session-id": "sess-live-1" });
  check("balance 带会话标识 → 照常路由", ok.status === 200, `${ok.status} ${ok.text.slice(0, 200)}`);
  check("确实打到了上游", fake.seen.length > 0, String(fake.seen.length));

  // single + 无会话标识 → 照常路由（不 400）
  fake.reset();
  const single = await chat("single-model");
  check("single 没有会话标识 → 照常路由", single.status === 200, `${single.status} ${single.text.slice(0, 200)}`);

  // balance + 只有 body 兜底 → 也通
  fake.reset();
  const bodyKey = await chat("bal-model", {}, { prompt_cache_key: "pc-live" });
  check("balance 只有 body 兜底 → 照常路由", bodyKey.status === 200, `${bodyKey.status} ${bodyKey.text.slice(0, 200)}`);

  // 别的模型不受影响：single 仍可用（上面已经验证），models 列表仍完整
  const listed = await fetch(`${gw.base}/v1/models`).then((r) => r.json());
  const ids = (listed.data ?? []).map((m: any) => m.id);
  check("两个模型都还在 /v1/models 里", ids.includes("bal-model") && ids.includes("single-model"), ids.join(","));
}

/* ------------------------------------------------------------------ *
 * 七、HTTP 层：balance 的粘性、份额、降级（真网关 + 假上游）
 * ------------------------------------------------------------------ */

// 上面几节量的是纯函数算出什么；这里量的是客户端发请求之后上游真正收到什么
// bal-model 已在上一段发布：两个 qoder 目标 GLM-5.3(7) 与 DeepSeek-V4-Pro(3)

section("HTTP：balance 粘性（同一会话 5 次，上游模型名一致）");

{
  fake.reset();
  const statuses: number[] = [];
  for (let i = 0; i < 5; i++) {
    const res = await chat("bal-model", { "x-claude-code-session-id": "sess-sticky-1" });
    statuses.push(res.status);
  }
  const models = fake.seen.map((s) => s.model);
  check("HTTP 粘性：5 次都成功", statuses.every((s) => s === 200), statuses.join(","));
  check("HTTP 粘性：上游被叫了 5 次", fake.seen.length === 5, String(fake.seen.length));
  // 只断五次彼此相同：HRW 修好之后赢家可能换人，写死模型名会假红
  check(
    "HTTP 粘性：5 次的上游模型名互相同一",
    models.length === 5 && models[0].length > 0 && models.every((m) => m === models[0]),
    models.join(","),
  );
}

section("HTTP：balance 份额不是优先级（20 个会话，两个上游都出现）");

{
  fake.reset();
  const statuses: number[] = [];
  for (let i = 0; i < 20; i++) {
    const res = await chat("bal-model", { "x-claude-code-session-id": `sess-share-${i}` });
    statuses.push(res.status);
  }
  const models = fake.seen.map((s) => s.model);
  check("HTTP 份额：20 次都成功", statuses.every((s) => s === 200), statuses.join(","));
  check(
    "HTTP 份额：两个上游都出现过（不是按权重排序永远取第一个）",
    new Set(models).size === 2,
    [...new Set(models)].join(","),
  );
}

section("HTTP：balance 降级确定性（首选失败，同一会话三次落同一个次选）");

{
  // 先发一次，看这个会话实际落在哪个模型上（取最后一次上游调用：成功的那个）
  // HRW 修好之后赢家可能换人，所以首选必须动态探出来，不能写死
  fake.reset();
  await chat("bal-model", { "x-claude-code-session-id": "sess-failover-1" });
  const probe = fake.seen;
  const first = probe[probe.length - 1]?.model ?? "";
  check("HTTP 降级：探到了这个会话实际落的目标", first.length > 0, first);

  // 只让那个目标失败：FAILING_MODELS 的既有行为不动，测完就撤
  fake.failModels.add(first);
  const statuses: number[] = [];
  const answering: string[] = [];
  const attempted: string[][] = [];
  for (let i = 0; i < 3; i++) {
    const before = fake.seen.length;
    const res = await chat("bal-model", { "x-claude-code-session-id": "sess-failover-1" });
    statuses.push(res.status);
    const calls = fake.seen.slice(before).map((s) => s.model);
    attempted.push(calls);
    answering.push(calls[calls.length - 1] ?? "");
  }
  fake.failModels.delete(first);

  check("HTTP 降级：首选失败后三次都成功", statuses.every((s) => s === 200), statuses.join(","));
  // 每次都真的先撞了被失败的首选：证明降级被触发，而不是三次都绕开它（假绿）
  check(
    "HTTP 降级：三次都先试了被失败的首选",
    attempted.every((calls) => calls.includes(first)),
    JSON.stringify(attempted),
  );
  check("HTTP 降级：三次都落在同一个次选目标", new Set(answering).size === 1, answering.join(","));
  check(
    "HTTP 降级：次选不是失败的首选",
    answering.every((m) => m !== first && m.length > 0),
    `${answering.join(",")} / ${first}`,
  );
}

await gw.stopAndWait();
await new Promise<void>((resolve) => {
  fake.close();
  resolve();
});
fs.rmSync(dataDir, { recursive: true, force: true });

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

console.log("");
if (fail > 0) {
  console.log(`FAIL：${fail} 条没过`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
} else {
  console.log(`ok：${pass} 条全过`);
}
