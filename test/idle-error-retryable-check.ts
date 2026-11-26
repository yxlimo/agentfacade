// test/idle-error-retryable-check.ts — 静默超时的错误帧能不能让客户端自动重试
//
//   node --experimental-strip-types test/idle-error-retryable-check.ts
//
// 离线：本机假上游 + 假开放平台 + 真 HTTP 服务，不连任何真平台
//
// 覆盖：
//   A 开关关（默认）：两种方言的错误帧与今天逐字节相同
//   B 开关开：Anthropic 那句换成 timed out，不再说 sent nothing
//   C 开关开：OpenAI 那是 server_error + upstream_idle_timeout
//   D 开关开：别的失败（上游提前断）文案不变
//
// 判据来自 pi v1.6.0 的 retry.ts：它的文本模式表认 "timed? out"，不认
// "sent nothing"。opencode 按 error.type 判，server_error 在它的 SERVER_CODES 里

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "idle-retryable-"));
process.env.FACADE_DATA_DIR = tmp;
const IDLE_MS = 200;
process.env.ROUTER_STREAM_IDLE_MS = String(IDLE_MS);
process.env.ROUTER_FIRST_FRAME_MS = "60_000";
delete process.env.ROUTER_IDLE_ERROR_RETRYABLE;

const MODEL = "idle-retry-model";
const CLOSED = "upstream closed the connection before the answer finished";
const EXPECTED_OFF_ANTHROPIC = 'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"upstream sent nothing for 200ms mid-stream (model=idle-retry-model)"}}\n\n';
const EXPECTED_OFF_OPENAI = 'data: {"error":{"type":"api_error","message":"upstream sent nothing for 200ms mid-stream (model=idle-retry-model)"}}\n\n';
const EXPECTED_OFF_ANTHROPIC_CUT = 'event: error\ndata: {"type":"error","error":{"type":"api_error","message":"upstream closed the connection before the answer finished"}}\n\n';
const EXPECTED_OFF_OPENAI_CUT = 'data: {"error":{"type":"api_error","message":"upstream closed the connection before the answer finished"}}\n\n';
const DUMP = process.env.DUMP_IDLE_RETRYABLE === "1";

const { reloadConfig } = await import("../lib/config.ts");
const { createOpenPlatform, syncPlatformModels } = await import("../lib/open-platforms.ts");
const { addAccount } = await import("../lib/providers.ts");
const { writeOpenPlatformKey } = await import("../lib/open-platform-credentials.ts");
const { handle } = await import("../lib/router/handle.ts");
const { closeStore } = await import("../lib/store.ts");

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

// 上游吐一帧就不结束，或者把连接掐断
let scenario = "";
let requestCount = 0;
const upstream = http.createServer((req, res) => {
  if (!req.url?.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  const tag = String(req.headers["x-scenario"] ?? "");
  if (tag !== scenario) {
    scenario = tag;
    requestCount = 0;
  }
  requestCount++;
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (content: string, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "chatcmpl-idle", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: finish }] })}\n\n`;
  if (requestCount > 1) {
    // 续写请求：说完后半段，客户端才看得到一条连续答复
    res.write(chunk("后半"));
    res.write(chunk("", "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  res.write(chunk("hi"));
  if (req.headers["x-idle-mode"] === "cut") {
    setTimeout(() => res.destroy(), 20);
    return;
  }
  // 故意不 res.end()：由中途静默上限收尾
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = (upstream.address() as { port: number }).port;

const platform = createOpenPlatform({
  id: "idle-retry-open",
  label: "Idle Retry Fake",
  baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
});
check("假开放平台建好了", platform.ok === true, platform.message);
syncPlatformModels("idle-retry-open", [MODEL]);
const account = addAccount({ platform: "idle-retry-open" });
check("假账号建好了", account.ok === true, account.message);
if (account.ok && account.id) writeOpenPlatformKey(account.id, "sk-idle-fake"); // privacy:allow — 编造的样例

function fakeCtx(res: http.ServerResponse): any {
  const ctx: any = { res, status: 200, respond: true };
  ctx.set = (headers: Record<string, string>) => {
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  };
  let body: any;
  Object.defineProperty(ctx, "body", {
    get: () => body,
    set: (value: any) => {
      body = value;
      if (ctx.respond === false || res.headersSent || res.writableEnded) return;
      res.statusCode = ctx.status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(value));
    },
  });
  return ctx;
}

const route = http.createServer(async (req, res) => {
  const ctx = fakeCtx(res);
  ctx.request = {
    body: { model: MODEL, stream: true, messages: [{ role: "user", content: "hello" }] },
    headers: { "x-idle-mode": req.headers["x-idle-mode"] ?? "", "x-scenario": req.headers["x-scenario"] ?? "" },
  };
  try {
    await handle(ctx, req.headers["x-dialect"] === "anthropic" ? "anthropic" : "openai", "idle-retry-open");
  } catch {
    // 头已经发过：错误帧才是客户端看到的那一句
  }
});
await new Promise<void>((resolve) => route.listen(0, "127.0.0.1", resolve));
const routePort = (route.address() as { port: number }).port;

async function run(dialect: "openai" | "anthropic", mode: "stall" | "cut", scenarioId = "default"): Promise<string> {
  return await new Promise<string>((resolve) => {
    let text = "";
    const req = http.request(
      {
        port: routePort,
        host: "127.0.0.1",
        path: "/",
        method: "POST",
        headers: { "x-dialect": dialect, "x-idle-mode": mode, "x-scenario": scenarioId },
      },
      (r) => {
        r.setEncoding("utf8");
        r.on("data", (chunk: string) => (text += chunk));
        r.on("end", () => resolve(text));
        r.on("close", () => resolve(text));
        r.on("error", () => resolve(text));
      },
    );
    req.on("error", () => resolve(text));
    req.end("{}");
  });
}

function errorFrameOf(text: string, dialect: "openai" | "anthropic"): string {
  const marker = dialect === "anthropic" ? "event: error\ndata: " : 'data: {"error":';
  const at = text.indexOf(marker);
  if (at < 0) return "";
  const end = text.indexOf("\n\n", at);
  return text.slice(at, end < 0 ? text.length : end + 2);
}

function errorJsonOf(text: string, dialect: "openai" | "anthropic"): any {
  const frame = errorFrameOf(text, dialect);
  const line = frame.split("\n").find((row) => row.startsWith("data: "));
  return line ? JSON.parse(line.slice(6)) : null;
}

function setModes(retryable: boolean, continuing = false, max: number | null = null): void {
  if (retryable) process.env.ROUTER_IDLE_ERROR_RETRYABLE = "1";
  else delete process.env.ROUTER_IDLE_ERROR_RETRYABLE;
  if (continuing) process.env.ROUTER_CONTINUE_ON_IDLE = "true";
  else delete process.env.ROUTER_CONTINUE_ON_IDLE;
  if (max === null) delete process.env.ROUTER_CONTINUE_MAX;
  else process.env.ROUTER_CONTINUE_MAX = String(max);
  reloadConfig();
}

const transcripts: Record<string, string> = {};
for (const flagOn of [false, true]) {
  setModes(flagOn);
  for (const dialect of ["anthropic", "openai"] as const) {
    const id = `${flagOn ? "on" : "off"}-${dialect}-stall`;
    transcripts[id] = await run(dialect, "stall", id);
    const cutId = `${flagOn ? "on" : "off"}-${dialect}-cut`;
    transcripts[cutId] = await run(dialect, "cut", cutId);
  }
}

// 两个开关互为替代：同时开时续写优先，且只 warn 一次
const { log } = await import("../lib/log.ts");
const warnings: string[] = [];
const originalWarn = log.warn;
log.warn = (...args: unknown[]) => {
  warnings.push(args.map(String).join(" "));
  return originalWarn(...args);
};
setModes(true, true);
const bothContinuing = await run("openai", "stall", "both-continue");
setModes(true, true, 0);
const bothExhausted = await run("openai", "stall", "both-exhausted");
log.warn = originalWarn;
setModes(false);
if (DUMP) {
  console.log(JSON.stringify(transcripts, null, 2));
} else {
  console.log("");
  console.log("A 关（默认）：静默超时的帧逐字节照旧");
  const offAnthropic = transcripts["off-anthropic-stall"];
  const offOpenAI = transcripts["off-openai-stall"];
  check("Anthropic 错误帧逐字节是今天的形状", errorFrameOf(offAnthropic, "anthropic") === EXPECTED_OFF_ANTHROPIC, JSON.stringify(errorFrameOf(offAnthropic, "anthropic")));
  check("OpenAI 错误帧逐字节是今天的形状", errorFrameOf(offOpenAI, "openai") === EXPECTED_OFF_OPENAI, JSON.stringify(errorFrameOf(offOpenAI, "openai")));
  check("关的时候没有 server_error 帧", !offAnthropic.includes("server_error") && !offOpenAI.includes("server_error"));

  console.log("");
  console.log("B 开：Anthropic 文案让 pi 认得出重试");
  const onAnthropic = transcripts["on-anthropic-stall"];
  const aJson = errorJsonOf(onAnthropic, "anthropic");
  check("结构没变：event: error + type api_error", errorFrameOf(onAnthropic, "anthropic").startsWith("event: error\n") && aJson?.type === "error" && aJson?.error?.type === "api_error", JSON.stringify(aJson));
  check("文案含 timed out", typeof aJson?.error?.message === "string" && aJson.error.message.includes("timed out"), String(aJson?.error?.message));
  check("文案不再含 sent nothing", typeof aJson?.error?.message === "string" && !aJson.error.message.includes("sent nothing"), String(aJson?.error?.message));
  check("秒数取实际值", typeof aJson?.error?.message === "string" && aJson.error.message.includes(`${IDLE_MS / 1000}s`), String(aJson?.error?.message));

  console.log("");
  console.log("C 开：OpenAI 帧是可重试的那一族");
  const onOpenAI = transcripts["on-openai-stall"];
  const oJson = errorJsonOf(onOpenAI, "openai");
  check("error.type 是 server_error", oJson?.error?.type === "server_error", JSON.stringify(oJson));
  check("error.code 是 upstream_idle_timeout", oJson?.error?.code === "upstream_idle_timeout", JSON.stringify(oJson));
  check("message 含 timed out", typeof oJson?.error?.message === "string" && oJson.error.message.includes("timed out"), String(oJson?.error?.message));

  console.log("");
  console.log("D 开：别的失败照旧");
  check("Anthropic 提前断的文案不变", errorFrameOf(transcripts["on-anthropic-cut"], "anthropic") === EXPECTED_OFF_ANTHROPIC_CUT, JSON.stringify(errorFrameOf(transcripts["on-anthropic-cut"], "anthropic")));
  check("OpenAI 提前断的文案不变", errorFrameOf(transcripts["on-openai-cut"], "openai") === EXPECTED_OFF_OPENAI_CUT, JSON.stringify(errorFrameOf(transcripts["on-openai-cut"], "openai")));
  check("提前断的文案是 upstream closed early", errorJsonOf(transcripts["on-anthropic-cut"], "anthropic")?.error?.message === CLOSED, JSON.stringify(errorJsonOf(transcripts["on-anthropic-cut"], "anthropic")));
  console.log("");
  console.log("E 开 + 续写开：两个开关互为替代，续写优先");
  check("两开关都开时照常续写，正文接着来", bothContinuing.includes('"content":"hi"') && bothContinuing.includes('"content":"后半"') && bothContinuing.includes('"finish_reason":"stop"'), bothContinuing.slice(-300));
  check("续写优先时没有 error 帧", !bothContinuing.includes('"error"') && !bothContinuing.includes("timed out"), bothContinuing.slice(-300));
  check("续写用尽也不报可重试超时", errorFrameOf(bothExhausted, "openai").includes("sent nothing") && !errorFrameOf(bothExhausted, "openai").includes("timed out"), JSON.stringify(errorFrameOf(bothExhausted, "openai")));
  check("续写用尽时仍是旧的 api_error 形状", errorJsonOf(bothExhausted, "openai")?.error?.type === "api_error", JSON.stringify(errorJsonOf(bothExhausted, "openai")));
  check("两个开关都开只 warn 一次", warnings.filter((line) => line.includes("按续写处理")).length === 1, JSON.stringify(warnings.filter((line) => line.includes("按续写处理"))));
}

upstream.closeAllConnections?.();
route.closeAllConnections?.();
await new Promise<void>((resolve) => upstream.close(() => resolve()));
await new Promise<void>((resolve) => route.close(() => resolve()));
closeStore();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
