// test/tool-silence-check.ts — 工具开局静默：同一个上游原样重发
//
//   node --experimental-strip-types test/tool-silence-check.ts
//
// 离线：假上游（OpenAI 方言的 SSE）+ 真网关（router-proxy 子进程），不连任何真平台。
//
// 上游开了工具调用的头，参数还没来就安静了 —— 上游没坏，卡住的是那一条连接。
// 路由层因此原样重发同一条请求（同一个上游、同一个账号、同一份请求体），而不是
// 换一个上游：换一个会把已经开始的工具调用换掉。
//
// 用例：
//   a 分类：ToolCallSilenceError → tool-silence（不可降级、值得立刻重发、调用方可重发）
//   b 同一个上游原样重发：上游收到第二条一模一样的请求，账号是同一个
//   c 不写冷却（上游没坏，账号不该被下线）
//   d 预算用完：504 + x-should-retry: true，只记一条用量（ok=0）
//   e 绝不换上游：第二个目标一次都没被试
//   f 重发成功：只记一条用量（ok=1）

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startGateway, type Gateway } from "./harness.ts";

// 分类那一段要在本进程里读源码：数据目录指到临时目录，绝不碰默认的那个
// （/data 是生产库）。
const UNIT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "tool-silence-unit-"));
process.env.FACADE_DATA_DIR = UNIT_DIR;

const SERVICE = "/agentfacade.admin.v1.AdminService";
/** 上游那边的模型名。 */
const MODEL = "tool-silence-model";
/** 客户端看到的那一个（根路由只服务发布出来的模型）。 */
const PUBLIC_MODEL = "tool-silence-public";
/** 第一个目标：会卡住的那个上游。 */
const PLATFORM_A = "tool-silence-a";
/** 第二个目标：好好的上游（用来证明「绝不换上游」）。 */
const PLATFORM_B = "tool-silence-b";
/** 工具开局等多久算超时（毫秒）。 */
const TOOL_OPENING_MS = 200;
/** 这一轮的总时限（毫秒）：重发共用这一格。 */
const RETRY_BUDGET_MS = 3000;

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
    return;
  }
  fail++;
  problems.push(`${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
}

function section(title: string): void {
  console.log("");
  console.log(title);
}

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

interface Seen {
  platform: string;
  body: string;
  accountId: string;
  requestId: string;
  model: string;
}

/** 假上游收到过的推理请求。 */
const seen: Seen[] = [];
/** 还要卡住几次（只卡住第一个平台）。 */
let stallsLeft = 0;

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** 工具调用的开局帧：名字来了，参数还是空的。 */
function toolOpeningFrame(model: string): string {
  return sse({
    id: "chatcmpl-tool",
    object: "chat.completion.chunk",
    model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            { index: 0, id: "call_1", type: "function", function: { name: "get_weather", arguments: "" } },
          ],
        },
      },
    ],
  });
}

function contentFrame(model: string, text: string): string {
  return sse({
    id: "chatcmpl-ok",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: text } }],
  });
}

function endFrame(model: string): string {
  return sse({
    id: "chatcmpl-ok",
    object: "chat.completion.chunk",
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  });
}

const upstream = http.createServer(async (req, res) => {
  const url = req.url ?? "";
  const platform = url.startsWith("/a/") ? PLATFORM_A : PLATFORM_B;
  if (url.endsWith("/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: MODEL, object: "model" }] }));
    return;
  }
  if (!url.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  let model = "";
  try {
    model = String((JSON.parse(body || "{}") as { model?: unknown }).model ?? "");
  } catch {
    model = "";
  }
  seen.push({
    platform,
    body,
    accountId: String(req.headers["x-account-id"] ?? ""),
    requestId: String(req.headers["x-request-id"] ?? ""),
    model,
  });
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (platform === PLATFORM_A && stallsLeft > 0) {
    stallsLeft -= 1;
    // 只发了工具的名字，然后就不说话了：不 res.end()，等网关那道闸来收。
    res.write(toolOpeningFrame(model || MODEL));
    return;
  }
  res.write(contentFrame(model || MODEL, "ok"));
  res.write(endFrame(model || MODEL));
  res.write("data: [DONE]\n\n");
  res.end();
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = (upstream.address() as { port: number }).port;
const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

/* ------------------------------------------------------------------ *
 * 网关与面板
 * ------------------------------------------------------------------ */

const gw: Gateway = await startGateway({
  env: {
    ROUTER_TOOL_OPENING_MS: String(TOOL_OPENING_MS),
    ROUTER_RETRY_BUDGET_MS: String(RETRY_BUDGET_MS),
    // 别的闸要宽一点：这一节要考的只是工具开局那道闸。
    ROUTER_STREAM_IDLE_MS: "5000",
    ROUTER_FIRST_FRAME_MS: "10000",
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
    return { raw: text };
  }
}

const accounts: Record<string, string> = {};

for (const [id, base] of [
  [PLATFORM_A, `${upstreamBase}/a/v1`],
  [PLATFORM_B, `${upstreamBase}/b/v1`],
] as const) {
  const made = await admin("AddPlatform", { id, label: id, baseUrl: base, kind: "openai" });
  check(`平台 ${id} 建好了`, made.platform?.id === id, JSON.stringify(made));
  const account = await admin("AddAccount", { platform: id, alias: `${id} 账号` });
  const accountId = String(account.id ?? "");
  check(`账号 ${id} 建好了`, accountId !== "", JSON.stringify(account));
  const keys = await admin("SetProviderKeys", { upstreamId: accountId, keys: ["sk-tool-silence-fake"] }); // privacy:allow — 编造的样例
  check(`账号 ${id} 的推理 key 写进去了`, Number(keys.count ?? 0) === 1, JSON.stringify(keys));
  const enabled = await admin("SetAccountEnabled", { accountId, enabled: true });
  check(`账号 ${id} 开着`, enabled.ok === true, JSON.stringify(enabled));
  accounts[id] = accountId;
}

// 目录要等账号的 key 写进去之后才拉得到：没 key 的平台只会回「还没有可用的 API key」。
for (const id of [PLATFORM_A, PLATFORM_B] as const) {
  const refreshed = await admin("RefreshPlatformModels", { platformId: id });
  check(
    `平台 ${id} 的目录拉到了`,
    refreshed.ok === true && (refreshed.models ?? []).includes(MODEL),
    JSON.stringify(refreshed),
  );
}

const published = await admin("SavePublishedModel", {
  model: {
    id: PUBLIC_MODEL,
    displayName: "工具开局静默",
    enabled: true,
    strategy: "fallback",
    targets: [
      { groupName: PLATFORM_A, upstreamModel: MODEL, weight: 10, position: 0, enabled: true },
      { groupName: PLATFORM_B, upstreamModel: MODEL, weight: 1, position: 1, enabled: true },
    ],
  },
});
check("模型发布成功了", published.id === PUBLIC_MODEL, JSON.stringify(published));

/** 客户端发一次流式请求。 */
async function chat(): Promise<{ status: number; text: string; retry: string | null }> {
  const res = await fetch(`${gw.base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: PUBLIC_MODEL,
      stream: true,
      messages: [{ role: "user", content: "say ok" }],
      tools: [
        {
          type: "function",
          function: { name: "get_weather", description: "weather", parameters: { type: "object", properties: {} } },
        },
      ],
    }),
  });
  const text = await res.text();
  return { status: res.status, text, retry: res.headers.get("x-should-retry") };
}

/** 用量表里的行。 */
function usageRows(): Array<{ ok: number; status: number; upstream_id: string; error: string }> {
  const db = new DatabaseSync(path.join(gw.dataDir, "agentfacade.db"), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return db
      .prepare("SELECT ok, status, upstream_id, error FROM usage_event ORDER BY id DESC")
      .all() as Array<{ ok: number; status: number; upstream_id: string; error: string }>;
  } finally {
    db.close();
  }
}

/** 用量行是答复结束之后才写进库的：轮询到它落库为止，超时就把现场留下来 */
async function waitForUsageRows(before: number): Promise<ReturnType<typeof usageRows>> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const rows = usageRows();
    if (rows.length > before) return rows;
    if (Date.now() >= deadline) {
      check("用量行落了库", false, `等了 5000ms 还是没有新增（仍是 ${before} 条）：${JSON.stringify(rows.slice(0, 3))}`);
      return rows;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

/** 冷却表里那个账号的行。 */
function cooldownRows(accountId: string): Array<{ until_ms: number; reason: string }> {
  const db = new DatabaseSync(path.join(gw.dataDir, "agentfacade.db"), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    return db
      .prepare("SELECT until_ms, reason FROM cooldown WHERE provider_id = ?")
      .all(accountId) as Array<{ until_ms: number; reason: string }>;
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ *
 * a 分类
 * ------------------------------------------------------------------ */

section("a 分类：工具开局静默是它自己的一类");
{
  const { classifyUpstreamError, CALLER_RESEND_BY_KIND, FAILURE_KINDS, isSameUpstreamResend } = await import(
    "../lib/router/provider-selection.ts"
  );
  const { ToolCallSilenceError } = await import("../lib/router/deliver.ts");
  const silence = new ToolCallSilenceError(200, "model=tool-silence-model");
  const failure = classifyUpstreamError(silence);
  check("分类是 tool-silence", failure.kind === "tool-silence", failure.kind);
  check("不可降级（不换账号、不换上游）", failure.degradable === false, JSON.stringify(failure));
  check("值得立刻重发（同一个上游原样再来一次）", failure.retrySameAccountNow === true, JSON.stringify(failure));
  check("调用方可以重发整个请求", failure.callerShouldResend === true, JSON.stringify(failure));
  check("没有状态码（上游没回过状态）", failure.status === null, JSON.stringify(failure));
  check("重发的判据认它", isSameUpstreamResend(silence) === true);
  check("每个 kind 都有重发判决", FAILURE_KINDS.every((kind) => typeof CALLER_RESEND_BY_KIND[kind] === "boolean"));
  check("tool-silence 的判决是 true", CALLER_RESEND_BY_KIND["tool-silence"] === true);

  // 反证：别把「网络错」也带着改成原样重发。
  const connection = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  check("反证：连接断掉不原样重发", isSameUpstreamResend(connection) === false);
}

/* ------------------------------------------------------------------ *
 * b + c + e + f 重发成功
 * ------------------------------------------------------------------ */

section("b 重发：同一个上游、同一份请求、同一个账号");
{
  seen.length = 0;
  stallsLeft = 1;
  const before = usageRows().length;
  const answered = await chat();
  const calls = seen.filter((one) => one.platform === PLATFORM_A);

  check("客户端拿到的是成功答复", answered.status === 200, `HTTP ${answered.status} ${answered.text.slice(0, 200)}`);
  check("答复里有正文", answered.text.includes('"ok"'), answered.text.slice(0, 200));
  check("上游被叫了两次（第一次卡住，第二次答了）", calls.length === 2, String(calls.length));
  check(
    "两次请求是同一份（原样重发）",
    calls.length === 2 && calls[0].body === calls[1].body,
    calls.map((one) => one.body.slice(0, 80)).join(" | "),
  );
  check(
    "两次是同一个账号",
    calls.length === 2 && calls[0].accountId === calls[1].accountId && calls[0].accountId !== "",
    calls.map((one) => one.accountId).join(" | "),
  );
  check(
    "两次是两次尝试（request id 不一样）",
    calls.length === 2 && calls[0].requestId !== calls[1].requestId,
    calls.map((one) => one.requestId).join(" | "),
  );

  section("c 冷却：上游没坏，账号不该被下线");
  check(
    "卡住的那个账号没有进冷却",
    cooldownRows(accounts[PLATFORM_A]).length === 0,
    JSON.stringify(cooldownRows(accounts[PLATFORM_A])),
  );

  section("e 绝不换上游：第二个目标一次都没被试");
  check(
    "第二个目标没被叫过",
    seen.every((one) => one.platform !== PLATFORM_B),
    seen.map((one) => one.platform).join(" | "),
  );

  section("f 记账：重发成功只记一条");
  const rows = await waitForUsageRows(before);
  const addedCount = rows.length - before;
  const added = rows.slice(0, addedCount);
  check("只多了一条用量", addedCount === 1, `新增 ${addedCount} 条：${JSON.stringify(added)}`);
  check("那一条是成功（ok=1）", added[0]?.ok === 1, JSON.stringify(added));
  check("状态是 200", added[0]?.status === 200, JSON.stringify(added));

  const log = gw.log();
  check(
    "日志说了「原样重发」",
    log.includes("resending the same request"),
    log.split("\n").filter((line) => line.includes("[ROUTE]")).slice(-4).join(" | "),
  );
}

/* ------------------------------------------------------------------ *
 * d 预算用完
 * ------------------------------------------------------------------ */

section("d 预算用完：可重试的超时（504 + x-should-retry）");
{
  seen.length = 0;
  stallsLeft = 99;
  const before = usageRows().length;
  const answered = await chat();
  const calls = seen.filter((one) => one.platform === PLATFORM_A);

  check("客户端拿到的是 504", answered.status === 504, `HTTP ${answered.status} ${answered.text.slice(0, 200)}`);
  check("答复说可以重发（x-should-retry: true）", answered.retry === "true", String(answered.retry));
  check("不是事件流（头还没发就失败了）", !answered.text.includes("data:"), answered.text.slice(0, 200));
  check("上游被叫了不止一次（预算之内一直在重发）", calls.length >= 2, String(calls.length));
  check(
    "每一次都是原样重发（请求体都一样）",
    calls.every((one) => one.body === calls[0].body),
    calls.map((one) => one.body.slice(0, 60)).join(" | "),
  );

  section("e 绝不换上游：预算用完也不换目标");
  check(
    "第二个目标还是没被叫过",
    seen.every((one) => one.platform !== PLATFORM_B),
    seen.map((one) => one.platform).join(" | "),
  );

  section("c 冷却：预算用完也不写冷却");
  check(
    "账号还是没有进冷却",
    cooldownRows(accounts[PLATFORM_A]).length === 0,
    JSON.stringify(cooldownRows(accounts[PLATFORM_A])),
  );

  section("f 记账：只在最终失败记一次");
  const rows = await waitForUsageRows(before);
  const addedCount = rows.length - before;
  const added = rows.slice(0, addedCount);
  check("只多了一条用量", addedCount === 1, `新增 ${addedCount} 条：${JSON.stringify(added)}`);
  check("那一条是失败（ok=0）", added[0]?.ok === 0, JSON.stringify(added));
  check("状态是 504", added[0]?.status === 504, JSON.stringify(added));
}

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

upstream.closeAllConnections?.();
await new Promise<void>((resolve) => upstream.close(() => resolve()));
gw.stop();
const { closeStore } = await import("../lib/store.ts");
closeStore();
fs.rmSync(UNIT_DIR, { recursive: true, force: true });

console.log("");
if (fail === 0) {
  console.log(`PASS: ${pass} passed, ${fail} failed`);
} else {
  console.log(`FAIL: ${pass} passed, ${fail} failed`);
  for (const problem of problems) console.log(`  - ${problem}`);
}
if (fail > 0) process.exitCode = 1;
