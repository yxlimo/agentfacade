// test/silence-e2e-check.ts — 上游安静下来的六种形状，端到端。
//
//   node --experimental-strip-types test/silence-e2e-check.ts
//
// Offline: a fake upstream, the real gateway application (lib/router/app.ts —
// handle() behind the real routes and the real error shape) and a real client
// socket reading the stream. No real platform is contacted.
//
// Every window is shrunk to milliseconds through the ROUTER_* variables: the
// production values are minutes, and a self-test cannot wait for them.
//
// Each case runs in its own child process: the windows are read when the
// deliver module is loaded, and every child owns a fresh data directory.
//
//   A  an SSE comment line (`: ping`) keeps the connection alive, not the answer
//   B  an Anthropic `event: ping` frame does not count as the answer either
//   C  tool arguments arriving in slow fragments are the answer moving forward
//      (the incident: a healthy tool call was cut as "mid-stream silence")
//   D  a tool call held whole fails on the tool window, not the mid-stream one
//   E  a first-frame timeout is resent to the same upstream, never retargeted
//   F  a mid-stream silence is accounted as a failure, exactly one usage row
//
// The assertions are about what the client sees, how often the upstream was
// called and what the usage row says — never about a function's return value.

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

/** 这一次子进程跑哪个场景。没设就是父进程。 */
const CASE_NAME = process.env.SILENCE_CASE;
/** 子进程卡住就掐掉：一条流挂住不许把门禁挂住。 */
const WATCHDOG_MS = 40_000;

/** 等首字的上限（毫秒）。 */
const FIRST_FRAME_MS = 400;
/** 多久算静默（毫秒）。 */
const IDLE_MS = 300;
/** 工具开局之后的上限（毫秒）：比中途那个窗口小，两种静默才分得开。 */
const TOOL_OPENING_MS = 120;
/** 重发同一个上游的总时限（毫秒）：一见底就 504。 */
const RETRY_BUDGET_MS = 1_500;

/** 假上游那边的模型名。 */
const MODEL = "silence-upstream-model";
/** 客户端看到的那一个（根路由只服务发布出来的模型）。 */
const PUBLIC_MODEL = "silence-public";
/** 主目标：出问题的那个上游。 */
const PLATFORM_A = "silence-a";
/** 备目标：一次都不该被叫（换目标就是另一回事了）。 */
const PLATFORM_B = "silence-b";

/** 心跳间隔（毫秒）：一段正文之后只发心跳，永不停。 */
const HEARTBEAT_MS = 40;
/** C：参数碎片之间的间隔（毫秒）。远小于中途窗口，加起来却比它长。 */
const FRAGMENT_GAP_MS = 55;
/** C：思考之后多久发工具的开局帧（毫秒）。 */
const TOOL_OPENING_AFTER_THINKING_MS = 5;

/** C 的参数分片：单独哪一片都不是合法 JSON，拼到最后一片才收全。 */
const ARG_PIECES = ['{"pa', 'th":"a.tx', 't","lin', 'es":1,', '"mode":"r', 'ead"}'];
/** C 收全之后的参数。 */
const ARG_PATH = "a.txt";
const ARG_LINES = 1;
const ARG_MODE = "read";

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
 * 客户端看到的东西
 * ------------------------------------------------------------------ */

type Frame = { event: string; data: Record<string, unknown> };

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 客户端收到的一整条答复，按 SSE 帧拆开。 */
function parseFrames(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split("\n\n")) {
    const lines = block.split("\n");
    const eventLine = lines.find((line) => line.startsWith("event: "));
    const data = lines
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    frames.push({ event: eventLine?.slice(7) ?? "", data: asObject(parsed) ?? {} });
  }
  return frames;
}

/** 正文增量里的字，按出现顺序拼起来。 */
function textOf(frames: Frame[]): string {
  let text = "";
  for (const frame of frames) {
    if (frame.event !== "content_block_delta") continue;
    const delta = asObject(frame.data.delta);
    if (delta?.type === "text_delta" && typeof delta.text === "string") text += delta.text;
  }
  return text;
}

/** 工具参数按块号累积：Anthropic 那边参数是一段段 input_json_delta。 */
function toolArgumentsByIndex(frames: Frame[]): Map<number, string> {
  const byIndex = new Map<number, string>();
  for (const frame of frames) {
    if (frame.event !== "content_block_delta") continue;
    const delta = asObject(frame.data.delta);
    if (delta?.type !== "input_json_delta" || typeof delta.partial_json !== "string") continue;
    const index = typeof frame.data.index === "number" ? frame.data.index : 0;
    byIndex.set(index, (byIndex.get(index) ?? "") + delta.partial_json);
  }
  return byIndex;
}

/** 一段参数文本，能解析成对象就是对象。 */
function parsedArguments(text: string): Record<string, unknown> | null {
  try {
    return asObject(JSON.parse(text));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

type SeenCall = {
  platform: string;
  /** 收到的请求体（原样，用来比对「是不是同一份请求」）。 */
  body: string;
  /** 上游这一侧被我们掐掉了（不是它自己正常收尾）。 */
  cancelled: boolean;
};

type UsageRow = {
  ok: number;
  status: number;
  upstreamId: string;
  agentModel: string;
  error: string;
};

type Report = {
  status: number;
  retry: string | null;
  /** 客户端收到的全部字节。 */
  text: string;
  /** 请求发出到最后一个字节（毫秒）。 */
  spanMs: number;
  calls: SeenCall[];
  /** 按本次请求的 upstream_id + agent_model 取到的用量行（不兜底）。 */
  usage: UsageRow[];
};

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function anthropicFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** 一片 OpenAI 流式块。 */
function openaiChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return sse({
    id: "chatcmpl-silence",
    object: "chat.completion.chunk",
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

/** 工具调用的开局帧：名字来了，参数还没有。 */
function toolOpening(argumentsSoFar: string): string {
  return openaiChunk({
    tool_calls: [
      { index: 0, id: "call_silence", type: "function", function: { name: "read", arguments: argumentsSoFar } },
    ],
  });
}

/**
 * A：一段正文之后只发 SSE 注释行。
 *
 * 心跳说的是「连接还在」，不是「答复在往前走」：它不许把静默的计时清零。
 */
function writeContentThenComments(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(openaiChunk({ role: "assistant", content: "前半" }));
  const timer = setInterval(() => {
    res.write(": ping\n\n");
  }, HEARTBEAT_MS);
  res.on("close", () => clearInterval(timer));
}

/**
 * B：上游讲 Anthropic，一段正文之后只发 `event: ping`。
 *
 * 与 A 同一件事，另一种方言：这一帧同样不是「上游开始说话了」。
 */
function writeContentThenAnthropicPings(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    anthropicFrame("message_start", {
      type: "message_start",
      message: {
        id: "msg_silence",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    }),
  );
  res.write(anthropicFrame("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }));
  res.write(
    anthropicFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "前半" },
    }),
  );
  const timer = setInterval(() => {
    res.write(anthropicFrame("ping", { type: "ping" }));
  }, HEARTBEAT_MS);
  res.on("close", () => clearInterval(timer));
}

/**
 * C：先思考，再吐工具名，参数一片片慢慢来，最后收全。
 *
 * 每一片都让上游往前走了半步：加起来的静默比中途窗口长，任何两片之间都很短。
 * 一条健康的工具调用不该被算成静默。
 */
function writeSlowToolArguments(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const timers: NodeJS.Timeout[] = [];
  res.on("close", () => {
    for (const timer of timers) clearTimeout(timer);
  });
  res.write(openaiChunk({ role: "assistant", reasoning_content: "先想一下" }));
  timers.push(
    setTimeout(() => {
      res.write(toolOpening(""));
      ARG_PIECES.forEach((piece, position) => {
        timers.push(
          setTimeout(() => {
            res.write(openaiChunk({ tool_calls: [{ index: 0, function: { arguments: piece } }] }));
            if (position !== ARG_PIECES.length - 1) return;
            res.write(openaiChunk({}, "tool_calls"));
            res.write("data: [DONE]\n\n");
            res.end();
          }, (position + 1) * FRAGMENT_GAP_MS),
        );
      });
    }, TOOL_OPENING_AFTER_THINKING_MS),
  );
}

/** D：工具名 + 半截参数（不合法 JSON），然后不说话了。 */
function writeHalfToolCall(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(toolOpening('{"path":'));
  // 不 res.end()：参数永远不来
}

/** E：第一条连接一个字节都不发；第二条正常答复。 */
function writeSilentThenAnswer(res: http.ServerResponse, attempt: number): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (attempt === 1) {
    // 头发出去了，正文一个字都不发：等首字那道闸来收。
    res.flushHeaders();
    return;
  }
  res.write(openaiChunk({ role: "assistant", content: "答复" }));
  res.write(openaiChunk({}, "stop"));
  res.write("data: [DONE]\n\n");
  res.end();
}

/** F：一段正文之后停住，不续写，也不收尾。 */
function writeContentThenSilence(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(openaiChunk({ role: "assistant", content: "前半" }));
}

/* ------------------------------------------------------------------ *
 * 一个场景（子进程）
 * ------------------------------------------------------------------ */

type Case = "A" | "B" | "C" | "D" | "E" | "F";

function isCase(value: string | undefined): value is Case {
  return value === "A" || value === "B" || value === "C" || value === "D" || value === "E" || value === "F";
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** 等到一件事成真，或者等到时限。 */
async function sleepUntil(done: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done() && Date.now() < deadline) await sleep(25);
}

/** 上游那边的脚本：哪一个场景发什么。 */
function writerFor(which: Case): (res: http.ServerResponse, attempt: number) => void {
  switch (which) {
    case "A":
      return (res) => writeContentThenComments(res);
    case "B":
      return (res) => writeContentThenAnthropicPings(res);
    case "C":
      return (res) => writeSlowToolArguments(res);
    case "D":
      return (res) => writeHalfToolCall(res);
    case "E":
      return (res, attempt) => writeSilentThenAnswer(res, attempt);
    case "F":
      return (res) => writeContentThenSilence(res);
  }
}

/** 用量表里按本次请求的 upstream_id + agent_model 取到的行。 */
function usageRowsOf(dataDir: string): UsageRow[] {
  const db = new DatabaseSync(path.join(dataDir, "agentfacade.db"), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const raw = db
      .prepare("SELECT ok, status, upstream_id, agent_model, error FROM usage_event WHERE upstream_id = ? AND agent_model = ? ORDER BY id")
      .all(PLATFORM_A, PUBLIC_MODEL);
    const rows: UsageRow[] = [];
    for (const entry of raw) {
      const record = asObject(entry);
      if (!record) continue;
      const ok = record.ok;
      const status = record.status;
      if (typeof ok !== "number" || typeof status !== "number") continue;
      rows.push({
        ok,
        status,
        upstreamId: String(record.upstream_id ?? ""),
        agentModel: String(record.agent_model ?? ""),
        error: String(record.error ?? ""),
      });
    }
    return rows;
  } catch {
    // 表还没建起来（一条请求都还没记）：这就是「一行都没有」。
    return [];
  } finally {
    db.close();
  }
}

async function runChild(which: Case): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "silence-e2e-"));
  process.env.FACADE_DATA_DIR = dataDir;
  // 窗口按毫秒缩：生产上那两个数是分钟。
  process.env.ROUTER_FIRST_FRAME_MS = String(FIRST_FRAME_MS);
  process.env.ROUTER_STREAM_IDLE_MS = String(IDLE_MS);
  process.env.ROUTER_TOOL_OPENING_MS = String(TOOL_OPENING_MS);
  process.env.ROUTER_RETRY_BUDGET_MS = String(RETRY_BUDGET_MS);
  process.env.ROUTER_CONTINUE_ON_IDLE = "false";
  process.env.ROUTER_IDLE_ERROR_RETRYABLE = "false";

  const { app } = await import("../lib/router/app.ts");
  const { createOpenPlatform, syncPlatformModels } = await import("../lib/open-platforms.ts");
  const { addAccount } = await import("../lib/providers.ts");
  const { setProviderKeys } = await import("../lib/admin/credentials.ts");
  const { saveAggregateModel, reloadAggregate } = await import("../lib/aggregate.ts");

  const write = writerFor(which);
  const calls: SeenCall[] = [];
  /** 每个平台被叫了几次：E 要按次数决定发什么。 */
  const attemptsOf = new Map<string, number>();

  const upstream = http.createServer((req, res) => {
    const url = req.url ?? "";
    const platform = url.startsWith("/a/") ? PLATFORM_A : PLATFORM_B;
    const call: SeenCall = { platform, body: "", cancelled: false };
    calls.push(call);
    const pieces: Buffer[] = [];
    req.on("data", (piece: Buffer) => pieces.push(piece));
    req.on("end", () => {
      call.body = Buffer.concat(pieces).toString("utf8");
      // 正常收尾的响应 writableEnded 是 true；被我们掐掉的那一条不是。
      res.on("close", () => {
        if (!res.writableEnded) call.cancelled = true;
      });
      const attempt = (attemptsOf.get(platform) ?? 0) + 1;
      attemptsOf.set(platform, attempt);
      write(res, attempt);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  const upstreamPort = (upstream.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${upstreamPort}`;

  // 两个平台说不同的方言：Anthropic 那一类自己拼 /v1/messages，OpenAI 那一类
  // 拼 /chat/completions，所以两者的地址前缀写法不一样。
  const anthropicWire = which === "B";
  const baseA = anthropicWire ? `${origin}/a` : `${origin}/a/v1`;
  const baseB = `${origin}/b/v1`;

  for (const [id, base, kind] of [
    [PLATFORM_A, baseA, anthropicWire ? "anthropic" : "openai"],
    [PLATFORM_B, baseB, "openai"],
  ] as const) {
    const made = createOpenPlatform({ id, label: id, baseUrl: base, kind });
    if (!made.ok) throw new Error(`平台 ${id} 建不起来：${made.message}`);
    syncPlatformModels(id, [MODEL]);
    const account = addAccount({ platform: id });
    if (!account.ok || !account.id) throw new Error(`账号 ${id} 加不进去：${account.message}`);
    const keyed = setProviderKeys(account.id, ["sk-silence-e2e-fake"]); // privacy:allow — 编造的样例
    if (!keyed.ok) throw new Error(`账号 ${id} 的 key 写不进去：${keyed.message}`);
  }

  // 两个目标：A 重、B 轻。B 在列表里是「可以换过去」的那个，一次都不该被叫。
  saveAggregateModel({
    id: PUBLIC_MODEL,
    displayName: "上游静默",
    strategy: "fallback",
    targets: [
      { group: PLATFORM_A, upstreamModel: MODEL, weight: 10, position: 0, enabled: true },
      { group: PLATFORM_B, upstreamModel: MODEL, weight: 1, position: 1, enabled: true },
    ],
  });
  reloadAggregate();

  const route = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => route.once("listening", () => resolve()));
  const routePort = (route.address() as { port: number }).port;

  // 客户端：真 socket，按 io 收字节，量到最后一个字节用了多久。
  type ClientReply = { status: number; retry: string | null; text: string; spanMs: number };
  const client = await new Promise<ClientReply>((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (status: number, retry: string | null, text: string): void => {
      if (settled) return;
      settled = true;
      resolve({ status, retry, text, spanMs: Date.now() - started });
    };
    const body = JSON.stringify({
      model: PUBLIC_MODEL,
      max_tokens: 128,
      stream: true,
      messages: [{ role: "user", content: "说点什么" }],
      tools: [
        {
          name: "read",
          description: "读文件",
          input_schema: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    });
    const req = http.request(
      {
        host: "127.0.0.1",
        port: routePort,
        path: "/v1/messages",
        method: "POST",
        agent: false,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        let text = "";
        const retryHeader = res.headers["x-should-retry"];
        const retry = Array.isArray(retryHeader) ? retryHeader[0] : (retryHeader ?? "");
        res.setEncoding("utf8");
        res.on("data", (piece: string) => {
          text += piece;
        });
        res.on("end", () => finish(res.statusCode ?? 0, retry, text));
        res.on("close", () => finish(res.statusCode ?? 0, retry, text));
        res.on("error", () => finish(res.statusCode ?? 0, retry, text));
      },
    );
    req.on("error", () => finish(0, null, ""));
    req.end(body);
  });

  // 上游被掐掉是异步的（cancel 走 fetch 那一层）：等它落地再记账。
  if (which === "A" || which === "B" || which === "D" || which === "F") {
    await sleepUntil(() => calls.some((call) => call.cancelled), 1_500);
  }

  // 用量行是答复结束之后才写进库的：轮到它落库为止。
  if (which === "F") await sleepUntil(() => usageRowsOf(dataDir).length > 0, 5_000);

  const report: Report = {
    status: client.status,
    retry: client.retry,
    text: client.text,
    spanMs: client.spanMs,
    calls,
    usage: usageRowsOf(dataDir),
  };

  upstream.closeAllConnections?.();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  route.closeAllConnections?.();
  await new Promise<void>((resolve) => route.close(() => resolve()));

  console.log(`REPORT ${JSON.stringify(report)}`);
  fs.rmSync(dataDir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * 父进程：六个场景
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  if (isCase(CASE_NAME)) {
    await runChild(CASE_NAME);
    return;
  }

  const here = fileURLToPath(import.meta.url);
  const runCase = (which: Case): Promise<{ report: Report | null; code: number | null; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", here], {
        env: { ...process.env, SILENCE_CASE: which },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (piece: Buffer) => {
        out += piece.toString();
      });
      child.stderr.on("data", (piece: Buffer) => {
        err += piece.toString();
      });
      child.on("close", (code) => {
        const line = out.split("\n").find((entry) => entry.startsWith("REPORT "));
        let report: Report | null = null;
        if (line) {
          try {
            report = JSON.parse(line.slice(7)) as Report;
          } catch {
            report = null;
          }
        }
        resolve({ report, code, stderr: err });
      });
      setTimeout(() => child.kill(), WATCHDOG_MS).unref?.();
    });

  /* ---------------------------------------------------------------- *
   * A. 心跳（SSE 注释行）不算进度
   * ---------------------------------------------------------------- */

  section("A. SSE 注释行心跳：到点报中途静默，缺省那条路");
  {
    const a = await runCase("A");
    check("A 子进程正常退出", a.code === 0, `exit ${a.code}：${a.stderr.slice(0, 400)}`);
    const frames = parseFrames(a.report?.text ?? "");
    const errors = frames.filter((frame) => frame.event === "error");
    const calls = a.report?.calls ?? [];
    check(
      "A 客户端先拿到了那段正文（流真的开了）",
      textOf(frames).includes("前半"),
      textOf(frames),
    );
    check("A 客户端收到了 error 帧", errors.length === 1, `${errors.length} 帧：${(a.report?.text ?? "").slice(0, 300)}`);
    check(
      "A 那句说的是「中途静默」（不是等首字）",
      (a.report?.text ?? "").includes("mid-stream") && (a.report?.text ?? "").includes("sent nothing"),
      (a.report?.text ?? "").slice(-300),
    );
    check("A 静默之后没有收尾帧", !frames.some((frame) => frame.event === "message_stop"));
    check(
      "A 大约一个中途窗口就报（< 1500ms）",
      typeof a.report?.spanMs === "number" && a.report.spanMs < 1_500 && a.report.spanMs >= IDLE_MS - 50,
      `${a.report?.spanMs ?? -1}ms（窗口 ${IDLE_MS}ms）`,
    );
    check(
      "A 上游被叫了一次（没有换目标、没有重发）",
      calls.length === 1 && calls[0]?.platform === PLATFORM_A,
      calls.map((call) => call.platform).join(" | "),
    );
    check("A 上游那一条被掐掉了", calls.some((call) => call.cancelled), JSON.stringify(calls.map((call) => call.cancelled)));
    check("A 备目标一次都没被叫", calls.every((call) => call.platform !== PLATFORM_B), calls.map((call) => call.platform).join(" | "));
  }

  /* ---------------------------------------------------------------- *
   * B. 心跳（Anthropic 的 event: ping）不算进度
   * ---------------------------------------------------------------- */

  section("B. Anthropic 的 event: ping：同样不算进度");
  {
    const b = await runCase("B");
    check("B 子进程正常退出", b.code === 0, `exit ${b.code}：${b.stderr.slice(0, 400)}`);
    const frames = parseFrames(b.report?.text ?? "");
    const errors = frames.filter((frame) => frame.event === "error");
    const calls = b.report?.calls ?? [];
    check("B 客户端先拿到了那段正文", textOf(frames).includes("前半"), textOf(frames));
    check("B 客户端收到了 error 帧", errors.length === 1, `${errors.length} 帧：${(b.report?.text ?? "").slice(0, 300)}`);
    check(
      "B 那句说的是「中途静默」",
      (b.report?.text ?? "").includes("mid-stream") && (b.report?.text ?? "").includes("sent nothing"),
      (b.report?.text ?? "").slice(-300),
    );
    check("B 静默之后没有收尾帧", !frames.some((frame) => frame.event === "message_stop"));
    check(
      "B 大约一个中途窗口就报（< 1500ms）",
      typeof b.report?.spanMs === "number" && b.report.spanMs < 1_500 && b.report.spanMs >= IDLE_MS - 50,
      `${b.report?.spanMs ?? -1}ms（窗口 ${IDLE_MS}ms）`,
    );
    check(
      "B 上游被叫了一次（没有换目标、没有重发）",
      calls.length === 1 && calls[0]?.platform === PLATFORM_A,
      calls.map((call) => call.platform).join(" | "),
    );
    check("B 上游那一条被掐掉了", calls.some((call) => call.cancelled), JSON.stringify(calls.map((call) => call.cancelled)));
    check("B 备目标一次都没被叫", calls.every((call) => call.platform !== PLATFORM_B), calls.map((call) => call.platform).join(" | "));
  }

  /* ---------------------------------------------------------------- *
   * C. 工具参数慢慢吐：这是答复在往前走
   * ---------------------------------------------------------------- */

  section("C. 工具参数一片片慢慢来（每片之间很短、加起来超过窗口）：不许报中途静默");
  {
    const c = await runCase("C");
    check("C 子进程正常退出", c.code === 0, `exit ${c.code}：${c.stderr.slice(0, 400)}`);
    const text = c.report?.text ?? "";
    const frames = parseFrames(text);
    const errors = frames.filter((frame) => frame.event === "error");
    const withArguments = [...toolArgumentsByIndex(frames).values()].filter((json) => {
      const parsed = parsedArguments(json);
      return parsed?.path === ARG_PATH && parsed.lines === ARG_LINES && parsed.mode === ARG_MODE;
    });
    const toolBlocks = frames.filter(
      (frame) => frame.event === "content_block_start" && asObject(frame.data.content_block)?.type === "tool_use",
    );
    const calls = c.report?.calls ?? [];
    check(
      "C 客户端拿到收全的工具参数",
      withArguments.length === 1,
      `${withArguments.length} 份：${text.slice(-400)}`,
    );
    check("C 客户端拿到工具调用那一块", toolBlocks.length === 1, `${toolBlocks.length} 块`);
    check("C 客户端没有收到 error 帧", errors.length === 0, JSON.stringify(errors.map((frame) => frame.data)));
    check("C 客户端没有「sent nothing」那句话", !text.includes("sent nothing"), text.slice(-300));
    check("C 答复正常收尾（message_stop）", frames.some((frame) => frame.event === "message_stop"), text.slice(-200));
    check(
      "C 上游只被叫了一次",
      calls.length === 1 && calls[0]?.platform === PLATFORM_A,
      calls.map((call) => call.platform).join(" | "),
    );
    check("C 备目标一次都没被叫", calls.every((call) => call.platform !== PLATFORM_B), calls.map((call) => call.platform).join(" | "));
  }

  /* ---------------------------------------------------------------- *
   * D. 工具帧扣住：客户端零字节，失败在工具那道闸上
   * ---------------------------------------------------------------- */

  section("D. 工具名来了、参数没来：客户端一个字节都没拿到，按工具窗口失败");
  {
    const d = await runCase("D");
    check("D 子进程正常退出", d.code === 0, `exit ${d.code}：${d.stderr.slice(0, 400)}`);
    const text = d.report?.text ?? "";
    const calls = d.report?.calls ?? [];
    check("D 客户端拿到的是 504", d.report?.status === 504, `HTTP ${d.report?.status ?? 0} ${text.slice(0, 300)}`);
    check("D 答复说可以重发（x-should-retry: true）", d.report?.retry === "true", String(d.report?.retry));
    check(
      "D 客户端一个流的字节都没拿到（没有一个 SSE 帧）",
      !text.includes("data:") && !text.includes("event:") && !text.includes("message_start"),
      text.slice(0, 300),
    );
    // 错的名字不线上走：客户端能看到的只有那一句，日志里才是工具那道闸的标记。
    check(
      "D 那句是 120ms 的工具静默（不是 300ms 的中途静默）",
      text.includes(`${TOOL_OPENING_MS}ms`) && text.includes("mid-stream"),
      text.slice(0, 300),
    );
    check(
      "D 日志记的是工具开局那道闸",
      d.stderr.includes("tool_call 静默") || d.stderr.includes("a tool call was still being written"),
      d.stderr.split("\n").filter((line) => line.includes("[DELIVER]")).slice(-3).join(" | "),
    );
    check(
      "D 上游被重发了（同一条请求，同一个上游）",
      calls.length >= 2 && calls.every((call) => call.platform === PLATFORM_A),
      `${calls.length} 次：${calls.map((call) => call.platform).join(" | ")}`,
    );
    check(
      "D 每次都是原样重发（请求体一样）",
      calls.length >= 2 && calls.every((call) => call.body === calls[0]?.body),
      calls.map((call) => call.body.slice(0, 60)).join(" | "),
    );
    check("D 上游那一条被掐掉了", calls.some((call) => call.cancelled), JSON.stringify(calls.map((call) => call.cancelled)));
    check("D 备目标一次都没被叫", calls.every((call) => call.platform !== PLATFORM_B), calls.map((call) => call.platform).join(" | "));
  }

  /* ---------------------------------------------------------------- *
   * E. 等首字超时：同一个上游原样重发，不换目标
   * ---------------------------------------------------------------- */

  section("E. 等首字超时：同一个上游原样重发，客户端拿到完整答复");
  {
    const e = await runCase("E");
    check("E 子进程正常退出", e.code === 0, `exit ${e.code}：${e.stderr.slice(0, 400)}`);
    const text = e.report?.text ?? "";
    const frames = parseFrames(text);
    const calls = e.report?.calls ?? [];
    check("E 客户端拿到的是 200 的答复", e.report?.status === 200, `HTTP ${e.report?.status ?? 0} ${text.slice(0, 300)}`);
    check("E 答复里有正文", textOf(frames).includes("答复"), textOf(frames));
    check("E 答复正常收尾（message_stop）", frames.some((frame) => frame.event === "message_stop"), text.slice(-200));
    check("E 没有 error 帧", !frames.some((frame) => frame.event === "error"), text.slice(-300));
    check(
      "E 上游被叫了两次（第一次静默、第二次答复）",
      calls.length === 2 && calls.every((call) => call.platform === PLATFORM_A),
      `${calls.length} 次：${calls.map((call) => call.platform).join(" | ")}`,
    );
    check(
      "E 两次是同一份请求体（原样重发）",
      calls.length === 2 && calls[0]?.body === calls[1]?.body,
      calls.map((call) => call.body.slice(0, 80)).join(" | "),
    );
    check("E 备目标一次都没被叫（没有换目标）", calls.every((call) => call.platform !== PLATFORM_B), calls.map((call) => call.platform).join(" | "));
  }

  /* ---------------------------------------------------------------- *
   * F. 中途静默的记账：必须记失败
   * ---------------------------------------------------------------- */

  section("F. 中途静默之后记账：恰好一行、ok=0、504/502");
  {
    const f = await runCase("F");
    check("F 子进程正常退出", f.code === 0, `exit ${f.code}：${f.stderr.slice(0, 400)}`);
    const text = f.report?.text ?? "";
    const frames = parseFrames(text);
    const rows = f.report?.usage ?? [];
    const row = rows.length === 1 ? rows[0] : null;
    check(
      "F 客户端收到 error 帧（流停在了中途）",
      frames.some((frame) => frame.event === "error"),
      text.slice(-300),
    );
    check("F 用量里恰好一行（按 upstream_id + agent_model 取）", rows.length === 1, `匹配到 ${rows.length} 行：${JSON.stringify(rows)}`);
    check("F 那一行是失败（ok=0）", row?.ok === 0, JSON.stringify(row));
    check("F 那一行记的是超时（504 或 502）", row?.status === 504 || row?.status === 502, JSON.stringify(row));
    check(
      "F 那一行记着上游说了什么",
      typeof row?.error === "string" && row.error.includes("sent nothing"),
      JSON.stringify(row?.error),
    );
    check(
      "F 上游只被叫了一次（中途静默不重发、不换目标）",
      (f.report?.calls ?? []).length === 1 && (f.report?.calls ?? [])[0]?.platform === PLATFORM_A,
      (f.report?.calls ?? []).map((call) => call.platform).join(" | "),
    );
  }

  console.log("");
  if (fail === 0) {
    console.log(`PASS: ${pass} passed, ${fail} failed`);
  } else {
    console.log(`FAIL: ${pass} passed, ${fail} failed`);
    for (const problem of problems) console.log(`  - ${problem}`);
  }
  if (fail > 0) process.exitCode = 1;
}

await main();
