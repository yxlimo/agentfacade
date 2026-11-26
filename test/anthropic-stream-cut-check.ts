// test/anthropic-stream-cut-check.ts — 上游讲 Anthropic 的流中途断了，这条答复要按失败结算。
//
//   node --experimental-strip-types test/anthropic-stream-cut-check.ts
//
// 离线：临时数据目录 + 本进程里的假上游（只认 Anthropic Messages 报文），不连任何
// 真平台，不花 token。
//
// 生产上有过这样的记录：答复已经开始发（头已发出去），上游中途静默，这条请求被记成
// 「0 token 的成功」—— 客户端拿到的是一条 error 事件，用量表却写着 ok=1 / 200。
// 根因在 deliverAnthropicStream：答复开始之后上游中途失败时，它写了 error 事件、调了
// reportFailure、关了连接，然后把错误吞掉正常返回，调用方按成功结算。OpenAI 那条路径
// （deliverOpenAIStream / pipeOpenAIChunks，0c60f44）在同样的位置会把错误抛出去，让
// 调用方按失败收尾。
//
// 这条测试钉住修改后的契约，A/B 各一条分支，C 是对照：
//   A. 上游讲 Anthropic、客户端也要 Anthropic（deliverAnthropicStream 里
//      writeAnthropicFrames 那条分支）：上游发一帧内容后闭嘴
//      （ROUTER_STREAM_IDLE_MS=150ms）→ 客户端收到一条 error 事件、内容在它之前、
//      字节里没有 terminated、头只发一次；调用方按失败结算：usage_event 那一行
//      ok=0 / status=504 / error 是那条 TimeoutError（含 "sent nothing"）。
//   B. 同上但客户端要 OpenAI 方言（anthropicStreamToOpenAI 那条分支）→ 同样的结论。
//   C. 对照：上游答完 → 客户端没有 error 事件，调用方没有拿到错误，
//      usage_event 仍然 ok=1 / 200 / 无错误。

import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anthropic-cut-"));
process.env.FACADE_DATA_DIR = tmp;
// 中途那个上限设短：上游发一帧就闭嘴，这条答复要在一个安静窗口之内被掐断。
process.env.ROUTER_STREAM_IDLE_MS = "150";

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

function section(name: string): void {
  console.log("");
  console.log(name);
}

// 整个测试的总时限。**不 unref**：这条测试里有「上游永远不说话」的场景，真要哪里
// 挂住了，事件循环空掉之后 node 会直接退出、一条断言都不报 —— 那比红更糟。
const WATCHDOG_MS = 60_000;
const watchdog = setTimeout(() => {
  console.error(`\n[FAIL] 整个测试超过 ${WATCHDOG_MS / 1000}s 没跑完（网关可能挂住了）`);
  process.exit(1);
}, WATCHDOG_MS);

/** 数一个标记在字节里出现几次。 */
function countMarker(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

/* ------------------------------------------------------------------ *
 * 假上游：只认 Anthropic Messages
 * ------------------------------------------------------------------ */

/** 剧本：发一帧内容就闭嘴，还是把答复答完。 */
type Script = "cut" | "complete";
let script: Script = "cut";

type Json = Record<string, unknown>;

function parseJson(raw: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Json;
    return null;
  } catch {
    return null;
  }
}

const upstream = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = parseJson(Buffer.concat(chunks).toString("utf8"));

  if (url.pathname !== "/v1/messages") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "no such path" } }));
    return;
  }
  // 形状不对就说明网关发来的不是 Anthropic 报文 —— 那是测试自己接错了路。
  if (!body || typeof body.max_tokens !== "number" || !Array.isArray(body.messages)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "not an Anthropic Messages body" } }));
    return;
  }

  const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  if (body.stream !== true) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: String(body.model ?? ""),
        content: [{ type: "text", text: "hi" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 1 },
      }),
    );
    return;
  }

  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  res.write(
    frame("message_start", {
      type: "message_start",
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: String(body.model ?? ""),
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 1 },
      },
    }),
  );
  res.write(
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "hi" },
    }),
  );
  if (script === "cut") {
    // 发一帧内容就闭嘴：连接保持打开，一个字节都不再多写、也不结束。
    return;
  }
  res.write(frame("content_block_stop", { type: "content_block_stop", index: 0 }));
  res.write(
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    }),
  );
  res.write(frame("message_stop", { type: "message_stop" }));
  res.end();
});

// 收尾要能立刻断开还挂着的连接（cut 剧本里上游那一侧是开着的）。
const upstreamSockets = new Set<net.Socket>();
upstream.on("connection", (socket) => {
  upstreamSockets.add(socket);
  socket.on("close", () => upstreamSockets.delete(socket));
});

await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
const upstreamPort = (upstream.address() as { port: number }).port;
/** 不带 /v1 的地址：网关要自己拼出 /v1/messages。 */
const upstreamBase = `http://127.0.0.1:${upstreamPort}`;

/* ------------------------------------------------------------------ *
 * 网关（本进程里）
 * ------------------------------------------------------------------ */

const { app } = await import("../lib/router/app.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const { createOpenPlatform } = await import("../lib/open-platforms.ts");
const { addAccount } = await import("../lib/providers.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");
const { saveAggregateModel, reloadAggregate } = await import("../lib/aggregate.ts");

const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", () => resolve()));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

async function call(pathName: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

/* ------------------------------------------------------------------ *
 * 建平台、账号与模型
 * ------------------------------------------------------------------ */

section("建平台、账号与模型");

check("kindOf(\"anthropic\") 不是 null", kindOf("anthropic") !== null);

const created = createOpenPlatform({ id: "aup", label: "Aup", baseUrl: upstreamBase, kind: "anthropic" });
check("平台建得起来", created.ok === true, created.message);

const added = addAccount({ platform: "aup" });
const accountId = added.id ?? "";
check("账号加得起来", added.ok === true && accountId !== "", added.message);

const keyed = setProviderKeys(accountId, ["test-key-a"]);
check("一把推理 key 写得进去", keyed.ok === true, keyed.message);

saveAggregateModel({
  id: "claude-fake",
  displayName: "claude-fake",
  strategy: "single",
  targets: [{ group: "aup", upstreamModel: "claude-sonnet-x", weight: 1, position: 0, enabled: true }],
});
reloadAggregate();

/* ------------------------------------------------------------------ *
 * 用量表
 * ------------------------------------------------------------------ */

interface UsageRow {
  ok: number;
  status: number;
  error: string;
}

/** 用量表里最新的一行（这条测试里每次请求之后立刻读，那就是这一次的行）。 */
function lastUsageRow(): UsageRow | undefined {
  const db = new DatabaseSync(path.join(tmp, "agentfacade.db"));
  try {
    const raw = db.prepare("SELECT ok, status, error FROM usage_event ORDER BY id").all();
    const rows: UsageRow[] = [];
    for (const entry of raw) {
      const row = toUsageRow(entry);
      if (row) rows.push(row);
    }
    return rows[rows.length - 1];
  } finally {
    db.close();
  }
}

/** 一行用量：字段不对的行不认，免得把别的东西当成用量行。 */
function toUsageRow(entry: unknown): UsageRow | null {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  if (typeof record.ok !== "number" || typeof record.status !== "number" || typeof record.error !== "string") return null;
  return { ok: record.ok, status: record.status, error: record.error };
}

/* ------------------------------------------------------------------ *
 * A. 上游讲 Anthropic、客户端也要 Anthropic：发一帧后闭嘴
 * ------------------------------------------------------------------ */

section("A. 上游讲 Anthropic、客户端也要 Anthropic：上游发一帧后闭嘴");

script = "cut";
const a = await call("/v1/messages", {
  model: "claude-fake",
  max_tokens: 64,
  stream: true,
  messages: [{ role: "user", content: "say hi" }],
});

check("请求答 200（头在内容出现之后就发了，换不了目标）", a.status === 200, `HTTP ${a.status} ${a.text.slice(0, 200)}`);
check("内容已经发到客户端", a.text.includes('"text":"hi"'), a.text.slice(0, 300));
check("客户端收到一条 error 事件", countMarker(a.text, "event: error") === 1, a.text.slice(-400));
check("内容在 error 事件之前", a.text.indexOf('"text":"hi"') < a.text.indexOf("event: error"));
check("字节里没有 terminated", !a.text.includes("terminated"), a.text.slice(-200));
check("message_start 只发了一次", countMarker(a.text, "event: message_start") === 1);

const rowA = lastUsageRow();
check("usage_event ok=0（按失败结算，不是 0 token 的成功）", rowA?.ok === 0, JSON.stringify(rowA));
check("usage_event status=504（超时）", rowA?.status === 504, JSON.stringify(rowA));
check(
  "usage_event 的 error 是那条 TimeoutError",
  (rowA?.error ?? "").includes("sent nothing") && (rowA?.error ?? "").includes("mid-stream"),
  rowA?.error ?? "(空)",
);

/* ------------------------------------------------------------------ *
 * B. 客户端要 OpenAI 方言：上游仍是 Anthropic，发一帧后闭嘴
 * ------------------------------------------------------------------ */

section("B. 客户端要 OpenAI 方言：上游仍是 Anthropic，发一帧后闭嘴");

script = "cut";
const b = await call("/v1/chat/completions", {
  model: "claude-fake",
  stream: true,
  messages: [{ role: "user", content: "say hi" }],
});

check("请求答 200", b.status === 200, `HTTP ${b.status} ${b.text.slice(0, 200)}`);
check("内容已经转成 OpenAI 帧发到客户端", b.text.includes('"content":"hi"'), b.text.slice(0, 400));
check("客户端收到一条 error 事件", countMarker(b.text, "event: error") === 1, b.text.slice(-400));
check("内容在 error 事件之前", b.text.indexOf('"content":"hi"') < b.text.indexOf("event: error"));
check("字节里没有 terminated", !b.text.includes("terminated"), b.text.slice(-200));

const rowB = lastUsageRow();
check("usage_event ok=0", rowB?.ok === 0, JSON.stringify(rowB));
check("usage_event status=504", rowB?.status === 504, JSON.stringify(rowB));
check(
  "usage_event 的 error 是那条 TimeoutError",
  (rowB?.error ?? "").includes("sent nothing") && (rowB?.error ?? "").includes("mid-stream"),
  rowB?.error ?? "(空)",
);

/* ------------------------------------------------------------------ *
 * C. 对照：上游答完
 * ------------------------------------------------------------------ */

section("C. 对照：上游答完");

script = "complete";
const c = await call("/v1/messages", {
  model: "claude-fake",
  max_tokens: 64,
  stream: true,
  messages: [{ role: "user", content: "say hi" }],
});

check("请求答 200", c.status === 200, `HTTP ${c.status} ${c.text.slice(0, 200)}`);
check("答复完整收尾（message_stop）", c.text.includes("event: message_stop"), c.text.slice(-300));
check("客户端没有收到 error 事件", countMarker(c.text, "event: error") === 0, c.text.slice(-300));
check("字节里没有 terminated", !c.text.includes("terminated"));

const rowC = lastUsageRow();
check("调用方没有拿到错误：usage_event ok=1", rowC?.ok === 1, JSON.stringify(rowC));
check("usage_event status=200", rowC?.status === 200, JSON.stringify(rowC));
check("usage_event 没有错误", rowC?.error === "", rowC?.error ?? "(空)");

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

clearTimeout(watchdog);
for (const socket of upstreamSockets) socket.destroy();
upstream.close();
server.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  for (const problem of problems) console.log(`  - ${problem}`);
}
process.exit(fail > 0 ? 1 : 0);
