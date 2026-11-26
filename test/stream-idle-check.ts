// test/stream-idle-check.ts — 上游安静下来的时候，这条请求要有个尽头。
//
//   node --experimental-strip-types test/stream-idle-check.ts
//
// 离线：起一个本地的假上游和一个真的 HTTP 服务，不连任何真平台。
//
// 那两次事故（生产实录）：
//
//   21:00:12 [DELIVER] 发给客户端的错误事件：terminated
//   21:00:12 [REQ] POST /v1/messages model=coder-a → 200 304690ms from=pi
//
// 上游中途不吐数据，我们没有任何自己的空闲超时，靠 undici 默认的
// bodyTimeout: 300_000 兜底：客户端干等 5 分钟，最后收到的是 Node 自己那句
// `terminated` —— 既不是它能看懂的东西，也不该是网关该说的话。
//
// 覆盖：
//   1. 上游说了一帧就安静 → 客户端在**中途那个上限**之后收到一条 error 事件，
//      那句话是「上游不说话了（mid-stream）」，不含 terminated；
//   2. 上游一直在吐（每 40ms 一帧，共 10 帧）→ 一帧不少、没有 error 事件
//      （证明上限量的是「两帧之间」，不是总时长）；
//   3. 上游一帧都不吐 → 等的是**首帧那个上限**，超时后头还没发就往外抛
//      （路由层还能换目标），客户端一个字节收不到；
//   4. clientMessageOf 的判别力：内部字眼翻成人话，别的错误原样返回。
//
// 还有几段是 review 之后补的（都是同一个东西：这道闸只该量上游的安静，而
// 头只该在第一帧读成功之后才发）：
//   5. 上游一直在吐（Anthropic 入口，tee 那条路）→ 一帧不少；
//   6. 消费方自己停一会儿不读（慢客户端）→ 不算安静，一帧不丢、上游不取消；
//   7. 首帧就报错（错误帧 / 连接断）→ 头没发过，路由器能换目标：客户端拿到
//      第二个目标的完整答复，头只发一次；整条链都这样 → 客户端拿到真实状态
//      与上游原话，一个 SSE 头都没写过；
//   8. 首帧沉默走 fallback（不是写 error 帧），而中途沉默照旧写 error 帧 ——
//      两条分别成立，而且用的是各自那个上限；
//   9. 旧协议那个入口（AsyncIterable）同样：首帧读不到就不发头、往外抛；
//      它现在也有首帧超时与中途空闲上限（同语义的 withIteratorIdle），超时之后
//      把上游还回去；
//  10. 上限设成 0 → 闸关掉：上游一帧都不吐也不报超时；
//  11. 心跳（`: ping`）与零长度的块不算第一帧：首帧那一次量的是**绝对死线**，
//      不随读取重置 —— 否则一个先发心跳、再慢慢想的流就被中途那个短窗口砍了。
//
// 断言看的是**网关那一侧**加客户端收到的字节：客户端那边一个不读的 socket
// 连服务器关了它都察觉不到。
//
// 两个上限都在模块求值时读一次（`ROUTER_FIRST_FRAME_MS`、
// `ROUTER_STREAM_IDLE_MS`），所以必须在 import 之前设好 —— 见下面那两行
// `process.env`。两个值故意不一样：首帧与中途用的是哪一个，从错误自己报的
// `idleMs` 就能看出来。

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stream-idle-"));
process.env.FACADE_DATA_DIR = tmp;
// 自测不能真等几分钟。两个值不一样：首帧那个比中途那个长，这样「首帧与中途
// 用的是哪一个」从错误自己报的 idleMs 就能看出来（两个值一样的话这条断言就
// 失去判别力）。
const IDLE_MS = 150;
const FIRST_FRAME_MS = 400;
process.env.ROUTER_STREAM_IDLE_MS = String(IDLE_MS);
process.env.ROUTER_FIRST_FRAME_MS = String(FIRST_FRAME_MS);

const {
  deliverOpenAIStream,
  deliverOpenAIChunks,
  deliverAnthropicStream,
  clientMessageOf,
  sendError,
  StreamIdleError,
  withStreamIdle,
  STREAM_IDLE_DEFAULT_MS,
  STREAM_FIRST_FRAME_DEFAULT_MS,
} = await import("../lib/router/deliver.ts");
const { AuthError } = await import("../lib/credential.ts");
// 面板那条路：写进库 + 重新读一遍。工具开局那个上限是热设置，靠它改。
const { configOverride, reloadConfig } = await import("../lib/config.ts");
// 抓日志用：客户端那句话统一了，日志里还得能分辨是哪一种静默。
const { captureLog } = await import("./log-capture.ts");
/** 上游没把话说完就断了：客户端看到的那一句。 */
const CLOSED_EARLY = "upstream closed the connection before the answer finished";

let pass = 0;
let fail = 0;

// 整个测试的总时限。**不 unref**：这条测试里有「上游永远不说话」的场景，真要
// 是哪里挂住了，事件循环空掉之后 node 会直接退出、一条断言都不报 —— 那比红更糟。
const WATCHDOG_MS = 60_000;
const watchdog = setTimeout(() => {
  console.error(`\n[FAIL] 整个测试超过 ${WATCHDOG_MS / 1000}s 没跑完（网关可能挂住了）`);
  process.exit(1);
}, WATCHDOG_MS);

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

/** 等一会儿。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const encoder = new TextEncoder();

/** 一条 Anthropic 方言的 SSE 帧。 */
function anthropicFrame(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** 一条 Anthropic 的 message_start（客户端要读的那一帧）。 */
function messageStart(): string {
  return anthropicFrame("message_start", {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "fake-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  });
}

/** 一条 OpenAI 方言的正文帧。 */
function openaiFrame(content: string): string {
  return (
    "data: " +
    JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      model: "fake-model",
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    }) +
    "\n\n"
  );
}

/**
 * 一个假的上游。
 *
 * `gapMs`：帧与帧之间隔多久（上游是慢慢想、慢慢说的）。
 * `after`：说完之后干什么 —— `close` 收工，`stall` 一直不说话（连接还挂着，
 * 正是「上游卡住了」那个样子），`raw` 直接把 Node 自己那个错扔出来
 * （`TypeError: terminated`，undici 断流时抛的就是它）。
 * `onCancel`：上游那一侧被取消时叫它（安静到上限就该停手，别再占着连接）。
 */
function upstream(
  frames: string[],
  opts: { gapMs?: number; after?: "close" | "stall" | "raw"; onCancel?: () => void } = {},
): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (opts.gapMs) await sleep(opts.gapMs);
      if (sent < frames.length) {
        controller.enqueue(encoder.encode(frames[sent++]));
        return;
      }
      if (opts.after === "stall") {
        // 一直不说话：不 close、不再 enqueue。
        await new Promise<void>(() => {});
        return;
      }
      if (opts.after === "raw") {
        // undici 断流时抛的那个错：message 是 Node 的话，真正的原因在 cause 上。
        throw Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } });
      }
      controller.close();
    },
    cancel() {
      opts.onCancel?.();
    },
  });
}

/**
 * 一个按剧本走的假上游：每一步等一会儿再说一段。
 *
 * 心跳与零长度的块就是靠它造的：`text: ": ping\n\n"` 是心跳，`text: ""`
 * 是一个零长度的块。两者都**不是**答复开始说话了。
 *
 * `after`：剧本走完之后干什么 —— `close` 收工，`stall` 一直不说话。
 */
function scriptedUpstream(
  steps: { waitMs?: number; text?: string }[],
  after: "close" | "stall" = "close",
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i >= steps.length) {
        if (after === "stall") {
          await new Promise<void>(() => {});
          return;
        }
        controller.close();
        return;
      }
      const step = steps[i++];
      if (step.waitMs) await sleep(step.waitMs);
      controller.enqueue(encoder.encode(step.text ?? ""));
    },
    cancel() {
      onCancel?.();
    },
  });
}

/** 客户端收到的帧里那句错误话（两种方言的 error 形状都认）。 */
function errorMessageOf(frames: string[]): string {
  for (const frame of frames) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data) continue;
    let json: any;
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    if (json?.type === "error" && json.error?.message) return String(json.error.message);
    if (json?.error?.message) return String(json.error.message);
  }
  return "";
}

interface ServeResult {
  /** 客户端收到的帧。 */
  received: string[];
  /** 网关那个处理器什么时候回来的（ms，从起服务算起）。 */
  handlerMs: number;
  /** 网关有没有抛出来。 */
  handlerError: string | null;
  /** 网关抛出来那个错本身（要看它是哪一类）。 */
  thrown: any;
  /** 网关报给调用方的失败（如果有）。 */
  failure: any;
  /** 头 flush 了几次（SSE 头只能发一次）。 */
  flushes: number;
  /** 客户端拿到的 HTTP 状态与 content-type。 */
  status: number;
  contentType: string;
  /** 客户端收到的正文（错误答复用）。 */
  text: string;
}

/** 一个最小的 Koa 上下文：`sendError` 要用到的那几样（status、body、set）。 */
function fakeCtx(res: http.ServerResponse): any {
  // Koa 的 `ctx.respond` 一开始不是 false（它只有被 `takeOver` 设成 false 时
  // 才拦着不写），所以这里也从一个「会写」的状态开始。设成 false 就等于把
  // 接管提前了，失败路径的 sendError 会白写一份谁都收不到的正文。
  const ctx: any = { res, status: 200, respond: true };
  ctx.set = (headers: Record<string, string>) => {
    for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
  };
  let body: any;
  Object.defineProperty(ctx, "body", {
    get: () => body,
    set: (value: any) => {
      body = value;
      // Koa 就是在这里写响应的，而且 `respond === false` 时它不写：那一份响应
      // 被答复那一层接管了。答复一个字都没写就往外抛的场合，那一层**没有**
      // 接管过响应，所以这里写的这一份才是客户端收到的真实状态。
      if (ctx.respond === false) return;
      if (res.headersSent || res.writableEnded) return;
      res.statusCode = ctx.status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(value));
    },
  });
  return ctx;
}

/** 起一个服务，把假上游交给网关转发，把客户端收到的帧收回来。 */
async function serve(opts: {
  source?: ReadableStream<Uint8Array>;
  /** 旧协议那个入口收的是已经解析好的帧，不是字节流。 */
  iterable?: AsyncIterable<any>;
  entry: "openai" | "anthropic" | "chunks";
  dialect: "openai" | "anthropic";
  /** 客户端每收到一帧就叫它（看帧是什么时候到的）。 */
  onFrame?: (frame: string, at: number) => void;
}): Promise<ServeResult> {
  const started = Date.now();
  let handlerError: string | null = null;
  let thrown: any = null;
  let failure: any = null;
  let flushes = 0;
  let handlerDone: () => void = () => {};
  const handlerFinished = new Promise<void>((resolve) => {
    handlerDone = resolve;
  });

  const server = http.createServer(async (_req, res) => {
    // 一个最小的 Koa 上下文：只用到 res。
    const ctx = fakeCtx(res);
    const flush = res.flushHeaders.bind(res);
    res.flushHeaders = (() => {
      flushes++;
      return flush();
    }) as any;
    const report = (e: unknown) => {
      failure = e;
    };
    try {
      if (opts.entry === "openai") {
        await deliverOpenAIStream(ctx, opts.source!, opts.dialect, "fake-model", undefined, undefined, report);
      } else if (opts.entry === "chunks") {
        await deliverOpenAIChunks(ctx, opts.iterable!, opts.dialect, "fake-model", undefined, report);
      } else {
        await deliverAnthropicStream(ctx, opts.source!, opts.dialect, "fake-model", 0, undefined, report);
      }
    } catch (e) {
      thrown = e;
      handlerError = (e as Error)?.message ?? String(e);
    } finally {
      handlerDone();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  const received: string[] = [];
  let status = 0;
  let contentType = "";
  let text = "";
  const clientDone = new Promise<void>((resolve) => {
    const req = http.request(
      { port, host: "127.0.0.1", path: "/v1/messages", method: "POST" },
      (r) => {
        status = r.statusCode ?? 0;
        contentType = String(r.headers["content-type"] ?? "");
        r.on("data", (c) => {
          text += c.toString();
          let i: number;
          while ((i = text.indexOf("\n\n")) >= 0) {
            const frame = text.slice(0, i);
            received.push(frame);
            opts.onFrame?.(frame, Date.now());
            text = text.slice(i + 2);
          }
        });
        r.on("end", resolve);
        r.on("close", resolve);
        r.on("error", resolve);
      },
    );
    req.on("error", resolve);
    req.end("{}");
  });

  // 网关那一侧先完事：这是断言要看的东西。
  await Promise.race([handlerFinished, new Promise<void>((resolve) => setTimeout(resolve, 20_000))]);
  const handlerMs = Date.now() - started;

  // 客户端那边可能不结束（连接还挂着），给它一个上限，然后放掉。
  await Promise.race([clientDone, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);

  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { received, handlerMs, handlerError, thrown, failure, flushes, status, contentType, text };
}

/* ---------------- 一个假的路由器 ---------------- */

/** 一个假目标的第一帧长什么样。 */
type Script =
  /** 200 的流，第一帧就是一个错误对象（上游拿 200 告诉你它不行）。 */
  | { first: "error-frame"; words: string }
  /** 第一帧之前连接就断了（undici 抛的那个错）。 */
  | { first: "raw" }
  /** 第一帧一直不来。 */
  | { first: "silent" }
  /** 上游一个字不说就收工了：空答复。 */
  | { first: "empty" }
  /** 只发信封（没有内容），然后闭嘴。 */
  | { first: "envelope-stall" }
  /** 发了内容，然后闭嘴。 */
  | { first: "content-stall"; text: string }
  /** 只发心跳，然后闭嘴。 */
  | { first: "ping-stall" }
  /** 正常答复。 */
  | { first: "answer"; text: string }
  /** 原样给出的上游帧，然后闭嘴：用来造工具调用的开局帧。 */
  | { first: "raw-frames-stall"; frames: string[] };

/** 按剧本内容造一个假上游的流。 */
function streamFor(script: Script): ReadableStream<Uint8Array> {
  switch (script.first) {
    case "error-frame":
      return upstream([`data: ${JSON.stringify({ error: { message: script.words } })}\n\n`]);
    case "raw":
      return upstream([], { after: "raw" });
    case "silent":
      return upstream([], { after: "stall" });
    case "empty":
      return upstream([]);
    case "envelope-stall":
      return upstream(
        [
          `data: ${JSON.stringify({
            id: "c1",
            object: "chat.completion.chunk",
            model: "fake-model",
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          })}\n\n`,
        ],
        { after: "stall" },
      );
    case "content-stall":
      return upstream([openaiFrame(script.text)], { after: "stall" });
    case "ping-stall":
      return scriptedUpstream(
        [
          { waitMs: 0, text: ": ping\n\n" },
          { waitMs: 0, text: 'event: ping\ndata: {"type":"ping"}\n\n' },
        ],
        "stall",
      );
    case "raw-frames-stall":
      return upstream(script.frames, { after: "stall" });
    case "answer":
      return upstream([openaiFrame(script.text), "data: [DONE]\n\n"]);
  }
}

/** 按剧本造一个 Anthropic 方言的假上游流（给 anthropic 入口的路由测试用）。 */
function anthropicStreamFor(script: Script): ReadableStream<Uint8Array> {
  switch (script.first) {
    case "error-frame":
      return upstream([`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: script.words } })}\n\n`]);
    case "raw":
      return upstream([], { after: "raw" });
    case "silent":
      return upstream([], { after: "stall" });
    case "empty":
      return upstream([]);
    case "envelope-stall":
      return upstream([messageStart(), 'event: ping\ndata: {"type":"ping"}\n\n'], { after: "stall" });
    case "content-stall":
      return upstream(
        [
          messageStart(),
          anthropicFrame("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: script.text },
          }),
        ],
        { after: "stall" },
      );
    case "ping-stall":
      return scriptedUpstream(
        [
          { waitMs: 0, text: ": ping\n\n" },
          { waitMs: 0, text: 'event: ping\ndata: {"type":"ping"}\n\n' },
        ],
        "stall",
      );
    case "raw-frames-stall":
      return upstream(script.frames, { after: "stall" });
    case "answer":
      return upstream([
        messageStart(),
        anthropicFrame("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: script.text },
        }),
        anthropicFrame("message_stop", { type: "message_stop" }),
      ]);
  }
}

interface RouterResult extends ServeResult {
  /** 试了几个目标（路由层换目标就是加一）。 */
  attempts: number;
  /** 每一个目标自己的失败，按尝试先后。 */
  errors: any[];
  /** 最后一个失败（看它是哪一种错）。 */
  lastError: any;
}

/**
 * 一个假的路由器：按顺序试目标，第二帧以后的事不归它管。
 *
 * 这正是 lib/router/handle.ts 做的事：头没发出去就换下一个目标；全都失败就
 * 用真实状态码答（`sendError`），头发出去过的话就没得换了。
 */
async function serveAsRouter(scripts: Script[], entry: "stream" | "chunks" | "anthropic" = "stream"): Promise<RouterResult> {
  const started = Date.now();
  let flushes = 0;
  let attempts = 0;
  let handlerError: string | null = null;
  const errors: any[] = [];
  let lastError: any = null;
  let handlerDone: () => void = () => {};
  const handlerFinished = new Promise<void>((resolve) => {
    handlerDone = resolve;
  });

  const server = http.createServer(async (_req, res) => {
    const ctx = fakeCtx(res);
    const flush = res.flushHeaders.bind(res);
    res.flushHeaders = (() => {
      flushes++;
      return flush();
    }) as any;
    try {
      for (const script of scripts) {
        attempts++;
        try {
          if (entry === "chunks") {
            await deliverOpenAIChunks(ctx, chunksFor(script), "openai", "fake-model", undefined, () => {});
          } else if (entry === "anthropic") {
            await deliverAnthropicStream(ctx, anthropicStreamFor(script), "anthropic", "fake-model", 0, undefined, () => {});
          } else {
            await deliverOpenAIStream(ctx, streamFor(script), "openai", "fake-model", undefined, undefined, () => {});
          }
          // 接住了：这一条就是给客户端的答复。
          return;
        } catch (e) {
          lastError = e;
          errors.push(e);
          // 头已经发出去了：路由层只能在原地收尾，换不了目标。
          if (res.headersSent) return;
        }
      }
      // 整条链都失败，而且一个头都没发过：真实状态码与上游原话。
      sendError(ctx, lastError);
    } catch (e) {
      handlerError = (e as Error)?.message ?? String(e);
    } finally {
      handlerDone();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as any).port;

  const received: string[] = [];
  let rest = "";
  let status = 0;
  let contentType = "";
  const clientDone = new Promise<void>((resolve) => {
    const req = http.request(
      { port, host: "127.0.0.1", path: "/v1/messages", method: "POST" },
      (r) => {
        status = r.statusCode ?? 0;
        contentType = String(r.headers["content-type"] ?? "");
        r.on("data", (c) => {
          rest += c.toString();
          let i: number;
          while ((i = rest.indexOf("\n\n")) >= 0) {
            received.push(rest.slice(0, i));
            rest = rest.slice(i + 2);
          }
        });
        r.on("end", resolve);
        r.on("close", resolve);
        r.on("error", resolve);
      },
    );
    req.on("error", resolve);
    req.end("{}");
  });

  await Promise.race([handlerFinished, new Promise<void>((resolve) => setTimeout(resolve, 20_000))]);
  const handlerMs = Date.now() - started;
  await Promise.race([clientDone, new Promise<void>((resolve) => setTimeout(resolve, 1000))]);

  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { received, handlerMs, handlerError, thrown: lastError, failure: null, flushes, status, contentType, text: rest, attempts, errors, lastError };
}

/** 按剧本造一个旧协议那种「已经解析好的帧」的异步序列。 */
async function* chunksFor(script: Script): AsyncGenerator<any> {
  switch (script.first) {
    case "error-frame":
      // 旧协议的上游拒掉一次请求时抛的就是这个（见 qoder 的 legacyError）：
      // 它不是一帧错误内容，是一个带状态与上游原话的错误。
      throw new AuthError("upstream rejected the request", script.words, 502);
    case "raw":
      throw Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } });
    case "silent":
      await new Promise<void>(() => {});
      return;
    case "empty":
      return;
    case "envelope-stall":
      yield { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" } }] };
      await new Promise<void>(() => {});
      return;
    case "content-stall":
      yield { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: script.text } }] };
      await new Promise<void>(() => {});
      return;
    case "ping-stall":
      yield { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {} }] };
      await new Promise<void>(() => {});
      return;
    case "raw-frames-stall":
      return;
    case "answer":
      yield { id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: script.text } }] };
      yield {
        id: "c1",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      return;
  }
}

/* ------------------------------------------------------------------ *
 * 1. 上游说了一帧就安静
 * ------------------------------------------------------------------ */

section("上游说了一帧就安静（Anthropic 入口）");

{
  let cancelled = false;
  const r = await serve({
    source: upstream([anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } })], { after: "stall", onCancel: () => (cancelled = true) }),
    entry: "anthropic",
    dialect: "anthropic",
  });
  const text = r.received.join("\n\n");
  const said = errorMessageOf(r.received);
  check("客户端收到了内容帧", text.includes("hello"), text.slice(0, 120));
  check("客户端收到了一条 error 事件", text.includes("event: error"), text.slice(0, 200));
  check("那句话说清了是流中途安静下来的", /upstream sent nothing for 150ms mid-stream/.test(said), said);
  check("那句话带上了是哪个模型", said.includes("model=fake-model"), said);
  check("那句话里没有 terminated", !/terminated/i.test(text), said);
  check("记账回调拿到的就是那条静默超时", r.failure?.name === "TimeoutError" && String(r.failure?.message).includes("sent nothing for 150ms mid-stream"), `${r.failure?.name}: ${String(r.failure?.message)}`);
  check("记账回调报错不影响客户端收到的字节", r.received.filter((f) => f.includes('"error"')).length === 1 && !/terminated/i.test(text), text.slice(0, 200));
  check("头只发了一次", r.flushes === 1, `${r.flushes} 次`);
  check("网关在中途上限之后很快就收工了", r.handlerMs < 5_000, `用了 ${r.handlerMs}ms`);
  check("上游那一侧被取消了", cancelled, "上游还挂着");
  check("网关报了「超时」", r.failure?.name === "TimeoutError", String(r.failure?.name));
  // 中途的那一次用的是中途那个上限，不是首帧那个。两个值故意不一样。
  check("中途超时报的是中途那个上限", r.failure?.idleMs === IDLE_MS, String(r.failure?.idleMs));
  check("中途超时的 phase 是 mid-stream", r.failure?.phase === "mid-stream", String(r.failure?.phase));
}

section("上游说了一帧就安静（OpenAI 入口）");

{
  let cancelled = false;
  const r = await serve({
    source: upstream([openaiFrame("hello")], { after: "stall", onCancel: () => (cancelled = true) }),
    entry: "openai",
    dialect: "openai",
  });
  const text = r.received.join("\n\n");
  const said = errorMessageOf(r.received);
  check("客户端收到了第一帧", text.includes("hello"), text.slice(0, 120));
  check("客户端收到了一条 error 帧", said !== "", text.slice(0, 200));
  check("那句话说清了是流中途安静下来的", /upstream sent nothing for 150ms mid-stream/.test(said), said);
  check("那句话里没有 terminated", !/terminated/i.test(text), said);
  check("网关把那条静默超时抛出来了", r.handlerError !== null && r.thrown?.name === "TimeoutError" && String(r.thrown?.message).includes("sent nothing for 150ms mid-stream"), `${r.thrown?.name}: ${r.handlerError ?? ""}`);
  check("抛错不影响客户端收到的字节", r.received.filter((f) => f.includes('"error"')).length === 1 && !/terminated/i.test(text), text.slice(0, 200));
  check("头只发了一次", r.flushes === 1, `${r.flushes} 次`);
  check("网关在中途上限之后很快就收工了", r.handlerMs < 5_000, `用了 ${r.handlerMs}ms`);
  check("上游那一侧被取消了", cancelled, "上游还挂着");
  check("网关报了「超时」", r.failure?.name === "TimeoutError", String(r.failure?.name));
  check("中途超时报的是中途那个上限", r.failure?.idleMs === IDLE_MS, String(r.failure?.idleMs));
}

/* ------------------------------------------------------------------ *
 * 1c. 上游中途断了：Node 自己那句话不许透给客户端
 * ------------------------------------------------------------------ */

// 生产实录就是这一条：`[DELIVER] 发给客户端的错误事件：terminated`。客户端
// 收到的是 `{"type":"error","error":{"message":"terminated"}}` —— 它既不是
// 「哪一类失败」，也不是客户端能处理的东西。
section("上游中途断了（Node 自己那句话）");

for (const [entry, dialect, first] of [
  ["anthropic", "anthropic", anthropicFrame("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } })],
  ["openai", "openai", openaiFrame("hello")],
] as const) {
  const r = await serve({
    source: upstream([first], { after: "raw" }),
    entry,
    dialect,
  });
  const text = r.received.join("\n\n");
  const said = errorMessageOf(r.received);
  check(`[${entry}] 客户端收到了第一帧`, /hello|message_start/.test(text), text.slice(0, 120));
  check(`[${entry}] 客户端收到了一条 error`, said !== "", text.slice(0, 200));
  check(`[${entry}] 那句话是通用的「连接断了」`, said === CLOSED_EARLY, said);
  check(`[${entry}] 整条答复里没有 terminated`, !/terminated/i.test(text), text.slice(0, 200));
  check(`[${entry}] 网关报了上游的错`, r.failure instanceof TypeError, String(r.failure));
}

/* ------------------------------------------------------------------ *
 * 2. 上游一直在吐：量的是两帧之间，不是总时长
 * ------------------------------------------------------------------ */

section("上游一直在吐（每 40ms 一帧，共 10 帧）");

{
  // 整条流跑了 400ms 以上，比空闲上限（150ms）长得多。每两帧之间只有 40ms，
  // 所以一帧都不许丢 —— 按总时长算的话，这条流早就被砍了。
  const frames = Array.from({ length: 10 }, (_, i) => openaiFrame(`w${i}`));
  const r = await serve({
    source: upstream(frames, { gapMs: 40 }),
    entry: "openai",
    dialect: "openai",
  });
  const text = r.received.join("\n\n");
  const said = errorMessageOf(r.received);
  const bodies = r.received.filter((frame) => frame.startsWith("data: {"));
  check("十帧都送到了", bodies.length === 10, `${bodies.length} 帧`);
  check("每一帧的内容都在", frames.every((_, i) => text.includes(`w${i}`)), "");
  check("有收尾的 [DONE]", text.includes("[DONE]"), "");
  check("没有 error 帧", said === "", said);
  check("网关没有报失败", r.failure === null, String(r.failure));
  check("网关没有抛错", r.handlerError === null, r.handlerError ?? "");
}

/* ------------------------------------------------------------------ *
 * 2b. 上游一直在吐（Anthropic 入口，tee 那条路）
 * ------------------------------------------------------------------ */

section("上游一直在吐（Anthropic 入口，tee 那条路，每 40ms 一帧，共 10 帧）");

{
  // 同一条事，走 tee：源头被复制成两支（一支给客户端、一支解 usage），两支
  // 都得读到东西，源头才不会因为没人读而挂在那里。整条流跑 400ms 以上，比
  // 上限（150ms）长得多，每两帧之间只有 40ms —— 一帧都不许丢。
  const events = Array.from({ length: 10 }, (_, i) =>
    anthropicFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: `w${i}` },
    }),
  );
  const r = await serve({
    source: upstream([messageStart(), ...events], { gapMs: 40 }),
    entry: "anthropic",
    dialect: "anthropic",
  });
  const text = r.received.join("\n\n");
  const said = errorMessageOf(r.received);
  check("十帧都送到了", events.every((_, i) => text.includes(`w${i}`)), `${r.received.length} 帧`);
  check("没有 error 事件", said === "", said);
  check("网关没有报失败", r.failure === null, String(r.failure));
  check("网关没有抛错", r.handlerError === null, r.handlerError ?? "");
}

/* ------------------------------------------------------------------ *
 * 3. 上游一帧都不吐：等的是首帧那个上限，头还没发
 * ------------------------------------------------------------------ */

// 「等第一帧」与「流中途停住」是两件事，量它们的是两个值。推理模型的第一个
// token 常常要两分多钟（coder-a 那一类），拿中途那个上限去量等待，一条正常
// 在想的流就会被砍掉。
//
// 而且第一帧没读到的时候，头都没发：这时的错要往外抛，路由层才能换下一个
// 账号或目标（那时客户端拿到的是真实状态，不是 200 里藏一句 error）。
section("上游一帧都不吐（首帧沉默）");

for (const [entry, dialect] of [
  ["anthropic", "anthropic"],
  ["openai", "openai"],
] as const) {
  let cancelled = false;
  const r = await serve({
    source: upstream([], { after: "stall", onCancel: () => (cancelled = true) }),
    entry,
    dialect,
  });
  check(`[${entry}] 一个 SSE 头都没发`, r.flushes === 0, `${r.flushes} 次`);
  check(`[${entry}] 客户端一个帧也没收到`, r.received.length === 0, JSON.stringify(r.received).slice(0, 160));
  check(`[${entry}] 往外抛了（路由层能换目标）`, r.handlerError !== null, String(r.handlerError));
  check(`[${entry}] 上游那一侧被取消了`, cancelled, "上游还挂着");
  check(`[${entry}] 报给调用方的是「超时」`, r.failure?.name === "TimeoutError", String(r.failure?.name));
  check(`[${entry}] 这是首帧那一次超时`, r.failure?.phase === "first-frame", String(r.failure?.phase));
  // 首帧那次用的是**首帧那个上限**（比中途那个长），不是中途那个。
  check(`[${entry}] 等第一帧用的是首帧那个上限`, r.failure?.idleMs === FIRST_FRAME_MS, String(r.failure?.idleMs));
  check(
    `[${entry}] 那句人话说清了在等第一帧`,
    /upstream sent nothing for \d+ms waiting for the first frame/.test(String(r.failure?.message ?? "")),
    String(r.failure?.message),
  );
  check(`[${entry}] 网关在首帧上限之后很快就收工了`, r.handlerMs < 5_000, `用了 ${r.handlerMs}ms`);
}

/* ------------------------------------------------------------------ *
 * 3f. 心跳不是第一帧
 * ------------------------------------------------------------------ */

// SSE 的心跳是一条注释行（`: ping`），有些上游还会偶尔吐一个零长度的块。它们
// 说的是「我还活着」，不是「我开始说话了」。第一帧的额度是按**绝对死线**算的，
// 所以心跳不该把它换成中途那个短窗口 —— 不然一个先发心跳、再慢慢想两百秒才
// 出第一个 token 的流就被砍在中途，首帧那个更长的额度白设。

section("心跳帧与零长度的块都不算第一帧（首帧额度还在用）");

{
  let cancelled = false;
  const source = scriptedUpstream(
    [
      { waitMs: 0, text: ": ping\n\n" },
      { waitMs: 0, text: "" },
      // 这一段沉默比中途那个上限长、比首帧那个短：旧实现下它就会在这里被砍。
      { waitMs: 250, text: openaiFrame("第一句话") },
      { waitMs: 0, text: "data: [DONE]\n\n" },
    ],
    "close",
    () => (cancelled = true),
  );
  const reader = withStreamIdle(source, "model=fake-model", { firstFrameMs: 300, idleMs: 100 }).getReader();
  const decoder = new TextDecoder();
  const got: string[] = [];
  let error: unknown = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) got.push(decoder.decode(value));
    }
  } catch (e) {
    error = e;
  }
  const text = got.join("");
  check("没有超时", error === null, String((error as Error)?.message ?? error));
  check("心跳之后那一帧真的到了", text.includes("第一句话"), text.slice(0, 200));
  check("收尾帧也到了", text.includes("[DONE]"), text.slice(0, 200));
  check("上游没被取消", !cancelled, "心跳之后的沉默被当成安静到上限了");
}

section("首帧是绝对死线：心跳一直不断也不会把死线往后推");

{
  let cancelled = false;
  // 20 次心跳 × 50ms = 1 秒。死线是 200ms，而中途那个上限故意设成 5 秒：
  // 如果每读一块就重新计时，这条流一秒钟都超不了时 —— 那就证明死线是绝对的。
  const steps = Array.from({ length: 20 }, (_, i) => ({
    waitMs: 50,
    text: i % 4 === 0 ? "" : ": ping\n\n",
  }));
  const started = Date.now();
  const reader = withStreamIdle(scriptedUpstream(steps, "stall", () => (cancelled = true)), "model=fake-model", {
    firstFrameMs: 200,
    idleMs: 5_000,
  }).getReader();
  let error: any = null;
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch (e) {
    error = e;
  }
  const waited = Date.now() - started;
  check("超时了", error instanceof StreamIdleError, String(error?.name ?? error));
  check("算的是首帧那一次", error?.phase === "first-frame", String(error?.phase));
  check("用的是首帧那个上限", error?.idleMs === 200, String(error?.idleMs));
  check("死线是绝对的（在 400ms 内就超了，不是每读到心跳重算）", waited < 400, `等了 ${waited}ms`);
  check("上游被取消了", cancelled, "上游还挂着");
}

/* ------------------------------------------------------------------ *
 * 3b. 消费方自己停一会儿不读：慢客户端不是安静的上游
 * ------------------------------------------------------------------ */

section("消费方停一会儿不读（慢客户端不是安静的上游）");

// 计时只在**有 pending read** 的时候才走：消费方自己停着不读的时候，上游没吐
// 下一帧不是它安静，是没人要。默认的 highWaterMark（1）会预取一帧，于是停读
// 期间 `pull` 照样被叫着、计时照样走 —— 慢客户端被当成安静的上游砍掉，连已经
// 缓冲好的帧一起丢。
//
// 这条用例拿 withStreamIdle 包住的流当顶层消费方：在转发链路上量不到这件事
// （peekStream 与写帧循环一直在读，pending read 总是有的），量得到的是这道闸
// 自己的语义。
{
  const frames = Array.from({ length: 5 }, (_, i) => `data: f${i}\n\n`);
  let cancelled = false;
  // 上游的后续帧等消费方回来读：停读期间上游一句话不说（这是「慢客户端 +
  // 上游在想」那个组合），恢复读了立刻给。
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  let sent = 0;
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent >= frames.length) {
        controller.close();
        return;
      }
      if (sent >= 1) await released;
      controller.enqueue(encoder.encode(frames[sent++]));
    },
    cancel() {
      cancelled = true;
    },
  });

  const reader = withStreamIdle(source, "model=fake-model", { idleMs: IDLE_MS, firstFrameMs: FIRST_FRAME_MS }).getReader();
  const decoder = new TextDecoder();
  const got: string[] = [];
  let error: unknown = null;

  const first = await reader.read();
  if (!first.done && first.value) got.push(decoder.decode(first.value));

  // 消费方停 3× 上限：这段时间里没有 pending read，计时不该走。
  await sleep(3 * IDLE_MS);
  check("停着不读的时候上游没被取消", !cancelled, "上游在停读期间被取消了");

  release();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) got.push(decoder.decode(value));
    }
  } catch (e) {
    error = e;
  }

  check("全部帧都读到了", got.length === frames.length, `${got.length}/${frames.length} 帧`);
  check("没有超时", error === null, String((error as Error)?.message ?? error));
  check("上游没被取消", !cancelled, "上游被取消了");
}

/* ------------------------------------------------------------------ *
 * 3c. 首帧就报错：头没发过，路由器能换目标
 * ------------------------------------------------------------------ */

// 头一落地（sseHead 会 flushHeaders），路由层就不可能再换目标了：客户端拿到
// 的是 200 里藏一句 error。生产上 fallback 的第三跳就是这样 —— 首帧 403，
// 客户端却拿到了 200 的错误流（2026-11-04 实录）。
//
// 所以第一帧读成功之前不写头：读不到就往外抛。这里把一个假的路由器演一遍
// （跟 lib/router/handle.ts 一个意思：头没发就换下一个目标，全都失败就答真实
// 状态）。
section("首帧报错：第二个目标接手");

{
  const r = await serveAsRouter([
    { first: "error-frame", words: "上游说不行（第一跳）" },
    { first: "answer", text: "第二个目标的答复" },
  ]);
  const text = r.received.join("\n\n");
  check("客户端拿到 200", r.status === 200, `HTTP ${r.status}`);
  check("两个目标都试过了", r.attempts === 2, `${r.attempts} 次`);
  check("客户端拿到的是第二个目标的完整答复", text.includes("第二个目标的答复"), text.slice(0, 200));
  check("有收尾的 [DONE]", text.includes("[DONE]"), text.slice(0, 200));
  check("答复里没有第一个目标那句话", !text.includes("上游说不行"), text.slice(0, 200));
  check("没有 error 帧", errorMessageOf(r.received) === "", errorMessageOf(r.received));
  // 硬约束：头只许发一次。第二次 sseHead 就是 ERR_HTTP_HEADERS_SENT（那一下
  // 会把一条已经开始的答复变成一个 500）。
  check("头只写了一次", r.flushes === 1, `${r.flushes} 次`);
  check("网关没有抛错", r.handlerError === null, r.handlerError ?? "");
}

section("首帧就是连接断（上游在吐第一帧之前就断了）");

{
  const r = await serveAsRouter([
    { first: "raw" },
    { first: "answer", text: "第二个目标的答复" },
  ]);
  const text = r.received.join("\n\n");
  check("客户端拿到 200", r.status === 200, `HTTP ${r.status}`);
  check("客户端拿到的是第二个目标的答复", text.includes("第二个目标的答复"), text.slice(0, 200));
  check("头只写了一次", r.flushes === 1, `${r.flushes} 次`);
  check("那句话里没有 terminated", !/terminated/i.test(text), text.slice(0, 200));
}

section("整条链首帧都失败：真实状态码与上游原话");

{
  const r = await serveAsRouter([
    { first: "error-frame", words: "第一跳说不行" },
    { first: "error-frame", words: "第二跳也说不行" },
  ]);
  check("客户端拿到的不是 200", r.status !== 200, `HTTP ${r.status}`);
  check("客户端拿到的是 502（上游拒绝）", r.status === 502, `HTTP ${r.status}`);
  // 一个 SSE 头都没写过：这才是「客户端拿到的是真实状态」的意思。
  check("一个 SSE 头都没写", r.flushes === 0, `${r.flushes} 次`);
  check("客户端拿到的不是事件流", !r.contentType.includes("text/event-stream"), r.contentType);
  check("两个目标都试过了", r.attempts === 2, `${r.attempts} 次`);
  // 上游原话不能丢：它才是「为什么拒」。
  const body = r.received.join("\n\n") || r.text;
  let json: any = null;
  try {
    json = JSON.parse(body);
  } catch {
    /* not JSON */
  }
  const said = String(json?.hint ?? "");
  // hint 说的是最后那一个目标的原话（真实的路由层会把每一个都拼进去，见
  // handle.ts 的 summarizeFailures）；这里断言两件事：每一个目标自己的错误都
  // 带着它自己那句原话，而且客户端拿到的答复里看得到上游原话。
  const errors = r.errors;
  check(
    "每个目标自己的错都带着它自己那句原话",
    errors.length === 2 &&
      String(errors[0]?.hint ?? "").includes("第一跳说不行") &&
      String(errors[1]?.hint ?? "").includes("第二跳也说不行"),
    JSON.stringify(errors.map((e) => e?.hint)),
  );
  check("答复里带着上游原话", said.includes("第二跳也说不行"), said || body.slice(0, 200));
  check("答复里没有 terminated", !/terminated/i.test(body), body.slice(0, 200));
  // 答复一个字都没写就往外抛的时候，响应从来没被接管过：它还是 Koa 的，
  // sendError 写的 `ctx.body` 才会落到 socket 上。接管早了（读第一帧之前就
  // 设成 `respond = false`），客户端只能等到超时。
  check("客户端真的收到了答复（响应没被提前接管）", body.trim() !== "", body.slice(0, 160));
}

section("首帧沉默：换目标，不是写 error 帧");

// 与上面的第 1 节对照着看：同样的「安静」，发生在第一帧之前是能换目标的，
// 发生在中途就只能写一条 error 帧。两条必须分别成立。
{
  const r = await serveAsRouter([
    { first: "silent" },
    { first: "answer", text: "第二个目标的答复" },
  ]);
  const text = r.received.join("\n\n");
  check("客户端拿到 200", r.status === 200, `HTTP ${r.status}`);
  check("第二个目标接手了", text.includes("第二个目标的答复"), text.slice(0, 200));
  check("没有 error 帧", errorMessageOf(r.received) === "", errorMessageOf(r.received));
  check("头只写了一次", r.flushes === 1, `${r.flushes} 次`);
  check("那一次失败是首帧超时", r.lastError?.phase === "first-frame", String(r.lastError?.phase));
  check("首帧超时用的是首帧那个上限", r.lastError?.idleMs === FIRST_FRAME_MS, String(r.lastError?.idleMs));
}

/* ------------------------------------------------------------------ *
 * 3d. 旧协议那个入口（AsyncIterable）
 * ------------------------------------------------------------------ */

// qoder 旧协议走的是 deliverOpenAIChunks：上游给的是已经解析好的帧，不是字节
// 流，但「第一帧读不到就不发头」是同一件事。
section("旧协议入口：首帧读不到就不发头");

{
  const r = await serveAsRouter(
    [
      { first: "raw" },
      { first: "answer", text: "第二个目标的答复" },
    ],
    "chunks",
  );
  const text = r.received.join("\n\n");
  check("客户端拿到 200", r.status === 200, `HTTP ${r.status}`);
  check("第二个目标接手了", text.includes("第二个目标的答复"), text.slice(0, 200));
  check("头只写了一次", r.flushes === 1, `${r.flushes} 次`);
  check("没有 error 帧", errorMessageOf(r.received) === "", errorMessageOf(r.received));
}

{
  const r = await serveAsRouter([{ first: "error-frame", words: "旧协议第一帧就报错" }], "chunks");
  check("整条链首帧就失败：客户端拿到的不是 200", r.status !== 200, `HTTP ${r.status}`);
  check("客户端拿到的是 502", r.status === 502, `HTTP ${r.status}`);
  check("一个 SSE 头都没写", r.flushes === 0, `${r.flushes} 次`);
  const body = r.text;
  check("答复里带着上游原话", body.includes("旧协议第一帧就报错"), body.slice(0, 200));
}

/* ------------------------------------------------------------------ *
 * 3d2. 旧协议那个入口也有首帧超时
 * ------------------------------------------------------------------ */

// 以前这条路上一点计时都没有，只靠 undici 那个 5 分钟的 bodyTimeout 兼底：
// 客户端干等五分钟，最后收到的是 Node 自己那句 `terminated`。三个入口该是
// 一套东西（见 withIteratorIdle）。

section("旧协议入口：首帧也会超时，并且把上游还回去");

{
  let returned = false;
  // 一条永远不说第一句话的上游。`return` 记下来：超时之后上游那条流得收掉
  // （不收就还挂着、还占着账号）。
  const silent: AsyncIterable<any> = {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<any>>(() => {}),
      return: async () => {
        returned = true;
        return { done: true, value: undefined };
      },
    }),
  };
  const r = await serve({ iterable: silent, entry: "chunks", dialect: "openai" });
  check("报的是首帧超时", r.thrown instanceof StreamIdleError, String(r.thrown?.name ?? r.thrown));
  check("算的是首帧那一次", r.thrown?.phase === "first-frame", String(r.thrown?.phase));
  check("用的是首帧那个上限", r.thrown?.idleMs === FIRST_FRAME_MS, String(r.thrown?.idleMs));
  check("一个 SSE 头都没发（路由层还能换目标）", r.flushes === 0, `${r.flushes} 次`);
  check("上游那一侧被收掉了", returned, "没调 return");
  check(
    "在那句人话里没有 terminated",
    !/terminated/i.test(String(r.thrown?.message ?? "")),
    String(r.thrown?.message),
  );
  check("没在首帧上限之后多等", r.handlerMs < 5_000, `用了 ${r.handlerMs}ms`);
}

// 控制组：首帧正常的时候一帧不少（计时不能把正常的流吃成一条 error）。
{
  const r = await serveAsRouter([{ first: "answer", text: "旧协议的正文" }], "chunks");
  const text = r.received.join("\n\n");
  check("控制组：客户端拿到 200", r.status === 200, `HTTP ${r.status}`);
  check("控制组：正文到了", text.includes("旧协议的正文"), text.slice(0, 200));
  check("控制组：收尾帧也到了", text.includes("[DONE]"), text.slice(0, 200));
  check("控制组：三帧一帧不少", r.received.length === 3, `${r.received.length} 帧`);
  check("控制组：没有 error 帧", errorMessageOf(r.received) === "", errorMessageOf(r.received));
}

/* ------------------------------------------------------------------ *
 * 3e. 空答复：头照发，只有收尾帧
 * ------------------------------------------------------------------ */

// 第一帧读不到就抛，但「上游一个字不说就结束了」不是失败：那是一份空答复。
// 这个行径没有变（它一直是 200 + [DONE]），别因为改了吞错方式就把它弄成了失败。
section("空答复：不是失败");

{
  const r = await serveAsRouter([{ first: "empty" }]);
  const text = r.received.join("\n\n");
  check("客户端拿到 200", r.status === 200, `HTTP ${r.status}`);
  check("头写了", r.flushes === 1, `${r.flushes} 次`);
  check("有收尾的 [DONE]", text.includes("[DONE]"), text.slice(0, 160));
  check("没有 error 帧", errorMessageOf(r.received) === "", errorMessageOf(r.received));
  check("没有往下一目标跑", r.attempts === 1, `${r.attempts} 次`);
}

{
  const r = await serveAsRouter([{ first: "empty" }], "chunks");
  const text = r.received.join("\n\n");
  check("[旧协议] 客户端拿到 200", r.status === 200, `HTTP ${r.status}`);
  check("[旧协议] 头写了", r.flushes === 1, `${r.flushes} 次`);
  check("[旧协议] 有收尾的 [DONE]", text.includes("[DONE]"), text.slice(0, 160));
  check("[旧协议] 没有 error 帧", errorMessageOf(r.received) === "", errorMessageOf(r.received));
}

/* ------------------------------------------------------------------ *
 * 3f. 「第一块内容」这道闸：换目标的判据从第一块字节改成第一块内容
 * ------------------------------------------------------------------ */

// 以前头在收到第一块字节时就发了 —— Anthropic 的 message_start 几乎立刻就到，
// 可它只是信封，客户端一个字内容都没收到，路由层已经没有换目标的机会。现在
// 信封扣住，等第一块对用户可见的内容；内容之前上游失败或静默，原样抛出换目标。

section("A. 首个目标只发信封就闭嘴：换目标");

{
  const r = await serveAsRouter(
    [
      { first: "envelope-stall" },
      { first: "answer", text: "第二个目标的答复" },
    ],
    "anthropic",
  );
  const text = r.received.join("\n\n");
  check("客户端拿到 200", r.status === 200, `HTTP ${r.status}`);
  check("两个目标都试过了", r.attempts === 2, `${r.attempts} 次`);
  check("客户端拿到的是第二个目标的答复", text.includes("第二个目标的答复"), text.slice(0, 200));
  const starts = r.received.filter((frame) => frame.startsWith("event: message_start"));
  check("客户端只收到一份 message_start", starts.length === 1, `${starts.length} 份`);
  check("没有 error 事件", errorMessageOf(r.received) === "", errorMessageOf(r.received));
  check("头只写了一次", r.flushes === 1, `${r.flushes} 次`);
  check("第一个目标确实被读了（报的是中途超时）", r.errors[0] instanceof StreamIdleError, String(r.errors[0]?.name ?? r.errors[0]));
}

section("B. 首个目标发了内容再闭嘴：不换目标");

{
  const r = await serveAsRouter([{ first: "content-stall", text: "第一句话" }], "anthropic");
  const text = r.received.join("\n\n");
  check("客户端拿到了内容", text.includes("第一句话"), text.slice(0, 200));
  check("客户端收到了一条 error 事件", text.includes("event: error"), text.slice(0, 200));
  check("没有换目标（只试了一次）", r.attempts === 1, `${r.attempts} 次`);
  check("头只写了一次", r.flushes === 1, `${r.flushes} 次`);
}

section("C. OpenAI：role-only 的 delta 不算内容");

{
  // role-only 再闭嘴 → 换目标
  const r1 = await serveAsRouter([
    { first: "envelope-stall" },
    { first: "answer", text: "第二个目标的答复" },
  ]);
  const text1 = r1.received.join("\n\n");
  check("[role-only] 换目标了", r1.attempts === 2, `${r1.attempts} 次`);
  check("[role-only] 客户端拿到的是第二个目标的答复", text1.includes("第二个目标的答复"), text1.slice(0, 200));
  check("[role-only] 没有 error 帧", errorMessageOf(r1.received) === "", errorMessageOf(r1.received));
  check("[role-only] 头只写了一次", r1.flushes === 1, `${r1.flushes} 次`);

  // 发了 content delta 再闭嘴 → 不换目标
  const r2 = await serveAsRouter([{ first: "content-stall", text: "第一句话" }]);
  const text2 = r2.received.join("\n\n");
  check("[content] 没有换目标", r2.attempts === 1, `${r2.attempts} 次`);
  check("[content] 客户端拿到了内容", text2.includes("第一句话"), text2.slice(0, 200));
  check("[content] 客户端收到了 error 帧", errorMessageOf(r2.received) !== "", errorMessageOf(r2.received));
}

section("D. 扣住的信封在内容到来时逐字节写出去");

{
  const source = upstream([
    anthropicFrame("message_start", {
      type: "message_start",
      message: {
        id: "msg_upstream",
        type: "message",
        role: "assistant",
        model: "upstream-model",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    }),
    'event: ping\ndata: {"type":"ping"}\n\n',
    anthropicFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "正文内容" },
    }),
    anthropicFrame("message_stop", { type: "message_stop" }),
  ]);
  const r = await serve({ source, entry: "anthropic", dialect: "anthropic" });
  const text = r.received.join("\n\n");
  check("message_start 的 model 名改成了客户端问的那个", text.includes('"model":"fake-model"'), text.slice(0, 200));
  check("上游的模型名没有漏出去", !text.includes("upstream-model"), text.slice(0, 200));
  const startIdx = text.indexOf("message_start");
  const pingIdx = text.indexOf('"type":"ping"');
  const contentIdx = text.indexOf("正文内容");
  check("message_start 在 ping 之前", startIdx >= 0 && pingIdx >= 0 && startIdx < pingIdx, `start=${startIdx} ping=${pingIdx}`);
  check("ping 在内容之前", pingIdx >= 0 && contentIdx >= 0 && pingIdx < contentIdx, `ping=${pingIdx} content=${contentIdx}`);
  check("内容在 message_stop 之前", contentIdx >= 0 && text.indexOf("message_stop") > contentIdx, `content=${contentIdx}`);
  check("网关没有抛错", r.handlerError === null, r.handlerError ?? "");
  check("没有 error 事件", errorMessageOf(r.received) === "", errorMessageOf(r.received));
}

section("E. 只有心跳一直发：不算内容，仍可换目标");

{
  const r = await serveAsRouter(
    [
      { first: "ping-stall" },
      { first: "answer", text: "第二个目标的答复" },
    ],
    "anthropic",
  );
  const text = r.received.join("\n\n");
  check("换目标了", r.attempts === 2, `${r.attempts} 次`);
  check("客户端拿到的是第二个目标的答复", text.includes("第二个目标的答复"), text.slice(0, 200));
  check("没有 error 事件", errorMessageOf(r.received) === "", errorMessageOf(r.received));
  check("头只写了一次", r.flushes === 1, `${r.flushes} 次`);
}

/* ------------------------------------------------------------------ *
 * E2. 中途只有心跳：上游一直在发 ping，答复不往前走
 * ------------------------------------------------------------------ */

// 这条是「44 分钟、0 token」那个现象的最小复现：上游每分钟吐一条 `event: ping`
// （Anthropic 方言的心跳，不是 SSE 注释行），正文一个字不出。心跳说的是「连接还
// 在」，不是「答复在往前走」，所以它不许把中途那个窗口往后推。
section("E2. 中途只有心跳：到窗口就报静默，不许被 ping 续命");

{
  const enc = new TextEncoder();
  const content = `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`;
  const ping = `event: ping\ndata: {"type":"ping"}\n\n`;
  let cancelled = false;
  let sentContent = false;
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!sentContent) {
        sentContent = true;
        controller.enqueue(enc.encode(content));
        return;
      }
      // 从那以后只有心跳：每 30ms 一条，永远不停。
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      controller.enqueue(enc.encode(ping));
    },
    cancel() {
      cancelled = true;
    },
  });

  const gated = withStreamIdle(source, "model=ping-storm", { firstFrameMs: 5000, idleMs: 150 }, "openai");
  const started = Date.now();
  let error: unknown = null;
  let bytes = 0;
  const reader = gated.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
    }
  } catch (e) {
    error = e;
  }
  const span = Date.now() - started;

  check("没有正常结束（静默到点）", error !== null, "流自己结束了");
  check(
    "报的是中途静默",
    error instanceof StreamIdleError && error.phase === "mid-stream",
    String((error as Error | null)?.message ?? error),
  );
  check("很快就到点（不是被心跳一直续命）", span < 2000, `${span}ms`);
  check("上游被取消了", cancelled);
  // 心跳帧不是内容：既然静默被判定为「没在往前走」，那它一次也不该被当成进度。
  // 具体字节数取决于到点那一刻已经流过几条 ping，所以只钉「没有刷出一大堆」。
  check("只流过正文和几条心跳就被砍了", bytes > 0 && bytes < 600, `${bytes} 字节`);
}

{
  // 对照组：同样慢，但每一块都是真内容（thinking），就不该被砍。
  const enc = new TextEncoder();
  const thinking = (text: string): string =>
    `data: {"choices":[{"delta":{"reasoning_content":"${text}"}}]}\n\n`;
  let n = 0;
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (n >= 6) {
        controller.close();
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      controller.enqueue(enc.encode(thinking(`想法${n++}`)));
    },
  });
  const gated = withStreamIdle(source, "model=thinking-drip", { firstFrameMs: 5000, idleMs: 150 }, "openai");
  let error: unknown = null;
  let chunks = 0;
  const reader = gated.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks++;
    }
  } catch (e) {
    error = e;
  }
  check("[对照组] 思考一直在滴就不算静默", error === null, String((error as Error | null)?.message ?? ""));
  check("[对照组] 六块都到了", chunks === 6, `${chunks} 块`);
}

{
  // 对照组：role-only 与空 delta 也不算往前走（它们是「我在」，不是内容）。
  const enc = new TextEncoder();
  const roleOnly = `data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n`;
  const emptyDelta = `data: {"choices":[{"delta":{}}]}\n\n`;
  let n = 0;
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      controller.enqueue(enc.encode(n++ % 2 === 0 ? roleOnly : emptyDelta));
    },
  });
  const gated = withStreamIdle(source, "model=role-only", { firstFrameMs: 5000, idleMs: 150 }, "openai");
  let error: unknown = null;
  const reader = gated.getReader();
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch (e) {
    error = e;
  }
  check("role-only 与空 delta 也算静默", error instanceof StreamIdleError && error.phase === "mid-stream", String(error));
}
/* ------------------------------------------------------------------ *
 * 4. clientMessageOf 的判别力
 * ------------------------------------------------------------------ */

section("clientMessageOf：发给客户端的那句话");

{
  // Node fetch 内部的那句话：客户端看不懂，也不该看到。
  check("TypeError(\"terminated\") → 通用人话", clientMessageOf(new TypeError("terminated")) === CLOSED_EARLY);
  check(
    "fetch failed → 通用人话",
    clientMessageOf(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "UND_ERR_SOCKET" }) })) ===
      CLOSED_EARLY,
  );
  check(
    "cause 上的 UND_ERR_* → 通用人话",
    clientMessageOf(Object.assign(new Error("boom"), { cause: { code: "UND_ERR_BODY_TIMEOUT" } })) === CLOSED_EARLY,
  );
  check("socket hang up → 通用人话", clientMessageOf(new Error("socket hang up")) === CLOSED_EARLY);
  // 我们自己的空闲超时：它那句话本来就是写给客户端的。
  const idle = new StreamIdleError(IDLE_MS, "model=fake-model", "mid-stream");
  check("空闲超时 → 它自己那句", clientMessageOf(idle) === idle.message, clientMessageOf(idle));
  check("空闲超时那句里没有 terminated", !/terminated/i.test(idle.message), idle.message);
  check("空闲超时的 name 是 TimeoutError", idle.name === "TimeoutError", idle.name);
  check("中途超时那句说 mid-stream", /mid-stream/.test(idle.message), idle.message);
  check(
    "首帧超时那句说 waiting for the first frame",
    /waiting for the first frame/.test(new StreamIdleError(FIRST_FRAME_MS, "model=m", "first-frame").message),
    new StreamIdleError(FIRST_FRAME_MS, "model=m", "first-frame").message,
  );
  // 别的错误：既有行为不变，原样发出去。
  check(
    "上游拒绝的话原样",
    clientMessageOf(new Error("upstream rejected the request")) === "upstream rejected the request",
  );
  check("空的 message 不会发出 undefined", clientMessageOf({}) === "upstream failed", clientMessageOf({}));

  // 抛出来的可以就是个字符串（`throw "socket hang up"`）：那时没有 message，
  // 按以前那样直接落到回落值就把原文丢了 —— 而原文往往是唯一的线索。
  check("抛字符串：内部字眼翻成人话", clientMessageOf("socket hang up") === CLOSED_EARLY, clientMessageOf("socket hang up"));
  check(
    "抛字符串：terminated 也翻",
    clientMessageOf("terminated") === CLOSED_EARLY,
    clientMessageOf("terminated"),
  );
  check("抛字符串：原文不是内部字眼就照发", clientMessageOf("quota exhausted") === "quota exhausted", clientMessageOf("quota exhausted"));

  // 空白不是一句话：`new Error("  ")` 不该让客户端收到一个空格。
  check("只有空白的 message → 回落值", clientMessageOf(new Error("   ")) === "upstream failed", `"${clientMessageOf(new Error("   "))}"`);
  check("只有空白的字符串 → 回落值", clientMessageOf("  ") === "upstream failed", `"${clientMessageOf("  ")}"`);
  check(
    "message 两边的空白不再发出去",
    clientMessageOf(new Error("  boom  ")) === "boom",
    `"${clientMessageOf(new Error("  boom  "))}"`,
  );
}

/* ------------------------------------------------------------------ *
 * 5. 生产默认值
 * ------------------------------------------------------------------ */

section("生产默认值：等首帧 5 分钟，中途沉默 3 分钟");

// 这条测试的进程把两个上限都调短了，所以默认值只能从模块导出的那两个常量
// 确认。调错的默认值比没有还糟：首帧那个太短，一条 thinking 的流会被砍在
// 中间；太长，一条真的挂住的请求要等更久才换目标。
check("等首帧的默认值是 300000ms", STREAM_FIRST_FRAME_DEFAULT_MS === 300_000, String(STREAM_FIRST_FRAME_DEFAULT_MS));
check("中途沉默的默认值是 180000ms", STREAM_IDLE_DEFAULT_MS === 180_000, String(STREAM_IDLE_DEFAULT_MS));
check(
  "等第一帧比中途沉默等得久",
  STREAM_FIRST_FRAME_DEFAULT_MS > STREAM_IDLE_DEFAULT_MS,
  `${STREAM_FIRST_FRAME_DEFAULT_MS} vs ${STREAM_IDLE_DEFAULT_MS}`,
);

/* ------------------------------------------------------------------ *
 * 6. 两个上限设成 0：闸关掉
 * ------------------------------------------------------------------ */

section("两个上限设成 0：闸关掉");

// 0 是「关闸」：生产旋钮的契约，得钉住。两个值各管各的上限。上限在模块求值时
// 读一次，所以只能换个进程跑。同时钉住那两句 warn：闸被关掉不能是悄悄的。
{
  const deliverUrl = new URL("../lib/router/deliver.ts", import.meta.url).href;
  const CHILD = `
const http = await import("node:http");
const { deliverOpenAIStream } = await import(process.env.DELIVER_URL);
const MODE = process.env.MODE;
let cancelled = false;
let failure = null;
let writes = 0;
let sawErrorFrame = false;
let flushes = 0;
let started = false;
let threw = null;
let sent = false;
const body = new ReadableStream({
  async pull(controller) {
    // ONE：先吐一帧，然后就安静（中途停住那条）。
    if (MODE === "ONE" && !sent) {
      sent = true;
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\\n\\n'));
      return;
    }
    // NEVER（默认）：一帧都不吐。
    await new Promise(() => {});
  },
  cancel() { cancelled = true; },
});
const server = http.default.createServer(async (_req, res) => {
  const ctx = { res, status: 200, respond: false };
  const write = res.write.bind(res);
  res.write = (chunk, ...rest) => {
    writes++;
    if (String(chunk).includes('"error"')) sawErrorFrame = true;
    return write(chunk, ...rest);
  };
  const flush = res.flushHeaders.bind(res);
  res.flushHeaders = () => { flushes++; return flush(); };
  started = true;
  try {
    await deliverOpenAIStream(ctx, body, "openai", "fake-model", undefined, undefined, (e) => { failure = e; });
  } catch (e) {
    threw = String(e && e.name ? e.name : e);
  }
});
await new Promise((resolve) => server.listen(0, resolve));
const client = http.default.request({ port: server.address().port, host: "127.0.0.1", path: "/", method: "POST" });
client.on("error", () => {});
client.end("{}");
while (!started) await new Promise((resolve) => setTimeout(resolve, 5));
await new Promise((resolve) => setTimeout(resolve, 3 * ${IDLE_MS}));
console.log("CHILD " + JSON.stringify({
  writes,
  flushes,
  sawErrorFrame,
  threw,
  cancelled,
  failure: failure ? String(failure.name) : null,
  phase: failure && failure.phase ? String(failure.phase) : null,
}));
server.closeAllConnections?.();
server.close();
process.exit(0);
`;

  const runChild = (opts: { mode: "NEVER" | "ONE"; idleMs: number; firstFrameMs: number }) =>
    new Promise<{ report: any; stderr: string; code: number | null }>((resolve) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", CHILD], {
        env: {
          ...process.env,
          DELIVER_URL: deliverUrl,
          MODE: opts.mode,
          ROUTER_STREAM_IDLE_MS: String(opts.idleMs),
          ROUTER_FIRST_FRAME_MS: String(opts.firstFrameMs),
          FACADE_DATA_DIR: tmp,
        },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (c) => (out += c.toString()));
      child.stderr.on("data", (c) => (err += c.toString()));
      child.on("close", (code) => {
        const line = out.split("\n").find((l) => l.startsWith("CHILD "));
        let report: any = null;
        if (line) {
          try {
            report = JSON.parse(line.slice("CHILD ".length));
          } catch {
            report = null;
          }
        }
        resolve({ report, stderr: err, code });
      });
      // 挂住的子进程不许把整条测试吊住。
      setTimeout(() => child.kill(), 20_000).unref?.();
    });

  const off = await runChild({ mode: "NEVER", idleMs: 0, firstFrameMs: 0 });
  check("子进程正常退出了", off.code === 0, `exit ${off.code}：${off.stderr.slice(0, 300)}`);
  check("一帧都没写（没有 error 帧）", off.report?.writes === 0, String(off.report?.writes));
  check("一个头也没发", off.report?.flushes === 0, String(off.report?.flushes));
  check("网关没有报超时", off.report?.failure === null, String(off.report?.failure));
  check("上游没被取消", off.report?.cancelled === false, String(off.report?.cancelled));
  check("关中途那道闸时打了一行 warn", off.stderr.includes("空闲上限被设成 0"), off.stderr.slice(0, 300));
  check("关首帧那道闸时也打了一行 warn", off.stderr.includes("首帧上限被设成 0"), off.stderr.slice(0, 300));

  // 控制组一：上游吐一帧然后安静，中途那道闸 150ms —— 它就该写一条 error 帧
  // （头那时已经发了）。没有这一组，上面那几张 ok 只能证明「什么都没发生」。
  const mid = await runChild({ mode: "ONE", idleMs: IDLE_MS, firstFrameMs: 60_000 });
  check("控制组（中途）：报的是超时", mid.report?.failure === "TimeoutError", String(mid.report?.failure));
  check("控制组（中途）：报的是中途那一次", mid.report?.phase === "mid-stream", String(mid.report?.phase));
  check("控制组（中途）：客户端收到了一条 error 帧", mid.report?.sawErrorFrame === true, String(mid.report?.sawErrorFrame));
  check("控制组（中途）：头发过一次（第一帧就到了）", mid.report?.flushes === 1, String(mid.report?.flushes));
  check("控制组（中途）：上游被取消了", mid.report?.cancelled === true, String(mid.report?.cancelled));

  // 控制组二：上游一帧都不吐，首帧那道闸 150ms、中途那道 60s —— 报的必须是
  // 首帧那一次，而且没发过头（头没发，路由器才能换目标）。
  const first = await runChild({ mode: "NEVER", idleMs: 60_000, firstFrameMs: IDLE_MS });
  check("控制组（首帧）：报的是超时", first.report?.failure === "TimeoutError", String(first.report?.failure));
  check("控制组（首帧）：报的是首帧那一次", first.report?.phase === "first-frame", String(first.report?.phase));
  check("控制组（首帧）：一个头也没发", first.report?.flushes === 0, String(first.report?.flushes));
  check("控制组（首帧）：一帧也没写", first.report?.writes === 0, String(first.report?.writes));
  check("控制组（首帧）：往外抛了（能换目标）", first.report?.threw === "TimeoutError", String(first.report?.threw));
  check("控制组（首帧）：上游被取消了", first.report?.cancelled === true, String(first.report?.cancelled));
}

section("流中途静默之后：用量表要记失败，不能记成 200 的成功");

// 这一条走完整的路由与记账链：开放平台指向本机假上游，上游吐一帧就再也不说话。
// 与前面几段直接调 deliver 不同，这里要看的是 callUpstream 写进 usage_event 的那一行。
/** 这个假上游一共被叫了几次：第二次走「工具在途」的剧本。 */
let idleRequests = 0;
const idleUpstream = http.createServer((req, res) => {
  if (!req.url?.endsWith("/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end("{}");
    return;
  }
  // 请求正文要读掉：不然 'end' 不会来。
  req.resume();
  req.on("end", () => {
    // 第二次请求走另一种剧本：正文之后再来一个工具开局帧，参数一个字节都不来。
    idleRequests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-idle",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant", content: "hello" } }],
      })}\n\n`,
    );
    if (idleRequests > 1) {
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-idle",
          object: "chat.completion.chunk",
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [{ index: 0, id: "call_idle", type: "function", function: { name: "read", arguments: "" } }],
              },
            },
          ],
        })}\n\n`,
      );
    }
    // 故意不 res.end()：剩余的字节由中途那个上限收尾。
  });
});
await new Promise<void>((resolve) => idleUpstream.listen(0, "127.0.0.1", resolve));
const idlePort = (idleUpstream.address() as { port: number }).port;

const { createOpenPlatform, syncPlatformModels } = await import("../lib/open-platforms.ts");
const { addAccount } = await import("../lib/providers.ts");
const { writeOpenPlatformKey } = await import("../lib/open-platform-credentials.ts");
const { handle } = await import("../lib/router/handle.ts");
const { closeStore } = await import("../lib/store.ts");

const idleModel = "idle-open-model";
const madePlatform = createOpenPlatform({
  id: "idle-open",
  label: "Idle Fake",
  baseUrl: `http://127.0.0.1:${idlePort}/v1`,
});
check("假开放平台建好了", madePlatform.ok === true, madePlatform.message);
syncPlatformModels("idle-open", [idleModel]);
const madeAccount = addAccount({ platform: "idle-open" });
check("假账号建好了", madeAccount.ok === true && typeof madeAccount.id === "string", madeAccount.message);
if (madeAccount.ok && madeAccount.id) writeOpenPlatformKey(madeAccount.id, "sk-idle-fake"); // privacy:allow — 编造的样例

/** 每次请求收工时叫一个：等它的人各自挂一个。 */
const routeWaiters: Array<() => void> = [];
const routeServer = http.createServer(async (_req, res) => {
  const ctx = fakeCtx(res) as Parameters<typeof handle>[0];
  ctx.request = {
    body: {
      model: idleModel,
      stream: true,
      messages: [{ role: "user", content: "hello" }],
    },
    headers: {},
  } as Parameters<typeof handle>[0]["request"];
  try {
    await handle(ctx, "openai", "idle-open");
  } finally {
    routeWaiters.shift()?.();
  }
});
await new Promise<void>((resolve) => routeServer.listen(0, "127.0.0.1", resolve));
const routePort = (routeServer.address() as { port: number }).port;
const clientDone = new Promise<void>((resolve) => {
  const req = http.request({ port: routePort, host: "127.0.0.1", path: "/", method: "POST" }, (r) => {
    r.resume();
    r.on("end", resolve);
    r.on("close", resolve);
    r.on("error", resolve);
  });
  req.on("error", resolve);
  req.end("{}");
});
const firstRouteDone = new Promise<void>((resolve) => routeWaiters.push(resolve));
await Promise.race([firstRouteDone, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
await Promise.race([clientDone, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);

const usageDb = new DatabaseSync(path.join(tmp, "agentfacade.db"), { readOnly: true });
type IdleUsageRow = {
  ok: number;
  status: number;
  error: string;
  upstream_id: string;
  agent_model: string;
};
const usageRows = usageDb
  .prepare(
    "SELECT ok, status, error, upstream_id, agent_model FROM usage_event " +
      "WHERE upstream_id = ? AND agent_model = ? ORDER BY id DESC",
  )
  .all("idle-open", idleModel) as IdleUsageRow[];
const tableHead =
  usageRows.length === 1
    ? []
    : (usageDb.prepare("SELECT * FROM usage_event ORDER BY id DESC LIMIT 5").all() as Record<string, unknown>[]);
usageDb.close();
check(
  "用量表里恰好一条属于这次请求的记录",
  usageRows.length === 1,
  JSON.stringify({ matched: usageRows, tableHead }),
);
const usageRow = usageRows[0];
check("这条没记成成功", usageRow?.ok === 0, String(usageRow?.ok));
check("状态是 504（超时），不是 500", usageRow?.status === 504, String(usageRow?.status));
check("原因说清了是流中途静默", String(usageRow?.error).includes("sent nothing"), String(usageRow?.error));
check("原因不是选路停下来的壳", !String(usageRow?.error).includes("the selection stopped"), String(usageRow?.error));

// 同一条链上的另一种失败：正文已经到客户端（提交点过去了），工具调用在途又静默。
// 记账那一行必须是「失败 + 504」：可重试的超时，不是「上游挂了」。
setToolOpeningMs(60);
{
  const secondRouteDone = new Promise<void>((resolve) => routeWaiters.push(resolve));
  const secondClientDone = new Promise<void>((resolve) => {
    const req = http.request({ port: routePort, host: "127.0.0.1", path: "/", method: "POST" }, (r) => {
      r.resume();
      r.on("end", resolve);
      r.on("close", resolve);
      r.on("error", resolve);
    });
    req.on("error", resolve);
    req.end("{}");
  });
  await Promise.race([secondRouteDone, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  await Promise.race([secondClientDone, new Promise<void>((resolve) => setTimeout(resolve, 1_000))]);

  const toolDb = new DatabaseSync(path.join(tmp, "agentfacade.db"), { readOnly: true });
  const toolRows = toolDb
    .prepare("SELECT ok, status, error FROM usage_event WHERE upstream_id = ? AND agent_model = ? ORDER BY id DESC")
    .all("idle-open", idleModel) as IdleUsageRow[];
  toolDb.close();
  const toolRow = toolRows[0];
  check("工具在途静默也记了一条（连上前面那条共两条）", toolRows.length === 2, `${toolRows.length} 条`);
  check("工具在途静默没记成成功", toolRow?.ok === 0, String(toolRow?.ok));
  check("工具在途静默记的是 504（超时），不是 500", toolRow?.status === 504, String(toolRow?.status));
  check(
    "工具在途静默的原因说清了是工具还在写",
    String(toolRow?.error).includes("tool call was still being written"),
    String(toolRow?.error),
  );
  setToolOpeningMs(0);
}

routeServer.closeAllConnections?.();
routeServer.close();
idleUpstream.closeAllConnections?.();
idleUpstream.close();

section("F. 工具调用的开局帧不算内容");

/** 一条 OpenAI 的 SSE 帧；帧里的 delta 由调用方给。 */
function openaiSseFrame(delta: Record<string, unknown>, finish: string | null = null): string {
  return (
    "data: " +
    JSON.stringify({
      id: "c1",
      object: "chat.completion.chunk",
      model: "fake-model",
      choices: [{ index: 0, delta, finish_reason: finish }],
    }) +
    "\n\n"
  );
}

/** 一条 Anthropic 的 tool_use 开局块。 */
function anthropicToolStart(input: Record<string, unknown>): string {
  return anthropicFrame("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_1", name: "read", input },
  });
}

/** 收帧时分隔符已经被切掉了，比较前也把它从期望帧上摘掉。 */
const withoutSep = (frame: string) => frame.replace(/\n\n$/, "");
const roleOnly = openaiSseFrame({ role: "assistant" });
const toolOpening = (args: string) =>
  openaiSseFrame({
    role: "assistant",
    tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: args } }],
  });

{
  // a. OpenAI：开局帧之后长时间静默 —— 提交点没到，上层还能换目标
  const r = await serveAsRouter([
    { first: "raw-frames-stall", frames: [roleOnly + toolOpening("")] },
    { first: "answer", text: "第二个目标的答复" },
  ]);
  const text = r.received.join("\n\n");
  check("[a OpenAI 开局帧静默] 换目标了", r.attempts === 2, `${r.attempts} 次`);
  check("[a OpenAI 开局帧静默] 客户端没拿到半个工具调用", !text.includes("call_1") && !text.includes("tool_calls"), text.slice(0, 200));
  check("[a OpenAI 开局帧静默] 拿到第二个目标的答复", text.includes("第二个目标的答复"), text.slice(0, 200));
  check("[a OpenAI 开局帧静默] 没有 error 帧", errorMessageOf(r.received) === "", errorMessageOf(r.received));
  check(
    "[a OpenAI 开局帧静默] 静默错误发生在提交点之前",
    r.flushes === 1 && r.errors[0]?.name === "TimeoutError" && String(r.errors[0]?.message).includes("mid-stream"),
    `${r.flushes} 次 flush; ${r.errors[0]?.name}: ${String(r.errors[0]?.message)}`,
  );

  // b. 对照组：参数立刻到达，帧照常流到客户端
  const withArgs = toolOpening('{"path":"a.txt"}');
  const r2 = await serve({
    source: upstream([roleOnly, withArgs, "data: [DONE]\n\n"]),
    entry: "openai",
    dialect: "openai",
  });
  check("[b OpenAI 有参数] 立刻提交且没抛错", r2.flushes === 1 && r2.handlerError === null, `${r2.flushes} 次; ${r2.handlerError ?? ""}`);
  check("[b OpenAI 有参数] 工具帧原样到客户端", r2.received.includes(withoutSep(withArgs)), r2.received.join("\n\n").slice(0, 300));
  check("[b OpenAI 有参数] 工具帧在前 [DONE] 在后", r2.received.indexOf(withoutSep(withArgs)) >= 0 && r2.received.indexOf("data: [DONE]") === r2.received.length - 1, r2.received.join("\n\n").slice(0, 300));
  check("[b OpenAI 有参数] 没有 error 帧", errorMessageOf(r2.received) === "", errorMessageOf(r2.received));

  // c. Anthropic：tool_use 开局块的 input 是空对象 —— 同样不算内容
  const r3 = await serveAsRouter(
    [
      { first: "raw-frames-stall", frames: [messageStart(), anthropicToolStart({})] },
      { first: "answer", text: "第二个目标的答复" },
    ],
    "anthropic",
  );
  const text3 = r3.received.join("\n\n");
  check("[c Anthropic 空 input 静默] 换目标了", r3.attempts === 2, `${r3.attempts} 次`);
  check("[c Anthropic 空 input 静默] 客户端没拿到半个工具块", !text3.includes("toolu_1") && !text3.includes("tool_use"), text3.slice(0, 200));
  check("[c Anthropic 空 input 静默] 拿到第二个目标的答复", text3.includes("第二个目标的答复"), text3.slice(0, 200));
  check("[c Anthropic 空 input 静默] 没有 error 事件", errorMessageOf(r3.received) === "", errorMessageOf(r3.received));
  check(
    "[c Anthropic 空 input 静默] 静默错误发生在提交点之前",
    r3.flushes === 1 && r3.errors[0]?.name === "TimeoutError" && String(r3.errors[0]?.message).includes("mid-stream"),
    `${r3.flushes} 次; ${r3.errors[0]?.name}: ${String(r3.errors[0]?.message)}`,
  );

  // d. 对照组：input 带键，开局块本身就有内容
  const toolStart = anthropicToolStart({ path: "a.txt" });
  const stopBlock = anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 });
  const msgStop = anthropicFrame("message_stop", { type: "message_stop" });
  const r4 = await serve({
    source: upstream([messageStart(), toolStart, stopBlock, msgStop]),
    entry: "anthropic",
    dialect: "anthropic",
  });
  check("[d Anthropic 有 input] 立刻提交且没抛错", r4.flushes === 1 && r4.handlerError === null, `${r4.flushes} 次; ${r4.handlerError ?? ""}`);
  check("[d Anthropic 有 input] 工具块原样到客户端", r4.received.includes(withoutSep(toolStart)), r4.received.join("\n\n").slice(0, 300));
  check(
    "[d Anthropic 有 input] 顺序是工具块 → 块结束 → 消息结束",
    r4.received.indexOf(withoutSep(toolStart)) < r4.received.indexOf(withoutSep(stopBlock)) && r4.received.indexOf(withoutSep(stopBlock)) < r4.received.indexOf(withoutSep(msgStop)),
    r4.received.join("\n\n").slice(0, 300),
  );
  check("[d Anthropic 有 input] 没有 error 事件", errorMessageOf(r4.received) === "", errorMessageOf(r4.received));

  // e. 只有工具调用、没有正文的答复：扣住的帧也要一帧不少地送出去
  const argsFrame = openaiSseFrame({ tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] });
  const finishFrame = openaiSseFrame({}, "tool_calls");
  const done = "data: [DONE]\n\n";
  const expectedFrames = [roleOnly, toolOpening(""), argsFrame, finishFrame, done];
  const r5 = await serve({ source: upstream(expectedFrames), entry: "openai", dialect: "openai" });
  check("[e 纯工具调用] 帧一帧不少且顺序一致", JSON.stringify(r5.received) === JSON.stringify(expectedFrames.map(withoutSep)), r5.received.join("\n\n").slice(0, 400));
  check("[e 纯工具调用] 没有重复帧", new Set(r5.received).size === r5.received.length, r5.received.join("\n\n").slice(0, 400));
  check("[e 纯工具调用] 没有 error 帧", errorMessageOf(r5.received) === "", errorMessageOf(r5.received));
  check("[e 纯工具调用] 头只写一次并正常收工", r5.flushes === 1 && r5.handlerError === null, `${r5.flushes} 次; ${r5.handlerError ?? ""}`);
}


/* ------------------------------------------------------------------ *
 * G. 工具开局之后等参数的那个上限（ROUTER_TOOL_OPENING_MS）
 * ------------------------------------------------------------------ */

// 工具开了个头、参数还没来的时候，上游可能一声不吭几百秒。中途那个窗口是给
// 「正文说到一半停住」的，对这种情况太宽容。工具开局帧按判据**不算内容**，所以
// 它一定被扣在内容闸里 —— 那里才是计时的地方：到点时提交点还没到，客户端一个字节
// 都没拿到。
//
// The failure is its own type (`ToolCallSilenceError`): the upstream is healthy,
// this one connection is stuck. Whether to retry it or to move to another upstream
// is the routing layer's call — this layer only hands the error out.
//
// 键默认 0 = 关着，也就是今天的行为（沿用中途那个窗口）。开着的时候，工具开局帧
// 之后最多再等这么久。

/** 面板那条路：写进库 + 重新读一遍（热设置，下一条请求就是新的值）。 */
function setToolOpeningMs(value: number): void {
  configOverride("ROUTER_TOOL_OPENING_MS", String(value));
  reloadConfig();
}

section("G. 工具开局之后等参数的上限");

// a. 键开着：开局帧之后静默 → 抛 ToolCallSilenceError（头未发，客户端零字节）
{
  setToolOpeningMs(60);
  const r = await serveAsRouter([
    { first: "raw-frames-stall", frames: [roleOnly + toolOpening("")] },
    { first: "answer", text: "第二个目标的答复" },
  ]);
  const text = r.received.join("\n\n");
  const first = r.errors[0];
  // 换不换目标是路由层自己的决定（这里那个假路由器换了），这一层只把错交出去。
  check("[a 工具开局超时] 路由层自己决定换不换目标（这里换了）", r.attempts === 2, `${r.attempts} 次`);
  check("[a 工具开局超时] 客户端没拿到半个工具调用", !text.includes("call_1") && !text.includes("tool_calls"), text.slice(0, 200));
  check("[a 工具开局超时] 拿到第二个目标的答复", text.includes("第二个目标的答复"), text.slice(0, 200));
  check("[a 工具开局超时] 没有 error 帧", errorMessageOf(r.received) === "", errorMessageOf(r.received));
  check("[a 工具开局超时] 抛的是 ToolCallSilenceError", first?.name === "ToolCallSilenceError", String(first?.name));
  check("[a 工具开局超时] 不是 StreamIdleError（它有自己的类型）", !(first instanceof StreamIdleError), String(first?.name));
  check("[a 工具开局超时] 用的是这个键的毫秒数", first?.idleMs === 60, String(first?.idleMs));
  check("[a 工具开局超时] 头只写了一次（第二个目标的）", r.flushes === 1, `${r.flushes} 次`);
  // 上游那一侧要收掉：它还挂着就是在计费。
  let cancelled = false;
  const r1 = await serve({
    source: upstream([roleOnly + toolOpening("")], { after: "stall", onCancel: () => (cancelled = true) }),
    entry: "openai",
    dialect: "openai",
  });
  check("[a 工具开局超时] 上游那一侧被取消了", cancelled, "上游还挂着");
  check("[a 工具开局超时] 客户端一个字节都没拿到", r1.received.length === 0 && r1.flushes === 0, `${r1.received.length} 帧 / ${r1.flushes} 次 flush`);
  check("[a 工具开局超时] 抛出去的是 ToolCallSilenceError", r1.thrown?.name === "ToolCallSilenceError", String(r1.thrown?.name));
}

// b. 键 = 0：沿用今天的行为（还是中途那个窗口、那个错）
{
  setToolOpeningMs(0);
  const r = await serveAsRouter([
    { first: "raw-frames-stall", frames: [roleOnly + toolOpening("")] },
    { first: "answer", text: "第二个目标的答复" },
  ]);
  const first = r.errors[0];
  check("[b 键关着] 路由层自己决定换不换目标（这里换了）", r.attempts === 2, `${r.attempts} 次`);
  check("[b 键关着] 报的是中途静默", first?.phase === "mid-stream", String(first?.phase));
  check("[b 键关着] 还是那个 StreamIdleError（老行为没变）", first instanceof StreamIdleError && first?.name === "TimeoutError", String(first?.name));
  check("[b 键关着] 不是 ToolCallSilenceError", first?.name !== "ToolCallSilenceError", String(first?.name));
  check("[b 键关着] 用的是中途那个上限", first?.idleMs === IDLE_MS, String(first?.idleMs));
  check("[b 键关着] 那句话里没有工具开局", !/tool opening/.test(String(first?.message)), String(first?.message));
}

// c. 参数及时到达：不误杀，帧照常流到客户端
{
  setToolOpeningMs(60);
  const withArgs = toolOpening('{"path":"a.txt"}');
  const r = await serve({
    source: upstream([roleOnly + toolOpening(""), withArgs + "data: [DONE]\n\n"]),
    entry: "openai",
    dialect: "openai",
  });
  const text = r.received.join("\n\n");
  check("[c 参数及时到] 网关没有抛错", r.handlerError === null, r.handlerError ?? "");
  check("[c 参数及时到] 头只写了一次", r.flushes === 1, `${r.flushes} 次`);
  check("[c 参数及时到] 开局帧与参数帧都到了客户端", text.includes("call_1") && text.includes("path"), text.slice(0, 300));
  check("[c 参数及时到] 没有 error 帧", errorMessageOf(r.received) === "", errorMessageOf(r.received));
}

// d. 正文先到（已提交），之后再来工具开局帧 + 静默：按工具那个窗口快速失败（可重试）
{
  setToolOpeningMs(60);
  const r = await serve({
    source: upstream([roleOnly + openaiFrame("hi"), toolOpening("")], { after: "stall" }),
    entry: "openai",
    dialect: "openai",
  });
  const text = r.received.join("\n\n");
  check("[d 提交点之后] 客户端拿到了正文", text.includes("hi"), text.slice(0, 200));
  check("[d 提交点之后] 客户端没拿到那个开局帧（工具帧扣到参数收全为止）", !text.includes("call_1"), text.slice(0, 300));
  check("[d 提交点之后] 报的是提交之后的工具静默（可重试的超时）", r.failure?.name === "TimeoutError" && /a tool call was still being written/.test(String(r.failure?.message)), `${r.failure?.name}: ${String(r.failure?.message)}`);
  check("[d 提交点之后] 不是 ToolCallSilenceError（那是提交点之前那一类）", r.failure?.name !== "ToolCallSilenceError", String(r.failure?.name));
  check("[d 提交点之后] 用的是工具那个上限", r.failure?.idleMs === 60, String(r.failure?.idleMs));
  check("[d 提交点之后] 客户端收到的是可重试的那句", /timed out/.test(errorMessageOf(r.received)), errorMessageOf(r.received));
}

// e. 毫秒数取得对：闸真的按配置等，不是写死
{
  setToolOpeningMs(40);
  const quick = await serveAsRouter([
    { first: "raw-frames-stall", frames: [roleOnly + toolOpening("")] },
    { first: "answer", text: "第二个目标的答复" },
  ]);
  setToolOpeningMs(90);
  const slow = await serveAsRouter([
    { first: "raw-frames-stall", frames: [roleOnly + toolOpening("")] },
    { first: "answer", text: "第二个目标的答复" },
  ]);
  check("[e 毫秒数] 短的那个按 40ms 报", quick.errors[0]?.idleMs === 40, String(quick.errors[0]?.idleMs));
  check("[e 毫秒数] 长的那个按 90ms 报", slow.errors[0]?.idleMs === 90, String(slow.errors[0]?.idleMs));
  check(
    "[e 毫秒数] 两个抛的都是工具调用静默",
    quick.errors[0]?.name === "ToolCallSilenceError" && slow.errors[0]?.name === "ToolCallSilenceError",
    `${quick.errors[0]?.name} / ${slow.errors[0]?.name}`,
  );
  check("[e 毫秒数] 真的等了（短的至少 40ms）", quick.handlerMs >= 40, `${quick.handlerMs}ms`);
  check("[e 毫秒数] 长的等得更久（至少多 30ms）", slow.handlerMs - quick.handlerMs >= 30, `${quick.handlerMs}ms → ${slow.handlerMs}ms`);
  setToolOpeningMs(0);
}

// f. 客户端那句话统一到「静默」：不再有 tool opening 字样；日志里能分辨是 tool_call
{
  setToolOpeningMs(60);
  const captured = captureLog({ methods: ["warn"] });
  const r = await serve({
    source: upstream([roleOnly + toolOpening("")], { after: "stall" }),
    entry: "openai",
    dialect: "openai",
  });
  captured.restore();
  const said = String(r.thrown?.message ?? "");
  // 键关着时同一场景走的是中途那道闸：拿它那句来比（只比形状，时长当然不同）。
  setToolOpeningMs(0);
  const capturedMid = captureLog({ methods: ["warn"] });
  const mid = await serve({
    source: upstream([roleOnly + toolOpening("")], { after: "stall" }),
    entry: "openai",
    dialect: "openai",
  });
  capturedMid.restore();
  const saidMid = String(mid.thrown?.message ?? "");
  const shape = (s: string): string => s.replace(/\d+(ms|s)\b/, "N");
  check("[f 文案] 客户端那句话与中途静默同一句形状", shape(said) === shape(saidMid), `${said} vs ${saidMid}`);
  check("[f 文案] 不再出现 tool opening 字样", !/tool opening/i.test(said), said);
  check("[f 日志] 日志里能分辨是 tool_call", /tool_call/.test(captured.all.join("\n")), captured.all.join("\n").slice(0, 300));
  check("[f 日志] 中途静默那一次没有 tool_call 字样", !/tool_call/.test(capturedMid.all.join("\n")), capturedMid.all.join("\n").slice(0, 300));
  setToolOpeningMs(60);
}

// f2. 「可重试的静默超时」那个开关开着时，工具调用静默也不改写成中途静默那句：
// 改写只给中途静默用（那时头已经发出去了，客户端只能拿到一条 error 帧）。工具
// 调用静默发生在提交点之前，客户端拿到的是真实状态与那句话本身。
{
  setToolOpeningMs(60);
  configOverride("ROUTER_IDLE_ERROR_RETRYABLE", "true");
  reloadConfig();
  const r = await serveAsRouter([{ first: "raw-frames-stall", frames: [roleOnly + toolOpening("")] }]);
  const body = r.received.join("\n\n") || r.text;
  check("[f 可重试开关] 客户端拿到的是那句统一的静默", /upstream sent nothing for 60ms mid-stream/.test(body), body.slice(0, 300));
  check("[f 可重试开关] 没有被改写成中途静默那句", !/upstream timed out after/.test(body), body.slice(0, 300));
  configOverride("ROUTER_IDLE_ERROR_RETRYABLE", "false");
  reloadConfig();
  setToolOpeningMs(0);
}
/* ------------------------------------------------------------------ *
 * H. tool_call 是原子的：参数没收全之前，那一帧不算内容
 * ------------------------------------------------------------------ */

// 参数没收完就静默：它落在提交点之前 —— 客户端零字节，路由层原样重发同一个上游
// （那一条路已经存在，见 G 节）。参数收全了：提交点落在「参数完整」那一帧，客户端
// 第一次见到字节就是完整的工具调用。
//
// 「完整」的判据只有一条：累积起来的 arguments 能 JSON.parse 通过。

section("H. tool_call 原子化");

/** 一段参数分片（拼起来是一个完整的 JSON 对象）。 */
const argPieces = ['{"path":', '"a.txt"', "}"];
const argFrames = argPieces.map((piece) => openaiSseFrame({ tool_calls: [{ index: 0, function: { arguments: piece } }] }));

// a. 参数分片慢速流动：慢不等于静默，不该被砍
{
  setToolOpeningMs(60);
  const frames = [roleOnly + toolOpening(""), ...argFrames];
  const r = await serve({ source: upstream(frames, { gapMs: 20 }), entry: "openai", dialect: "openai" });
  const text = r.received.join("\n\n");
  check("[a 慢速流动] 网关没有抛错（没当成静默）", r.handlerError === null, r.handlerError ?? "");
  check("[a 慢速流动] 头只写了一次", r.flushes === 1, `${r.flushes} 次`);
  check("[a 慢速流动] 客户端拿到了完整的工具调用", text.includes("call_1") && text.includes("a.txt"), text.slice(0, 300));
  check("[a 慢速流动] 没有 error 帧", errorMessageOf(r.received) === "", errorMessageOf(r.received));
}

// b. 参数发一半就静默：提交点之前 —— 客户端零字节，上游被取消
{
  setToolOpeningMs(60);
  let cancelled = false;
  const r = await serve({
    source: upstream([roleOnly + toolOpening(""), argFrames[0]], { after: "stall", onCancel: () => (cancelled = true) }),
    entry: "openai",
    dialect: "openai",
  });
  check("[b 参数半途静默] 抛的是 ToolCallSilenceError", r.thrown?.name === "ToolCallSilenceError", String(r.thrown?.name));
  check("[b 参数半途静默] 客户端一个字节都没拿到", r.received.length === 0 && r.flushes === 0, `${r.received.length} 帧 / ${r.flushes} 次 flush`);
  check("[b 参数半途静默] 上游那一侧被取消了", cancelled, "上游还挂着");
  check("[b 参数半途静默] 没有 error 帧（头没发，路由层能换目标）", errorMessageOf(r.received) === "", errorMessageOf(r.received));
}

// c. 参数收完整：提交 —— 客户端拿到完整的工具调用，只 flush 一次
{
  setToolOpeningMs(60);
  const frames = [roleOnly + toolOpening(""), ...argFrames];
  const r = await serve({ source: upstream(frames), entry: "openai", dialect: "openai" });
  const text = r.received.join("\n\n");
  check("[c 参数收全] 立刻提交且没抛错", r.flushes === 1 && r.handlerError === null, `${r.flushes} 次; ${r.handlerError ?? ""}`);
  check("[c 参数收全] 客户端拿到了完整的工具调用", text.includes("call_1") && text.includes("a.txt"), text.slice(0, 400));
  check("[c 参数收全] 只 flush 一次", r.flushes === 1, `${r.flushes} 次`);
  check("[c 参数收全] 没有 error 帧", errorMessageOf(r.received) === "", errorMessageOf(r.received));
}

// d. 参数累积超过上限（256 KiB）：照样提交，此后静默归中途那个窗口
{
  setToolOpeningMs(60);
  const huge = `"${"a".repeat(300 * 1024)}"`;
  const r = await serve({
    source: upstream([roleOnly + toolOpening(""), openaiSseFrame({ tool_calls: [{ index: 0, function: { arguments: huge } }] })], {
      after: "stall",
    }),
    entry: "openai",
    dialect: "openai",
  });
  const text = r.received.join("\n\n");
  check("[d 参数超上限] 提交了（头写了一次）", r.flushes === 1, `${r.flushes} 次`);
  check("[d 参数超上限] 那一帧没有静默丢掉", text.length > 300 * 1024, `${text.length} 字节`);
  check(
    "[d 参数超上限] 此后的静默归中途那个窗口",
    r.failure?.idleMs === IDLE_MS && !/tool call was still being written/.test(String(r.failure?.message)),
    `${r.failure?.idleMs}: ${String(r.failure?.message)}`,
  );
}

// e. Anthropic：input_json_delta 同样按「参数收全」算
{
  setToolOpeningMs(60);
  const anthropicArg = (piece: string) =>
    anthropicFrame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: piece },
    });
  let cancelled = false;
  const half = await serve({
    source: upstream([messageStart(), anthropicToolStart({}), anthropicArg('{"path":')], {
      after: "stall",
      onCancel: () => (cancelled = true),
    }),
    entry: "anthropic",
    dialect: "anthropic",
  });
  check("[e Anthropic 半途静默] 抛的是 ToolCallSilenceError", half.thrown?.name === "ToolCallSilenceError", String(half.thrown?.name));
  check("[e Anthropic 半途静默] 客户端一个字节都没拿到", half.received.length === 0 && half.flushes === 0, `${half.received.length} 帧 / ${half.flushes} 次 flush`);
  check("[e Anthropic 半途静默] 上游那一侧被取消了", cancelled, "上游还挂着");

  const whole = await serve({
    source: upstream([
      messageStart(),
      anthropicToolStart({}),
      anthropicArg('{"path":"a.txt"}'),
      anthropicFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
    ]),
    entry: "anthropic",
    dialect: "anthropic",
  });
  const text = whole.received.join("\n\n");
  check("[e Anthropic 收全] 立刻提交且没抛错", whole.flushes === 1 && whole.handlerError === null, `${whole.flushes} 次; ${whole.handlerError ?? ""}`);
  check("[e Anthropic 收全] 工具块原样到客户端", text.includes("toolu_1") && text.includes("a.txt"), text.slice(0, 300));
  check("[e Anthropic 收全] 没有 error 事件", errorMessageOf(whole.received) === "", errorMessageOf(whole.received));
}

// f. 已提交（思考先发出去）之后 tool 在途又静默：按工具那个窗口快速失败，可重试
{
  setToolOpeningMs(60);
  const thinking = openaiSseFrame({ reasoning_content: "在想" });
  const started = Date.now();
  const openai = await serve({
    source: upstream([roleOnly + thinking, toolOpening("")], { after: "stall" }),
    entry: "openai",
    dialect: "openai",
  });
  const elapsed = Date.now() - started;
  const said = errorMessageOf(openai.received);
  check("[f 提交后工具静默] 客户端拿到了思考（提交点已经过去）", openai.received.join("\n\n").includes("在想"), "");
  check("[f 提交后工具静默] 报的是超时", openai.failure?.name === "TimeoutError", String(openai.failure?.name));
  check("[f 提交后工具静默] 用的是工具那个上限（60ms），不是中途那个", openai.failure?.idleMs === 60, String(openai.failure?.idleMs));
  check("[f 提交后工具静默] 很快就失败了（没等满中途那个窗口）", elapsed < IDLE_MS, `${elapsed}ms`);
  check("[f 提交后工具静默] 客户端那句话是可重试的形状", /timed out/.test(said), said);
  check("[f 提交后工具静默] openai 方言的 code 是 upstream_idle_timeout", openai.received.some((f) => f.includes("upstream_idle_timeout")), openai.received.join("\n\n").slice(0, 300));

  const anthropic = await serve({
    source: upstream([roleOnly + thinking, toolOpening("")], { after: "stall" }),
    entry: "openai",
    dialect: "anthropic",
  });
  const anthropicSaid = errorMessageOf(anthropic.received);
  check("[f 提交后工具静默] anthropic 方言是 error 事件", anthropic.received.some((f) => f.includes("event: error")), anthropic.received.join("\n\n").slice(0, 300));
  check("[f 提交后工具静默] anthropic 方言那句话也是可重试的形状", /timed out/.test(anthropicSaid), anthropicSaid);
}

// g. 「不续写」那一行日志要说得清：发了多少字节、帧序、参数累积
{
  setToolOpeningMs(60);
  const captured = captureLog({ methods: ["warn"] });
  await serve({
    source: upstream([roleOnly + openaiFrame("hi"), toolOpening("")], { after: "stall" }),
    entry: "openai",
    dialect: "openai",
  });
  captured.restore();
  const line = captured.all.find((entry) => entry.includes("静默后不续写")) ?? "";
  check("[g 日志] 有「静默后不续写」那一行", line !== "", captured.all.join("\n").slice(0, 300));
  check("[g 日志] 那行里有「已发给客户端 N 字节」", /已发给客户端 \d+ 字节/.test(line), line.slice(0, 300));
  check("[g 日志] 那个字节数不是 0（正文已经到客户端了）", /已发给客户端 [1-9]\d* 字节/.test(line), line.slice(0, 300));
  check("[g 日志] 那行里有帧序", /帧序 [^）]+/.test(line), line.slice(0, 300));
  check("[g 日志] 帧序里没有工具名（那个工具帧被扣住，没到客户端）", /帧序 正文，/.test(line) && !line.includes("工具名"), line.slice(0, 300));
  check("[g 日志] 参数累积那一格在", /参数累积 \d+ 字节/.test(line), line.slice(0, 300));
}

/* ------------------------------------------------------------------ *
 * I. 工具帧一律扣住：不管提交点在哪儿
 * ------------------------------------------------------------------ */

// 口径只有一条：工具帧（开局帧或参数碎片）一律扣住，直到参数收全。半个 tool_call
// 客户端本来就不显示 —— 扣住不亏。提交点之前由内容闸扣（客户端零字节），提交点之后
// 由那道守卫扣（客户端拿到思考/正文，但一个工具帧都没有）。
section("I. 工具帧一律扣住");

// a. 提交之后才开始的工具调用：参数收全之前，客户端一个工具帧都拿不到
{
  setToolOpeningMs(60);
  const thinking = openaiSseFrame({ reasoning_content: "在想" });
  const frames = [thinking, toolOpening(""), ...argFrames];
  const arrivals: { frame: string; at: number }[] = [];
  const started = Date.now();
  const r = await serve({
    source: upstream(frames, { gapMs: 20 }),
    entry: "openai",
    dialect: "openai",
    onFrame: (frame, at) => arrivals.push({ frame, at }),
  });
  const text = r.received.join("\n\n");
  check("[a 扣住] 网关没有抛错", r.handlerError === null, r.handlerError ?? "");
  check("[a 扣住] 客户端拿到了完整的工具调用", text.includes("call_1") && text.includes("a.txt"), text.slice(0, 300));
  check("[a 扣住] 帧数与上游一致（另加一个 [DONE]）", r.received.length === frames.length + 1, `${r.received.length} 帧`);
  check("[a 扣住] 没有 error 帧", errorMessageOf(r.received) === "", errorMessageOf(r.received));
  const openingAt = arrivals.find((a) => a.frame.includes("call_1"))?.at ?? -1;
  // 参数是最后一片才收全的（上游每 20ms 一片）：开局帧不可能比那早到。
  check("[a 扣住] 开局帧没有早于参数收全到客户端", openingAt - started >= 60, `开局帧在第 ${openingAt - started}ms 到达`);
  const thinkingAt = arrivals.find((a) => a.frame.includes("在想"))?.at ?? -1;
  check("[a 扣住] 思考帧先到了（提交点已经过去）", thinkingAt >= 0 && thinkingAt < openingAt, `思考 ${thinkingAt - started}ms / 开局 ${openingAt - started}ms`);
}

// b. 参数发一半就静默：按 tool 窗口快速失败，客户端零个工具帧
{
  setToolOpeningMs(60);
  const thinking = openaiSseFrame({ reasoning_content: "在想" });
  const r = await serve({
    source: upstream([thinking, toolOpening(""), argFrames[0]], { after: "stall" }),
    entry: "openai",
    dialect: "openai",
  });
  const text = r.received.join("\n\n");
  check("[b 半途静默] 客户端拿到了思考", text.includes("在想"), text.slice(0, 200));
  check("[b 半途静默] 客户端一个工具帧都没拿到", !text.includes("call_1") && !text.includes("tool_calls"), text.slice(0, 300));
  check(
    "[b 半途静默] 报的是提交之后的工具静默（可重试）",
    r.failure?.name === "TimeoutError" && /a tool call was still being written/.test(String(r.failure?.message)),
    `${r.failure?.name}: ${String(r.failure?.message)}`,
  );
  check("[b 半途静默] 用的是工具那个窗口", r.failure?.idleMs === 60, String(r.failure?.idleMs));
  check("[b 半途静默] 客户端那句话是可重试的形状", /timed out/.test(errorMessageOf(r.received)), errorMessageOf(r.received));
}

// c. 客户端拿到的字节序列与上游逐字节一致
{
  setToolOpeningMs(60);
  const frames = [roleOnly, toolOpening(""), ...argFrames];
  const r = await serve({ source: upstream(frames), entry: "openai", dialect: "openai" });
  const expected = [...frames.map(withoutSep), "data: [DONE]"];
  check("[c 逐字节] 帧数与上游一致", r.received.length === expected.length, `${r.received.length} / ${expected.length}`);
  check("[c 逐字节] 每一帧的字节与上游一致（顺序也一致）", JSON.stringify(r.received) === JSON.stringify(expected), r.received.join("\n\n").slice(0, 400));
}

// d. 累积超过上限：立刻写出，不卡住（此后静默归中途那个窗口）
{
  setToolOpeningMs(60);
  const thinking = openaiSseFrame({ reasoning_content: "在想" });
  // 参数是一段没写完的 JSON：它永远不会「收全」，只能靠上限把它放出去。
  const huge = openaiSseFrame({ tool_calls: [{ index: 0, function: { arguments: `"${"a".repeat(300 * 1024)}` } }] });
  const r = await serve({
    source: upstream([thinking, toolOpening(""), huge], { after: "stall" }),
    entry: "openai",
    dialect: "openai",
  });
  const text = r.received.join("\n\n");
  check("[d 超上限] 扣住的帧立刻写出来了", text.includes("call_1") && text.length > 300 * 1024, `${text.length} 字节`);
  check(
    "[d 超上限] 此后的静默归中途那个窗口",
    r.failure?.idleMs === IDLE_MS && !/tool call was still being written/.test(String(r.failure?.message)),
    `${r.failure?.idleMs}: ${String(r.failure?.message)}`,
  );
}

// e. 上游正常结束但参数没收全：扣住的帧照样写出（不吞）
{
  setToolOpeningMs(60);
  const thinking = openaiSseFrame({ reasoning_content: "在想" });
  const r = await serve({
    source: upstream([thinking, toolOpening(""), argFrames[0]]),
    entry: "openai",
    dialect: "openai",
  });
  const text = r.received.join("\n\n");
  check("[e 正常结束] 扣住的帧照样到了客户端", text.includes("call_1") && text.includes("path"), text.slice(0, 300));
  check("[e 正常结束] 没有 error 帧", errorMessageOf(r.received) === "", errorMessageOf(r.received));
  check("[e 正常结束] 网关没有抛错", r.handlerError === null, r.handlerError ?? "");
}

// f. 对照组：没有工具调用的流，逐帧即时到达（正常流量不许被扣住）
{
  setToolOpeningMs(60);
  const frames = Array.from({ length: 8 }, (_, i) => openaiSseFrame({ content: `w${i}` }));
  const arrivals: { frame: string; at: number }[] = [];
  const r = await serve({
    source: upstream(frames, { gapMs: 20 }),
    entry: "openai",
    dialect: "openai",
    onFrame: (frame, at) => arrivals.push({ frame, at }),
  });
  const span = arrivals.length > 1 ? arrivals[arrivals.length - 1].at - arrivals[0].at : 0;
  check("[f 对照组] 每一帧都到了", r.received.length === frames.length + 1, `${r.received.length} 帧`);
  check("[f 对照组] 帧是逐帧到的（不是攒到最后一起到）", span >= 80, `跨度 ${span}ms`);
  check("[f 对照组] 没有 error 帧", errorMessageOf(r.received) === "", errorMessageOf(r.received));
}

// g. 日志：扣了多少帧/多少字节，写出时一行
{
  setToolOpeningMs(60);
  const captured = captureLog({ methods: ["info"] });
  await serve({ source: upstream([roleOnly, toolOpening(""), ...argFrames]), entry: "openai", dialect: "openai" });
  captured.restore();
  const line = captured.all.find((entry) => entry.includes("工具帧扣住")) ?? "";
  check("[g 日志] 有一行说扣住了多少帧多少字节", /工具帧扣住 \d+ 帧 \d+ 字节/.test(line), captured.all.join("\n").slice(0, 300));
  check("[g 日志] 帧数与字节数不是 0", /工具帧扣住 [1-9]\d* 帧 [1-9]\d* 字节/.test(line), line.slice(0, 300));
}

setToolOpeningMs(0);

closeStore();
fs.rmSync(tmp, { recursive: true, force: true });

/* ------------------------------------------------------------------ */

clearTimeout(watchdog);
console.log("");
console.log("结果");
console.log(`  pass=${pass} fail=${fail}`);
if (fail) process.exit(1);
