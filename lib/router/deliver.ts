// lib/router/deliver.ts — how an answer reaches the client.
//
// The upstreams answer in two dialects: the OpenAI ones (Qoder, WorkBuddy,
// TokenRhythm, SenseNova, 书生·端砚, the MiniMax open platform) and the
// Anthropic ones (MiniMax Code, ZCode). The client may ask in either. So an
// answer is converted at most once, and the way it is written out — the
// headers, the frames, the error events — is the same for every upstream.

import { log } from "../log.ts";
import type { Json } from "../json.ts";
import crypto from "node:crypto";
import type Koa from "koa";
import { AuthError } from "../credential.ts";
import { anthropicStreamToOpenAI, openaiStreamToAnthropic } from "../dialect/stream.ts";
import { classifyUpstreamError } from "./provider-selection.ts";
import { anthropicToOpenAIResponse, openaiToAnthropicResponse } from "../dialect/response.ts";
import { parseLooseJson, readOpenAIChunks, readOrAbort, readSseEvents, sseData, sseEvent, SSE_DONE } from "../sse-stream.ts";
import { businessCodeOfPayload, isBusinessErrorEnvelope, withBusinessCode } from "../upstream-status.ts";
import { scrubForClient, scrubForLog } from "../log-scrub.ts";
import { configFlag, configNumber, markHotSetting } from "../config.ts";
import {
  STREAM_FIRST_FRAME_DEFAULT_MS,
  STREAM_IDLE_DEFAULT_MS,
  clampStreamLimit,
  streamLimitWasCapped,
} from "./stream-limits.ts";

export type Dialect = "anthropic" | "openai";

/** The dialect an upstream answers in. */
export type UpstreamDialect = Dialect;

const rid = (prefix: string) => prefix + crypto.randomBytes(12).toString("hex");

/**
 * Take the response over.
 *
 * A stream is written frame by frame, so Koa must not also write a body of its
 * own when the middleware chain ends. `respond = false` says that the raw
 * response belongs to us from here on.
 *
 * Call this **after** the first frame is in hand, never before: an answer that
 * fails before its first frame has written nothing, and it is the caller
 * (sendError) that answers it with a real status code. Taken over too early,
 * `respond = false` makes Koa skip that body and nobody writes anything — the
 * client waits for headers that never come. The two assignments are only
 * needed once there is a frame to write.
 */
function takeOver(ctx: Koa.Context): void {
  ctx.respond = false;
  // Koa starts every request at 404 and only replaces that when it writes the
  // response itself. A stream writes its own, so nothing would ever say 200
  // and the client would see a 404 with a perfectly good body.
  ctx.status = 200;
}

/** The headers of a streaming answer. */
function sseHead(ctx: Koa.Context): void {
  ctx.res.setHeader("content-type", "text/event-stream; charset=utf-8");
  ctx.res.setHeader("cache-control", "no-cache, no-transform");
  ctx.res.setHeader("connection", "keep-alive");
  ctx.res.setHeader("x-accel-buffering", "no");
  ctx.res.flushHeaders?.();
}

/**
 * 等多久算「客户端不读了」（毫秒）。
 *
 * 客户端只是读得慢时，等着是对的；但一个连着 socket 却永远不读的客户端，
 * 会把这条请求、上游的流、账号和套接字一起吊住。`app.ts` 里没有
 * `server.timeout`，上游那个 300 秒的 abort 也救不了——到那时候上游早就不
 * 读了。所以这里自己设一个上限：到了就断开这个连接，当作「客户端没了」。
 */
const DRAIN_TIMEOUT_MS = 45_000;

/**
 * 等多久算「客户端不读了」（毫秒）。
 *
 * 可以用 FACADE_DRAIN_TIMEOUT_MS 改（测试要把它调短）。默认 45 秒。
 */
function drainTimeoutMs(): number {
  const value = Number(process.env.FACADE_DRAIN_TIMEOUT_MS ?? 0);
  if (Number.isFinite(value) && value > 0) return value;
  return DRAIN_TIMEOUT_MS;
}

/**
 * 一条答复的状态：客户端还在不在。
 *
 * 每一段答复一份（按 res 记）。
 */
/**
 * 一帧正在等发送缓冲区。
 *
 * `since`：它从什么时候开始等。看门狗量的就是这个 —— **一帧等在发送缓冲区里
 * 多久了**。客户端读了，这一帧就出去了，计时归零；客户端不读，它就一直等着，
 * 等到上限就断开。
 *
 * 不能拿「帧与帧之间多久没有新帧」来量：那是**上游**在想（推理模型会安静
 * 几十秒），跟客户端读不读没有关系。拿它当判据，一个 thinking 的上游就会把
 * 好好一个客户端踢掉，答复也断了（2026-11-02，作者复查发现）。
 */
interface PendingWrite {
  /** 从什么时候开始等。 */
  since: number;
  /** 「这一帧写完了」的回调：放掉那个 await。 */
  finish: () => void;
}

/**
 * 一条答复的状态：客户端还在不在。
 *
 * 每一段答复一份（按 res 记）。
 */
interface ReplyState {
  /** 客户端真的走了（连接断了，或写失败了）。 */
  gone: boolean;
  /**
   * 正在等的那些帧。
   *
   * 是个**集合**，不是一个时刻：ping 与正文帧可能同时在等（ping 是定时发的，
   * 不等人）。一个时刻只能记一个 —— 后来的把前面的盖掉，前面的那一行 await
   * 就永远挂着（2026-11-02，作者复查发现）。
   */
  pending: Set<PendingWrite>;
  /** 看门狗。 */
  timer: NodeJS.Timeout | null;
  /** 客户端走了的时候要叫的东西：停上游。 */
  onGone?: () => void;
  /** 「客户端走了」这件事报过了没有（同一件事只报一次）。 */
  goneReported: boolean;
}

const replyStates = new WeakMap<NodeJS.EventEmitter, ReplyState>();

/** 这一段答复的状态（没有就建一个）。 */
function replyState(ctx: Koa.Context): ReplyState {
  const res = ctx.res;
  let state = replyStates.get(res);
  if (!state) {
    state = { gone: false, pending: new Set(), timer: null, goneReported: false };
    replyStates.set(res, state);
    // 连接随时可能报错，而 Node 的「事件没有监听器」就是一次未捕获异常 ——
    // 整个进程没了。所以这里常驻一个监听器：它只是把「客户端走了」记下来。
    res.on("error", () => {
      markGone(ctx, state!);
    });
    // 连接断了（客户端走了）：也是「客户端走了」。上游在想的时候没有帧在写，
    // 这时才知道客户端已经走了 —— 不然网关会一直读上游、一直计费，直到下一
    // 帧到来才发现。
    res.on("close", () => {
      markGone(ctx, state!);
    });
    // 连接可能在我们挂上监听器**之前**就断了 —— 那个事件已经发过了，谁也没
    // 听见。那就当它已经走了（2026-11-03，作者复查发现：客户端在网关挂上
    // 监听器之前断开，这一段就没人管了）。
    if (res.destroyed) markGone(ctx, state!);
  }
  return state;
}

/**
 * 看门狗：一帧在发送缓冲区里等太久了就断开这个连接。
 *
 * 只在**有帧在等**的时候才计时。没有帧在等（上游在想）就没有客户端读不读
 * 这回事 —— 那时候断开只会把一条好好的答复砍掉。
 *
 * 期限是「最早那一帧开始等的时刻 + 上限」，**不是**「从现在起算」：新的帧
 * 不该把已经等着的那些帧的期限往后推（2026-11-02，作者复查发现：ping 每
 * 5 秒一发，一推就永远推不到，看门狗等于没有）。
 */
function armWatchdog(ctx: Koa.Context, state: ReplyState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  if (!state.pending.size) return;
  let earliest = Infinity;
  for (const write of state.pending) earliest = Math.min(earliest, write.since);
  const deadline = earliest + drainTimeoutMs();
  const wait = Math.max(0, deadline - Date.now());
  const res = ctx.res;
  state.timer = setTimeout(() => {
    state.timer = null;
    // 答复已经写完了：没什么可断的。
    if (res.writableEnded || res.destroyed) return;
    // 那些帧都出去了：没有在等的了。
    if (!state.pending.size) return;
    const left = deadline - Date.now();
    if (left > 0) {
      // 还没到期限：接着等。
      armWatchdog(ctx, state);
      return;
    }
    log.warn(`[DELIVER] 客户端 ${((Date.now() - earliest) / 1000).toFixed(1)}s 没有读，断开连接`);
    markGone(ctx, state);
  }, wait);
  // 这个定时器不该让进程活着。
  state.timer.unref?.();
}

/** 客户端走了：记下来，放掉在等的那些帧，并且叫那个「停上游」的钩子。 */
function markGone(ctx: Koa.Context, state: ReplyState): void {
  if (state.gone) return;
  state.gone = true;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  // 那些帧还在等：放掉它们。socket 已经没了，Node 不会再回调那些写 —— 不放
  // 的话，那几行 await 就永远挂着（2026-11-02，作者复查发现）。
  for (const write of [...state.pending]) {
    state.pending.delete(write);
    try {
      write.finish();
    } catch {
      /* 放掉失败不影响答复 */
    }
  }
  // 真的断开这个连接：只是「不再写了」，socket 与它那几十兆的缓冲还挂着。
  try {
    if (!ctx.res.writableEnded) ctx.res.destroy();
  } catch {
    /* 已经断了 */
  }
  try {
    state.onGone?.();
  } catch {
    /* 停上游失败不许影响答复 */
  }
}

/**
 * Write a frame, and say whether the client is still there.
 *
 * `res.write()` 返回 false 的意思是「发送缓冲区满了，该等 drain 了」——
 * **不是**「客户端走了」。把 false 当成「客户端没了」，长答复就会被砍在
 * 中间：客户端只是读得慢（Claude Code 在渲染长输出时就会慢），窗口满了，
 * 网关以为对方不要了，直接 break 掉循环。
 *
 * 后果是客户端收到一条断掉的流：HTTP 200，拿到部分正文，没有收尾帧
 * （message_delta / message_stop / [DONE]）。Claude Code 那侧记成
 * `stream_truncated` + `truncatedAfterOutput`，代理那侧记成
 * `output_estimated=1`（usage 没等到，只能估算）。
 *
 * 所以这里分两件事：
 *   · 缓冲区满了 → 等这一帧真的发出去（`res.write(chunk, cb)` 的回调），
 *     等不到就由看门狗断开，不把请求永远吊着；
 *   · 连接真的断了（res destroyed / writableEnded）→ 才算客户端没了。
 */
async function writeFrame(ctx: Koa.Context, chunk: string | Uint8Array): Promise<boolean> {
  const res = ctx.res;
  const state = replyState(ctx);
  if (state.gone || res.writableEnded || res.destroyed) return false;
  // 看门狗在**写之前**就上膛：这一帧可能永远发不出去（客户端不读，缓冲区
  // 满了），那时这一行代码就卡在这里 —— 没有看门狗，这条请求就永远吊着。
  let settled = false;
  const write: PendingWrite = {
    since: Date.now(),
    finish: () => {
      if (settled) return;
      settled = true;
      resolveWrite();
    },
  };
  let resolveWrite: () => void = () => {};
  state.pending.add(write);
  armWatchdog(ctx, state);
  try {
    await new Promise<void>((resolve) => {
      resolveWrite = resolve;
      // 写回调在这一帧真的发出去时才来：缓冲满了它就等着，正是要的。
      // 写失败了就是客户端没了（socket 断了）。
      res.write(chunk, (err?: Error | null) => {
        if (err) markGone(ctx, state);
        write.finish();
      });
    });
  } catch {
    state.pending.delete(write);
    return false;
  }
  // 这一帧出去了（或者失败了）：不在等的名单里了。
  state.pending.delete(write);
  if (!state.pending.size && state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  } else {
    // 还有别的在等：看门狗按最早那一帧重算。
    armWatchdog(ctx, state);
  }
  if (state.gone) return false;
  return !(res.writableEnded || res.destroyed);
}

/**
 * 客户端走了：上游也别接着算了。
 *
 * 上游还在吐字（还在计费），账号还占着 —— 客户端都不要了，接着算就是白花钱。
 * 所以把上游的流取消掉。取消不了就算了（上游自己会超时）。
 *
 * `abort` 是给那些**正在读**这条流的那个循环的：它正卡在 read() 上，取消一
 * 个被锁住的流没有用，得让它自己停下来。
 */
async function stopUpstream(
  body: ReadableStream<Uint8Array> | null | undefined,
  abort?: AbortController,
): Promise<void> {
  abort?.abort();
  if (!body) return;
  try {
    await body.cancel("the client went away");
  } catch {
    /* 已经结束了，或者本来就是关着的 */
  }
}

/**
 * 装上「客户端走了就停上游」这个钩子。
 *
 * 看门狗断开连接的时候也会走这条路：客户端不读了，上游就别接着算。
 *
 * 客户端要是**已经**走了（在装这个钩子之前就走了），当场把上游停掉 —— 不然
 * 没人再叫它一次，上游就白算到它自己结束（2026-11-03，作者复查发现）。
 */
function onClientGone(ctx: Koa.Context, body: ReadableStream<Uint8Array> | null | undefined, abort?: AbortController): void {
  const state = replyState(ctx);
  const stop = () => {
    void stopUpstream(body, abort);
  };
  state.onGone = stop;
  if (state.gone) stop();
}

/**
 * 装上「客户端走了就停上游」这个钩子（上游被 tee 成了两支的情况）。
 *
 * tee 的两条支线**都要取消**，源头才会停：取消其中一条，另一条还在读，源头
 * 就还在吐字（还在计费）。所以这里取消两条。
 */function onClientGoneTee(
  ctx: Koa.Context,
  branches: ReadableStream<Uint8Array>[],
  abort?: AbortController,
): void {
  const state = replyState(ctx);
  state.onGone = () => {
    abort?.abort();
    for (const branch of branches) {
      void branch.cancel("the client went away").catch(() => {
        /* 已经结束了 */
      });
    }
  };
}

/**
 * The JSON payload in the first chunk of an answer, if there is one.
 *
 * The upstreams answer either with a plain JSON body or with SSE frames, so
 * the payload may sit behind a `data:` prefix, and the chunk may be cut in the
 * middle of it. A chunk that does not parse yields nothing: the answer is
 * then passed through and the stream reports the failure itself.
 */
function payloadIn(text: string): any | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  let candidate = trimmed;
  if (!trimmed.startsWith("{")) {
    // SSE: the payload sits behind a `data:` prefix, and the frame may carry
    // an event name in front of it.
    const line = trimmed.split("\n").find((l) => l.trimStart().startsWith("data:"));
    if (line) candidate = line.trimStart().slice(5).trim();
  }
  if (!candidate.startsWith("{")) return undefined;
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Whether the first chunk is the upstream saying it failed.
 *
 * The shape is parsed, not searched for: a normal answer may carry the word
 * "error" inside a tool argument or a code snippet.
 */
function looksLikeErrorPayload(head: string): boolean {
  const parsed = payloadIn(head);
  if (!parsed || typeof parsed !== "object") return false;
  // Anthropic dialect: { type: "error", error: {...} }
  if (parsed.type === "error") return true;
  // OpenAI dialect: { error: {...} }
  if (parsed.error && typeof parsed.error === "object") return true;
  if (typeof parsed.error === "string" && parsed.error.length > 0) return true;
  // Business codes: the string is the name, the number is the code. A zero
  // code means no error, so only a non-zero number counts.
  if (typeof parsed.errorCode === "string") return true;
  if (typeof parsed.errorCode === "number" && parsed.errorCode !== 0) return true;
  if (typeof parsed.error_code === "string") return true;
  if (typeof parsed.error_code === "number" && parsed.error_code !== 0) return true;
  // A top-level business code: { code: 11128, msg: "...", displayMsg: {...} }.
  // That is the shape WorkBuddy's channel check answers with (recorded in
  // test/fixtures/workbuddy-channel-check-11128.json). Without this the 200
  // path sees a body with no "error" key and calls it a good answer — the
  // client gets an empty stream and the log shows a success.
  //
  // Zero means no error (that is what the platforms answer on success), and
  // so does a body that carries an answer (choices/object): those are the
  // normal frames, not envelopes.
  if (looksLikeBusinessErrorEnvelope(parsed)) return true;
  return false;
}

/**
 * Is this the upstream's error envelope rather than an answer?
 *
 * An envelope has a business code that is not zero, and no answer in it.
 */
function looksLikeBusinessErrorEnvelope(parsed: any): boolean {
  return isBusinessErrorEnvelope(parsed);
}

/**
 * Read what is left of the answer with the reader that already holds it.
 *
 * The stream was locked by `getReader()`, so wrapping it in another Response
 * throws "Response body object should not be disturbed or locked". The body is
 * only read for one sentence, so 8KB is enough; some upstreams answer an
 * error with the whole response body.
 */
/**
 * 取消一个 reader：上游那条流就停了（还在吐字就是在计费）。
 *
 * 取消失败不算错：上游可能自己已经结束了。
 */
async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel("the client went away");
  } catch {
    /* 已经结束了 */
  }
}

async function drainText(reader: ReadableStreamDefaultReader<Uint8Array>, head: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = head;
  try {
    while (text.length < 8192) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    /* keep what we have */
  }
  try {
    // The rest of the body is not read, so the upstream connection is closed
    // here instead of hanging on to a socket nobody reads.
    await reader.cancel();
  } catch {
    /* already closed */
  }
  try {
    reader.releaseLock();
  } catch {
    /* already closed */
  }
  return text;
}

/* ---------------- 上游安静了 ---------------- */

/**
 * 等上游的**第一帧**多久算「它不会再说话了」（毫秒）的默认值。
 *
 * 与流中途那个上限分开取值，因为量的是两件事：推理模型的第一个 token 常常
 * 要两分多钟（coder-a 那一类），拿中途那个上限去量等待，一条正常在想的流就
 * 被砍掉；而流开了一半停住三分钟，确实是停住了。
 *
 * 导出给测试用：默认值调错（比如忘了改回来）比没有还糟。
 *
 * 这是设置 ROUTER_FIRST_FRAME_MS 的默认值，读在 idleGates 里。
 *
 * 默认值住在 lib/router/stream-limits.ts（那里还有上限，面板与下层超时都读
 * 同一份）；这里重新导出，是为了让原来从这里导入的人不用改。
 */
export { STREAM_FIRST_FRAME_DEFAULT_MS };

/**
 * 流中途两帧之间安静多久算「它不会再说话了」（毫秒）的默认值。
 *
 * 靠 undici 那个 5 分钟的 bodyTimeout 兜底太久了：客户端在这 5 分钟里一个字
 * 都等不到，最后等到的还是 Node 自己那句 `terminated`。推理模型的流里，两帧
 * 之间安静几十秒是正常的，超过这个数就是在挂着，不是在想。
 *
 * 这是设置 ROUTER_STREAM_IDLE_MS 的默认值，读在 idleGates 里。
 */
export { STREAM_IDLE_DEFAULT_MS };

// Hot: both limits are read again at the start of every answer (see
// idleGates), so a change made in the panel applies to the next request with
// no restart. They are knobs an operator has to turn down and up again — a
// self-test cannot wait five minutes, and a slower reasoning model needs more
// than the default
markHotSetting("ROUTER_FIRST_FRAME_MS");
markHotSetting("ROUTER_STREAM_IDLE_MS");
markHotSetting("ROUTER_IDLE_ERROR_RETRYABLE");
markHotSetting("ROUTER_CONTINUE_ON_IDLE");
markHotSetting("ROUTER_CONTINUE_MAX");

/** 续写上下文里已产出的文本最多带多少（字节）。超了取尾部：尾部才是断点。 */
const CONTINUE_TEXT_MAX = 32 * 1024;

/**
 * ROUTER_CONTINUE_MAX 的默认值与取值范围（0 等于关闭）。
 *
 * 范围要导出：面板的输入框边界、setConfigValue 的提示语、这里的夹取，三处读同一份。
 * 各写一份字面量的话，总有一天面板写着 0–5 而实际夹到 0–3。
 */
export const CONTINUE_MAX_DEFAULT = 2;
export const CONTINUE_MAX_MIN = 0;
export const CONTINUE_MAX_MAX = 5;

/**
 * 续写开关：默认关。与两个上限同一套读法，直接在答复里读，不走参数。
 *
 * 默认关是钉住的：生产上「静默就写 error 事件」是既有行为，续写是新能力，
 * 不打开就一个字节都不改。
 */
function continueOnIdleEnabled(): boolean {
  return configFlag("ROUTER_CONTINUE_ON_IDLE", false);
}

/**
 * Retryable idle errors are opt-in because they change bytes on the wire; with
 * the flag off every client keeps seeing exactly what it sees today
 */
function idleErrorRetryableEnabled(): boolean {
  return configFlag("ROUTER_IDLE_ERROR_RETRYABLE", false);
}

/**
 * Only mid-stream silence is rewritten: a first-frame timeout happens before
 * headers are out, so the caller can still switch targets instead
 */
function retryableIdleMessage(e: unknown): string | null {
  if (!(e instanceof StreamIdleError) || e.phase !== "mid-stream") return null;
  if (!idleErrorRetryableEnabled() || continueOnIdleEnabled()) return null;
  const seconds = e.idleMs / 1000;
  return `upstream timed out after ${seconds}s mid-stream: no data received for ${seconds}s`;
}

/** Every other failure keeps its existing error frame byte for byte */
function openAIErrorFrame(e: unknown): string | null {
  const message = retryableIdleMessage(e);
  if (message === null) return null;
  return sseData({ error: { type: "server_error", code: "upstream_idle_timeout", message } });
}

let warnedIdleModeConflict = false;

/**
 * The two switches are alternatives, not a hierarchy: when both are on the
 * stream resumes and the retryable failure shape is never used. One warning
 * is enough because this is a configuration mistake, not a per-request event
 */
function noteIdleModeConflict(): void {
  if (warnedIdleModeConflict) return;
  if (!idleErrorRetryableEnabled() || !continueOnIdleEnabled()) return;
  warnedIdleModeConflict = true;
  log.warn("[DELIVER] ROUTER_CONTINUE_ON_IDLE 与 ROUTER_IDLE_ERROR_RETRYABLE 都开着，按续写处理");
}

/**
 * 续写次数：默认 2，范围 0–5。越界夹回范围并 warn 一行（0 等于关闭）。
 *
 * NaN 没有可判的语义，显式回落默认并 warn —— 不能让它变成「次数无限」。
 */
function continueMax(): number {
  const raw = configNumber("ROUTER_CONTINUE_MAX", CONTINUE_MAX_DEFAULT);
  if (Number.isNaN(raw)) {
    log.warn(`[DELIVER] 续写次数 ${raw} 不是有限数，已回落默认 ${CONTINUE_MAX_DEFAULT}`);
    return CONTINUE_MAX_DEFAULT;
  }
  if (raw < CONTINUE_MAX_MIN || raw > CONTINUE_MAX_MAX) {
    const clamped = Math.min(CONTINUE_MAX_MAX, Math.max(CONTINUE_MAX_MIN, raw));
    log.warn(`[DELIVER] 续写次数 ${raw} 越界（${CONTINUE_MAX_MIN}-${CONTINUE_MAX_MAX}），已按 ${clamped} 生效`);
    return clamped;
  }
  return raw;
}

/**
 * 一次答复里已经产出的东西。
 *
 * 只记长度与「在不在途」，不记正文内容（与日志同一规矩）。续写要靠它判断
 * 能不能接上：正文是断点，工具调用在途就拼不回来。
 */
interface ContinueState {
  /** 已写出去的正文（按上游方言累加）。 */
  text: string;
  /** 已写出去的推理（按上游方言累加）。 */
  reasoning: string;
  /** 有没有进行中的工具调用：有就不续写（半截 JSON 拼不回来）。 */
  toolInFlight: boolean;
  /** 已经用掉几次续写。 */
  attempts: number;
}

/**
 * 续写要的「重发」能力：拿已产出的文本与推理，换一条新的上游流。
 *
 * 没传就没有续写能力 —— 调用方（只有开放平台那条路径）决定谁能续。
 */
export type Reopen = (partial: { text: string; reasoning: string }) => Promise<ReadableStream<Uint8Array>>;

/** 已产出的文本超了就取尾部：尾部才是断点，前面的已经写出去了。 */
function tailText(text: string): string {
  return text.length > CONTINUE_TEXT_MAX ? text.slice(text.length - CONTINUE_TEXT_MAX) : text;
}

/**
 * 为什么不能续写；能续写就返回 null。
 *
 * 每一条都是「少一条就按今天的行为失败」的判据：没有重发能力、开关没开、
 * 次数为 0、次数用完、工具调用在途。
 */
function continueBlockedReason(state: ContinueState, reopen: Reopen | undefined): string | null {
  if (!reopen) return "没有续写能力";
  if (!continueOnIdleEnabled()) return "续写开关没开";
  if (continueMax() <= 0) return "续写次数为 0";
  if (state.attempts >= continueMax()) return "次数用完";
  if (state.toolInFlight) return "工具调用在途";
  return null;
}
/** 「再拿一条上游流」的结果：拿到下一条，或者不能续了（带上该收尾的错）。 */
type ContinueOutcome =
  | { kind: "stream"; stream: ReadableStream<Uint8Array> }
  | { kind: "blocked"; error: unknown };

/**
 * 「再拿一条上游流」这件事：能续就给出下一条（各自过同一道安静闸），
 * 不能续就给出该按哪个错收尾。
 *
 * 次数在这里加：加了才去问还能不能续，所以续写自己再失败时次数已经吃掉
 * 一次，上限兜住，不会无限续。续写请求自己没成（没发出去、被上游拒了）
 * 按那条错收尾，不再拿同一条请求重试。
 */
async function continueWith(
  state: ContinueState,
  reopen: Reopen | undefined,
  error: unknown,
  label: string,
): Promise<ContinueOutcome> {
  const why = continueBlockedReason(state, reopen);
  // `!reopen` 在判据里已经覆盖，这里再写一次是给类型收窄：走到下面调用
  // reopen 时它一定在。
  if (why || !reopen) {
    // 不续写的时候一定要留一句为什么：从外面只看得见「客户端收到 error 事件」，
    // 到底是开关没开、没重发能力、次数用完还是工具调用在途，只有这里知道。
    log.warn(`[DELIVER] 静默后不续写：${why ?? "没有重发能力"}（已产出 ${state.text.length} 字，已续 ${state.attempts} 次）`);
    return { kind: "blocked", error };
  }
  state.attempts++;
  log.warn(`[DELIVER] 流中途静默 ${idleSpan(idleMsOf(error))}，第 ${state.attempts} 次续写（已有 ${state.text.length} 字）`);
  try {
    const following = await reopen({ text: tailText(state.text), reasoning: tailText(state.reasoning) });
    return { kind: "stream", stream: withStreamIdle(following, label) };
  } catch (e) {
    return { kind: "blocked", error: e };
  }
}

/** OpenAI 方言的一帧里产出了什么（正文、推理、工具调用在途）。 */
function trackOpenAIChunk(chunk: Json, state: ContinueState): void {
  const delta = (chunk as { choices?: Array<{ delta?: Json }> })?.choices?.[0]?.delta;
  if (!delta || typeof delta !== "object") return;
  const d = delta as Json;
  if (typeof d.content === "string" && d.content) state.text += d.content;
  const reasoning = typeof d.reasoning_content === "string" ? d.reasoning_content : d.reasoning;
  if (typeof reasoning === "string" && reasoning) state.reasoning += reasoning;
  if (Array.isArray(d.tool_calls) && d.tool_calls.length > 0) state.toolInFlight = true;
}
/** 一帧是不是「只带角色」的开场帧：续写的轮次不重发它（角色已经立过了）。 */
function isRoleOnlyChunk(chunk: Json): boolean {
  const delta = (chunk as { choices?: Array<{ delta?: Json }> })?.choices?.[0]?.delta;
  if (!delta || typeof delta !== "object") return false;
  const d = delta as Json;
  if (d.role === undefined) return false;
  return !d.content && !d.reasoning_content && !d.reasoning && !Array.isArray(d.tool_calls);
}


/** 「安静了多久」，写进句子给人看：一秒以内说毫秒，不然说秒。 */
function idleSpan(idleMs: number): string {
  return idleMs < 1000 ? `${idleMs}ms` : `${Math.round(idleMs / 1000)}s`;
}
/** 出错时「静默了多久」：只有流安静那道闸给得出这个数，别的错没有。 */
function idleMsOf(error: unknown): number {
  return error instanceof StreamIdleError ? error.idleMs : 0;
}

/**
 * 两道闸的取值：调用方给的优先，没给就按设置里的那一份（环境变量或面板）。
 *
 * 关闸（0 或负数）要打一行 warn：生产旋钮能悄无声息把闸关掉，上游于是可以
 * 永远不说话，而这条请求一直挂着。关闸本身是允许的（自测要用），但不能是
 * 悄悄的 —— 出了问题得能在日志里看见是谁把闸关了，关的是哪一道。
 *
 * 两个入口（字节流与已经解析好的帧）共用这一份：两道理应同语义，取值也该
 * 只有一个来源。
 */
function idleGates(limits: { firstFrameMs?: number; idleMs?: number }): { firstFrameMs: number; idleMs: number } {
  // Read once here, at the start of an answer, and never again while it runs:
  // these two numbers are the deadlines this answer is measured against, and a
  // panel change landing mid-stream must not move a deadline that is already
  // being counted. Reading here is also what makes them hot — the next request
  // picks the new value up
  const rawFirstFrameMs = limits.firstFrameMs ?? configNumber("ROUTER_FIRST_FRAME_MS", STREAM_FIRST_FRAME_DEFAULT_MS);
  const rawIdleMs = limits.idleMs ?? configNumber("ROUTER_STREAM_IDLE_MS", STREAM_IDLE_DEFAULT_MS);
  // 夹到上限：闸门不能比下层的超时更严，否则掐断的是下层，客户端看到的是
  // Node 那句 `terminated`，我们的配置与文案全成了摆设。被夹了要说出来 ——
  // 悄悄改掉别人填的数，比不改更坏。
  //
  // NaN 在 clampStreamLimit 里没有可判的语义（见那儿的注释），被原样交回；
  // 这里知道该回落哪个默认值，所以显式回落并 warn。不能让它到达 setTimeout ——
  // Node 会把 NaN 当 0，定时器 1ms 就触发，一条还在想的流会被瞬间掐断。
  let firstFrameMs = clampStreamLimit(rawFirstFrameMs);
  let idleMs = clampStreamLimit(rawIdleMs);
  if (Number.isNaN(firstFrameMs)) {
    firstFrameMs = STREAM_FIRST_FRAME_DEFAULT_MS;
    log.warn(`[DELIVER] 首帧上限 ${rawFirstFrameMs} 不是有限数，已回落默认 ${firstFrameMs}`);
  }
  if (Number.isNaN(idleMs)) {
    idleMs = STREAM_IDLE_DEFAULT_MS;
    log.warn(`[DELIVER] 空闲上限 ${rawIdleMs} 不是有限数，已回落默认 ${idleMs}`);
  }
  if (streamLimitWasCapped(rawFirstFrameMs)) {
    log.warn(`[DELIVER] 首帧上限 ${rawFirstFrameMs} 超过上限，已按 ${firstFrameMs} 生效`);
  }
  if (streamLimitWasCapped(rawIdleMs)) {
    log.warn(`[DELIVER] 空闲上限 ${rawIdleMs} 超过上限，已按 ${idleMs} 生效`);
  }
  if (!(firstFrameMs > 0)) log.warn(`[DELIVER] 首帧上限被设成 ${firstFrameMs}，等第一帧不再有超时`);
  if (!(idleMs > 0)) log.warn(`[DELIVER] 空闲上限被设成 ${idleMs}，流中途不再有超时`);
  return { firstFrameMs, idleMs };
}

/**
 * 这块字节是不是**只有心跳**。
 *
 * SSE 的心跳是一条注释行（`: ping`），有些上游还会偶尔吐一个零长度的块 ——
 * 两者都不是「答复开始说话了」。这个区分很要紧：第一帧的额度是按「从开始等到
 * 现在」算的死线（见 withStreamIdle），心跳如果也算一帧，死线就会被一次次提前
 * 换成中途那个短窗口 —— 一条「先发心跳、再慢慢想两百秒」的流就被砍在中途了。
 *
 * 零长度的块同样不算：它连一行都没有。
 */
function isHeartbeatOnly(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;
  const text = new TextDecoder().decode(bytes);
  return !text.split("\n").some((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith(":");
  });
}

/** 这次安静是等第一帧，还是流中途。两个上限不同，句子也要说清是哪一种。 */
export type StreamPhase = "first-frame" | "mid-stream";

/**
 * 上游不说话了。
 *
 * `name` 是 `TimeoutError`：`classifyUpstreamError` 认这个名字，日志里因此是
 * timeout 而不是 unknown，策略也照「上游太慢」处理（换一个账号也许答得出来）。
 *
 * `message` 是人话：它是客户端唯一能看到的那一句，所以要说清是等第一帧等到
 * 了上限，还是流开到一半停住了 —— 那两件事该做的事不一样。
 */
export class StreamIdleError extends Error {
  readonly idleMs: number;
  readonly label: string;
  readonly phase: StreamPhase;

  constructor(idleMs: number, label: string, phase: StreamPhase) {
    super(
      phase === "first-frame"
        ? `upstream sent nothing for ${idleSpan(idleMs)} waiting for the first frame (${label})`
        : `upstream sent nothing for ${idleSpan(idleMs)} mid-stream (${label})`,
    );
    this.name = "TimeoutError";
    this.idleMs = idleMs;
    this.label = label;
    this.phase = phase;
  }
}

/**
 * 上游安静了就当作它不会再说话。
 *
 * 量的是**两帧之间**的安静，不是总时长：每收到一帧就重新计时，所以一条很长
 * 但一直在吐字的流（每 10 秒一帧、跑 10 分钟）不会被判超时。一帧都没有的等待
 * 也算安静。
 *
 * 两个上限、两个值：等**第一帧**用 `firstFrameMs`，之后的每一帧用 `idleMs`。
 * 量的是同一件事（上游多久没说话），但该等多久不一样 —— 推理模型的第一个
 * token 常常要两分多钟，而流开到一半停住三分钟就是停住了。实现只有这一份，
 * 只是第一帧之后换用 `idleMs`。
 *
 * 两个阶段量法不同：中途是**滑动**的（每收到一帧就重新计时），首帧是一个**绝对
 * 死线**（从开始等到现在，谁都不重置）。心跳与零长度的块不是「开始说话了」
 * （见 isHeartbeatOnly），否则一个先发心跳、再慢慢想的流就会被中途那个短窗口
 * 砍掉。
 *
 * 超时后把上游那一侧取消掉（不取消，那条连接还挂着，账号也还占着），然后把
 * 错误交给调用方：第一帧就超时的时候头还没发出去，路由层还能换一个目标；
 * 中途超时的时候头已经发了，那一层会把它写成一条 error 事件。
 *
 * 只包上游这一侧，不包发往客户端的帧：客户端读得慢是另一件事（见上面的看门
 * 狗），把它也算成「上游安静了」会切掉一条正在正常前进的答复。
 *
 * 上限给 0 或负数就是不设这道闸（两个值各管各的）。
 *
 * 导出给测试用："计时只在有 pending read 的时候走" 这条语义在转发链路上看不
 * 出来（peekStream 与写帧循环一直在读，pending read 总是在），只有在它就是
 * 顶层消费方的时候量得到。
 */
export function withStreamIdle(
  body: ReadableStream<Uint8Array>,
  label: string,
  limits: { firstFrameMs?: number; idleMs?: number } = {},
): ReadableStream<Uint8Array> {
  const { firstFrameMs, idleMs } = idleGates(limits);
  if (!(firstFrameMs > 0) && !(idleMs > 0)) return body;
  const reader = body.getReader();
  // 还在等第一帧的时候，这个上限量的是一次**死线**，不随读取重置：心跳、零
  // 长度的块、`event: ping` 这些都不是「上游开始说话了」，按它们重置的话，
  // 一条「先发心跳、再慢慢想两百秒才出第一个 token」的流就被中途那个短窗口
  // 砍掉了，首帧那个更长的额度白设。
  const firstDeadline = firstFrameMs > 0 ? Date.now() + firstFrameMs : 0;
  // 见到过真正的帧没有：见过之后才换成中途那个滑动的窗口。
  let sawFrame = false;
  let timer: NodeJS.Timeout | null = null;
  const clearTimer = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
  };

  /** 等下一帧，或者等安静到上限。 */
  const nextChunk = (): Promise<ReadableStreamReadResult<Uint8Array>> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const phase: StreamPhase = sawFrame ? "mid-stream" : "first-frame";
      // 首帧阶段量的是「从现在到那道死线还剩多久」，中途才是「上一帧之后静了多久」。
      const limit = phase === "first-frame" ? firstFrameMs : idleMs;
      const waitMs = phase === "first-frame" ? firstDeadline - Date.now() : idleMs;
      const quiet = (): void => {
        // 上游那一侧停手：安静到这个地步，挂着只是白占连接与账号。
        void reader.cancel("the upstream went quiet").catch(() => {
          /* 上游自己已经结束了 */
        });
        reject(new StreamIdleError(limit, label, phase));
      };
      if (limit > 0 && waitMs <= 0) {
        // 死线已经过去了（心跳与零长度的块不会把它往后推）：立刻算超时，
        // 不必再挂一个马上就到点的定时器。
        settled = true;
        quiet();
        return;
      }
      if (limit > 0) {
        timer = setTimeout(() => {
          timer = null;
          if (settled) return;
          settled = true;
          quiet();
        }, waitMs);
        // 这个定时器不该让进程活着。
        timer.unref?.();
      }
      reader.read().then(
        (result) => {
          if (settled) return;
          settled = true;
          clearTimer();
          // 心跳与零长度的块不算「见到了第一帧」：它们说的是「还活着」，不是
          // 「开始说话了」。
          if (!result.done && !isHeartbeatOnly(result.value)) sawFrame = true;
          resolve(result);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimer();
          reject(error);
        },
      );
    });

  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await nextChunk();
        } catch (e) {
          clearTimer();
          controller.error(e);
          return;
        }
        if (result.done) {
          controller.close();
          return;
        }
        controller.enqueue(result.value);
      },
      async cancel(reason) {
        // 客户端走了：计时停下，上游那一侧的 reader 交回去取消。
        clearTimer();
        try {
          await reader.cancel(reason);
        } catch {
          /* 已经结束了 */
        }
      },
    },
    // 默认的 highWaterMark 是 1：交出去一帧之后还会预取一帧，于是客户端读得
    // 慢、我们自己在背压里等的时候，`pull` 照样被叫着、计时照样走 —— 量到的
    // 是「客户端还没来读」而不是「上游安静了」。慢客户端于是被当成安静的上游
    // 砍掉，连已经缓冲好的帧一起丢。0 让 pull 只在真的有 pending read 时触发，
    // 与上面「量的是上游两帧之间的安静」那句话一致。
    { highWaterMark: 0 },
  );
}

/**
 * 跑一次，超过 `ms` 就算它不会回来了。
 *
 * `onTimeout` 在那里才造错：错里要带的是这一次的 phase 与上限，而不是调用
 * 时就定下来的那一个（流中途换的是另一个上限）。
 */
function within<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(onTimeout());
    }, ms);
    // 这个定时器不该让进程活着。
    timer.unref?.();
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * 已经解析好的帧同样要有个尽头（`deliverOpenAIChunks` 走的是这条路）。
 *
 * 同语义的意思是同一套东西：首帧是一个**绝对死线**（心跳与零长度的块都不
 * 重置，尽管这条路上通常没有心跳可看），之后用 `idleMs` 的滑动窗口；超时
 * 抛同一个 `StreamIdleError`、同样两个 phase 文案 —— 客户端与日志看到的
 * 完全是同一件事，不管上游是哪一种协议。
 *
 * 这条路上原先是靠 undici 那个 5 分钟的 bodyTimeout 兜底的：客户端干等五分
 * 钟，最后收到的是 Node 自己那句 `terminated`。三个入口现在一张牌。
 *
 * 超时之后把上游那一侧的迭代器收掉（`return`）。**不等它**：一条停在「永远
 * 不会回来的 next」上的迭代器，await 它就是把这个请求挂死在上游身上。
 */
export function withIteratorIdle<T>(
  source: AsyncIterable<T>,
  label: string,
  limits: { firstFrameMs?: number; idleMs?: number } = {},
): AsyncIterable<T> {
  const { firstFrameMs, idleMs } = idleGates(limits);
  if (!(firstFrameMs > 0) && !(idleMs > 0)) return source;
  return {
    [Symbol.asyncIterator]: () => iterateWithIdle(source, label, firstFrameMs, idleMs),
  };
}

async function* iterateWithIdle<T>(
  source: AsyncIterable<T>,
  label: string,
  firstFrameMs: number,
  idleMs: number,
): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  // 见 withStreamIdle：首帧量的是死线，不随读取重置。
  const firstDeadline = firstFrameMs > 0 ? Date.now() + firstFrameMs : 0;
  let sawFrame = false;
  try {
    for (;;) {
      const phase: StreamPhase = sawFrame ? "mid-stream" : "first-frame";
      const limit = phase === "first-frame" ? firstFrameMs : idleMs;
      const waitMs = phase === "first-frame" ? firstDeadline - Date.now() : idleMs;
      const idle = (): StreamIdleError => new StreamIdleError(limit, label, phase);
      let next: IteratorResult<T>;
      if (!(limit > 0)) {
        // 这一段不设闸（两个值各管各的）。
        next = await iterator.next();
      } else if (waitMs <= 0) {
        // 死线已经到了：不再挂一个马上就到点的定时器，直接算超时。
        throw idle();
      } else {
        next = await within(Promise.resolve(iterator.next()), waitMs, idle);
      }
      if (next.done) return;
      sawFrame = true;
      yield next.value;
    }
  } finally {
    // 上游那一侧收工。不 await —— 喊停就够了，等一个不回来的 next 就是把
    // 这条请求挂死在上游身上（见上面的注释）。
    void Promise.resolve(iterator.return?.(undefined)).catch(() => {
      /* 已经结束了 */
    });
  }
}

/**
 * Look at the first chunk before committing to a 200 response.
 *
 * The gateway can report a failure inside a 200 response (an SSE error event, or
 * a 429 body). If the headers were already sent there is no way to turn that
 * into a proper status code, so the check happens first.
 */
export async function peekStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  let first: { done: boolean; value?: Uint8Array };
  try {
    first = await readOrAbort(reader, signal);
  } catch (e) {
    await cancelReader(reader);
    throw e;
  }
  if (signal?.aborted) {
    // 客户端在上游的第一帧之前就走了：这条流不该接着算（还在计费）。
    await cancelReader(reader);
    throw new ClientGoneError();
  }
  if (first.done) {
    reader.releaseLock();
    return body;
  }
  const head = new TextDecoder().decode(first.value);
  if (looksLikeErrorPayload(head)) {
    const text = await drainText(reader, head);
    // 上游原话进 hint：它才是「为什么拒」，客户端与状态原因都读 hint。
    // message 保持通用 —— 它被当成「哪一类失败」的标签，塞进上游正文会把
    // 分类和面板文案一起搅乱。
    // 抹一遍再出去：这句话进客户端读的 hint（上游的正文里可能有 key 片段、
    // 邮箱、cookie），规矩与日志那边同一套（见 lib/log-scrub.ts）。
    let said = scrubForClient(text.trim(), 300);
    const parsed = payloadIn(text);
    if (parsed) {
      const detail = parsed?.error ?? parsed;
      // An empty sentence is no sentence: fall back to the raw body.
      // `msg` 是平台自己说的那句（WorkBuddy 的渠道校验就是它），`message` 是
      // 另一种写法。两个都看。
      const words =
        typeof detail === "string"
          ? detail
          : detail?.message || detail?.msg || parsed?.message || parsed?.msg;
      if (typeof words === "string" && words) said = scrubForClient(words, 300);
    }
    log.warn("[DELIVER] 上游在正文里报错：" + scrubForLog(said, 200));
    // 上游有时用 200 回一个错（渠道校验就是）。码要带上，否则日志里看不见
    // 11128：状态码说的是 200，看着像成功。
    //
    // 码从**解析出来的那个 payload** 里读，不是从正文里再 parse 一次：正文
    // 可能带着 `data:` 前缀（SSE 的一帧），直接 parse 整个正文会失败。
    const error = new AuthError("upstream rejected the request", said, 502);
    const code = businessCodeOfPayload(parsed);
    if (code !== null) withBusinessCode(error, code);
    throw error;
  }
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(first.value);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      reader.cancel(reason);
    },
  });
}

/**
 * The error a failed answer becomes, with the upstream's own message.
 *
 * The answer carries the failure inside the body (an OpenAI `error` object);
 * this turns it into the error the client sees.
 */
export function errorFromUpstreamPayload(detail: any): AuthError {
  return new AuthError(
    `upstream error (${detail?.type ?? detail?.code ?? "unknown"})`,
    typeof detail?.message === "string"
      ? scrubForClient(detail.message, 300)
      : scrubForClient(JSON.stringify(detail), 300),
    502,
  );
}

/* ---------------- 「第一块内容」这道闸 ---------------- */

/** 扣住的帧最多这么多字节，超过就无条件提交（按今天的自由流继续）。 */
const CONTENT_GATE_MAX_BYTES = 256 * 1024;

/** 扣住的帧最多这么多帧，超过就无条件提交。 */
const CONTENT_GATE_MAX_FRAMES = 1_000;

/** 一个值是不是「非空的内容」：字符串要非空，数组要非空。 */
function isNonEmptyContent(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return false;
}

/** Anthropic 的一份 payload（已解析）是不是对用户可见的内容。 */
function anthropicPayloadIsContent(json: Json): boolean {
  if (!json || typeof json !== "object" || Array.isArray(json)) return false;
  const type = json.type;
  if (type === "content_block_delta") {
    const delta = json.delta;
    if (!delta || typeof delta !== "object") return false;
    if (delta.type === "text_delta") return isNonEmptyContent(delta.text);
    if (delta.type === "thinking_delta") return isNonEmptyContent(delta.thinking);
    if (delta.type === "input_json_delta") return isNonEmptyContent(delta.partial_json);
    return false;
  }
  if (type === "content_block_start") {
    const block = json.content_block;
    if (!block || typeof block !== "object") return false;
    return block.type === "tool_use" && (Boolean(block.id) || Boolean(block.name));
  }
  return false;
}

/** OpenAI 的一份 payload（已解析）是不是对用户可见的内容。 */
function openaiPayloadIsContent(json: Json): boolean {
  if (!json || typeof json !== "object" || Array.isArray(json)) return false;
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return false;
  const delta = choices[0]?.delta;
  if (!delta || typeof delta !== "object") return false;
  return (
    isNonEmptyContent(delta.content) ||
    isNonEmptyContent(delta.reasoning_content) ||
    isNonEmptyContent(delta.tool_calls)
  );
}

/** 一帧原始 SSE 文本：事件名与数据 payload。 */
interface RawSseFrame {
  event?: string;
  data: string;
}

/** 把一帧原始 SSE 文本拆成事件名与数据（与 readSseEvents 同一套解析）。 */
function parseRawSseFrame(raw: string): RawSseFrame | undefined {
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed === "") continue;
    if (trimmed.startsWith(":")) continue;
    if (trimmed.startsWith("event:")) {
      event = trimmed.slice(6).trim();
      continue;
    }
    if (trimmed.startsWith("data:")) {
      dataLines.push(trimmed.slice(5).replace(/^ /, ""));
      continue;
    }
    if (dataLines.length) dataLines.push(trimmed);
  }
  if (!dataLines.length) return undefined;
  const data = dataLines.join("\n");
  return event ? { event, data } : { data };
}

/** 把扣住的帧按原顺序写出去，然后接着读上游。 */
function replayHeld(held: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of held) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      reader.cancel(reason);
    },
  });
}

/**
 * 把上游的帧扣在手里，直到出现第一块对用户可见的内容。
 *
 * 头一落地（flushHeaders），路由层就换不了目标了。旧判据是「收到第一块字节」——
 * Anthropic 的 message_start 几乎立刻就到，可它只是信封，客户端一个字内容都没收到，
 * 路由层已经没有换目标的机会（客户端拿到的是 200 里藏一句 error）。判据改成
 * 「收到第一块对用户可见的内容」：信封扣住，内容一到就提交（把扣住的帧按原顺序
 * 逐字节写出去）；在那之前上游失败或静默，原样抛出，路由层自然换下一个目标。
 *
 * 缓冲有上限：字节数或帧数超了就无条件提交，按今天的自由流继续 —— 慢流不该被
 * 整条扣住。
 */
async function gateUntilContent(
  body: ReadableStream<Uint8Array>,
  dialect: UpstreamDialect,
  signal?: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const held: Uint8Array[] = [];
  let heldBytes = 0;
  let frameCount = 0;
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await readOrAbort(reader, signal);
      if (signal?.aborted) {
        await cancelReader(reader);
        throw new ClientGoneError();
      }
      if (done) break;
      if (!value || value.length === 0) continue;
      held.push(value);
      heldBytes += value.length;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const frame = parseRawSseFrame(raw);
        if (!frame) continue;
        frameCount++;
        if (looksLikeErrorPayload(frame.data)) {
          await cancelReader(reader);
          throw errorFromUpstreamPayload(payloadIn(frame.data) ?? frame.data);
        }
        let json: Json;
        try {
          json = parseLooseJson(frame.data);
        } catch {
          continue;
        }
        const isContent = dialect === "anthropic" ? anthropicPayloadIsContent(json) : openaiPayloadIsContent(json);
        if (isContent) {
          return replayHeld(held, reader);
        }
      }
      if (heldBytes > CONTENT_GATE_MAX_BYTES || frameCount > CONTENT_GATE_MAX_FRAMES) {
        return replayHeld(held, reader);
      }
    }
  } catch (e) {
    await cancelReader(reader);
    throw e;
  }

  return replayHeld(held, reader);
}

/**
 * 把已经解析好的帧扣在手里，直到出现第一块对用户可见的内容。
 *
 * 与 gateUntilContent 同语义：内容一到就提交，之前上游失败或静默就原样抛出。
 */
async function gateChunksUntilContent(iterator: AsyncIterator<Json>): Promise<Json[]> {
  const held: Json[] = [];
  let heldBytes = 0;
  let frameCount = 0;

  for (;;) {
    const next: IteratorResult<Json> = await iterator.next();
    if (next.done) break;
    held.push(next.value);
    frameCount++;
    heldBytes += JSON.stringify(next.value ?? null).length;
    if (openaiPayloadIsContent(next.value)) return held;
    if (heldBytes > CONTENT_GATE_MAX_BYTES || frameCount > CONTENT_GATE_MAX_FRAMES) return held;
  }

  return held;
}

/** The whole answer, for a client that did not ask for a stream. */
export function deliverJson(
  ctx: Koa.Context,
  dialect: Dialect,
  from: UpstreamDialect,
  json: any,
  model: string,
  onUsage?: (usage: any) => void,
): void {
  if (from === "openai" && json?.error) throw errorFromUpstreamPayload(json.error);
  const payload =
    dialect === from
      ? json
      : from === "openai"
        ? openaiToAnthropicResponse(json, model)
        : anthropicToOpenAIResponse(json, model);
  // The answer names the model the client asked for. The upstream may know it
  // by another name — a tier key, or the name behind a published model — but
  // the client asked for this one. Both dialects: an Anthropic answer that
  // names the upstream's model is as confusing as an OpenAI one.
  if (payload && typeof payload === "object") {
    payload.model = model;
  }
  onUsage?.(payload?.usage);
  ctx.body = payload;
}

/** Only structural counts — no answer text ever leaves this layer. */
export interface AnswerSegments {
  content: number;
  thinking: number;
  tool: number;
}

/** What the upstream said about how it ended, without any of the answer itself. */
export interface AnswerFinish extends AnswerSegments {
  reason: string;
}

function countOpenAISegments(chunk: Json, counts: AnswerSegments): void {
  const delta = (chunk as { choices?: Array<{ delta?: Json }> })?.choices?.[0]?.delta;
  if (!delta || typeof delta !== "object") return;
  const d = delta as Json;
  if ("content" in d && d.content) counts.content++;
  if (("reasoning_content" in d && d.reasoning_content) || ("reasoning" in d && d.reasoning)) counts.thinking++;
  if ("tool_calls" in d && d.tool_calls) counts.tool++;
}

/**
 * Watch the chunks for the upstream's finish reason.
 *
 * A client that asked for a handful of tokens gets a handful of tokens and an
 * upstream that says it stopped there. That is what the client asked for, but
 * from the outside it looks like a broken answer, so the reason is handed to
 * whoever wants to say so in the log.
 */
async function* watchFinish(
  chunks: AsyncIterable<Json>,
  onFinish?: (finish: AnswerFinish) => void,
  onUsage?: (usage: any) => void,
): AsyncGenerator<Json> {
  const counts: AnswerSegments = { content: 0, thinking: 0, tool: 0 };
  let reason: string | undefined;
  for await (const chunk of chunks) {
    countOpenAISegments(chunk, counts);
    const found = chunk?.choices?.[0]?.finish_reason;
    if (found) reason = String(found);
    if (chunk?.usage && onUsage) onUsage(chunk.usage);
    yield chunk;
  }
  if (onFinish && (reason || counts.content + counts.thinking + counts.tool > 0)) {
    onFinish({ reason: reason ?? "未给", ...counts });
  }
}

/**
 * 把一条条上游流接成一个 OpenAI 帧的迭代：每条流出错就问「还能不能再来一条」。
 *
 * 续写把好几条流接成一条答复，转换器（openaiStreamToAnthropic）的内部状态
 * ——开场帧、内容块编号、收尾帧——必须跨流留住。每条流换一个转换器会重发
 * 开场帧、重发 content_block_start：块编号被顶掉，客户端按索引累积时前半截
 * 正文就没了。所以转换器只建一个，喂给它的是这个「一条接一条」的迭代。
 *
 * 每一段各自过安静闸（在调用方套好的 withStreamIdle 里）：哪一段静默就抛
 * 哪一段的错。不能续的时候把该收尾的错原样抛出去，由调用方按今天的方式收尾。
 */
async function* chainedOpenAIChunks(
  first: ReadableStream<Uint8Array>,
  next: (error: unknown) => Promise<ContinueOutcome>,
  signal: AbortSignal,
  state: ContinueState,
): AsyncGenerator<Json> {
  let current: ReadableStream<Uint8Array> | null = first;
  while (current) {
    try {
      for await (const chunk of readOpenAIChunks(current, signal)) {
        trackOpenAIChunk(chunk, state);
        yield chunk;
      }
      current = null;
    } catch (e) {
      const outcome = await next(e);
      if (outcome.kind === "blocked") {
        throw outcome.error;
      }
      current = outcome.stream;
    }
  }
}


/**
 * A stream of OpenAI chunks.
 *
 * The frames are parsed and written out again rather than copied, because an
 * upstream frame can be malformed — Qoder's last frame carries a raw newline
 * inside a string — and a client that cannot parse it loses the finish reason
 * and the usage with it.
 *
 * `onFailure` is called when the upstream stream breaks. The client gets an
 * error event either way; the caller is told too, because a stream that broke
 * is a failed call — the account is the one to blame, and the caller settles
 * it (see lib/router/upstreams/policy.ts).
 */
export async function deliverOpenAIStream(
  ctx: Koa.Context,
  body: ReadableStream<Uint8Array>,
  dialect: Dialect,
  model: string,
  onFinish?: (finish: AnswerFinish) => void,
  onUsage?: (usage: any) => void,
  onFailure?: (error: unknown) => void,
  reopen?: Reopen,
): Promise<void> {
  ctx.res.setHeader("x-request-id", rid("req_"));
  noteIdleModeConflict();
  // 客户端走了的时候，这个信号让读上游的那个循环停下来。
  const abort = new AbortController();
  // **先**把「客户端走了」这件事听上，再去等上游的第一帧。
  //
  // 推理模型的第一帧可能要等几十秒。这段时间里客户端按了取消（连接断了）：
  // 之前没人听这件事 —— 上游接着算，账号照付这几十秒，客户端一个字没拿到
  // （2026-11-03，作者复查发现）。
  const state = replyState(ctx);
  state.onGone = () => abort.abort();
  // 客户端在挂上监听器之前就走了：那个事件没人听见。这里补一次。
  if (state.gone) abort.abort();
  let upstream: ReadableStream<Uint8Array>;
  try {
    // 等上游的**第一帧**也要算进「安静」，而且量的是**首帧那个上限**（比中途
    // 那个长：推理模型的第一个 token 常常要两分多钟）。
    upstream = await peekStream(withStreamIdle(body, `model=${model}`), abort.signal);
    // 第一帧读到不等于答复开始：信封扣住，等第一块对用户可见的内容。内容之前
    // 上游失败或静默，头还没发，原样抛出换目标。
    upstream = await gateUntilContent(upstream, "openai", abort.signal);
  } catch (e) {
    if (e instanceof ClientGoneError) {
      reportClientGone(ctx, onFailure);
      ctx.res.end();
      return;
    }
    // 内容还没出现：**头还没发出去**，所以往外抛 —— 路由层还能换一个账号
    // 或目标，客户端最后拿到的是真实状态与上游原话。
    //
    // 以前这里把错吞成一条 error 帧（头在那之前就发了），换不了目标：生产上
    // fallback 的第三跳首帧就是 403，客户端拿到的是 200 里藏一句 error。
    log.warn(`[DELIVER] 上游在内容出现之前就失败了：${failureLine(e)}`);
    reportFailure(onFailure, e);
    // 响应从没接管过：它还是 Koa 的，调用方写的 sendError 才会落到 socket 上。
    throw e;
  }
  // 第一块内容读到了：现在才接管响应、发头。
  takeOver(ctx);
  sseHead(ctx);
  // 看门狗断开连接时（客户端不读了）也要停上游：它还在吐字就是在计费。
  onClientGone(ctx, upstream, abort);
  if (dialect === "openai") {
    await pipeOpenAIChunks(upstream, ctx, onFinish, onUsage, model, onFailure, abort, reopen);
    return;
  }
  // 续写：一条答复一个转换器，多轮上游流在它下游串起来（见 chainedOpenAIChunks）
  // ——每条流换一个转换器会重发开场帧、重发 content_block_start，块编号被顶掉。
  const continueState: ContinueState = { text: "", reasoning: "", toolInFlight: false, attempts: 0 };
  let current = upstream;
  const nextStream = async (e: unknown): Promise<ContinueOutcome> => {
    const outcome = await continueWith(continueState, reopen, e, `model=${model}`);
    if (outcome.kind === "stream") {
      current = outcome.stream;
      // 新一段也要挂上「客户端走了就停」：看门狗认的是当前这一段。
      onClientGone(ctx, current, abort);
    }
    return outcome;
  };
  try {
    for await (const chunk of openaiStreamToAnthropic(
      watchFinish(chainedOpenAIChunks(current, nextStream, abort.signal, continueState), onFinish, onUsage),
      model,
    )) {
      if (!(await writeFrame(ctx, chunk))) {
        // 客户端走了：上游也别接着算（还在计费），这一条也不该记成成功。
        await stopUpstream(current, abort);
        reportClientGone(ctx, onFailure);
        break;
      }
    }
    // 上游安静的时候客户端断开：这条请求不算成功（客户端一个字都没拿到）。
    reportClientGone(ctx, onFailure);
  } catch (e) {
    // The headers are already out, so the failure goes back as an error event.
    log.warn(`[DELIVER] 发给客户端的错误事件：${failureLine(e)}`);
    await writeFrame(ctx, errorEvent(clientMessageOf(e)));
    reportFailure(onFailure, e);
    ctx.res.end();
    // 同 pipeOpenAIChunks：字节不变，错抛给调用方记账（头已发，换不了目标，
    // 调用方按失败收尾）。
    throw e;
  }
  ctx.res.end();
}

/**
 * 客户端走了（连接断了，或者它不读了，被看门狗断开）。
 *
 * 这不是上游的错：账号没有问题，答复只是没人要。所以它不带上游状态，也不带
 * 业务码 —— 分类器会把它算成「不可降级」，账号不会被记冷却。
 */
export class ClientGoneError extends Error {
  constructor() {
    super("the client went away before the answer was finished");
    this.name = "ClientGoneError";
  }
}

/** A stream of Anthropic bytes. */
export async function deliverAnthropicStream(
  ctx: Koa.Context,
  body: ReadableStream<Uint8Array>,
  dialect: Dialect,
  model: string,
  pingMs = 0,
  onUsage?: (usage: any) => void,
  onFailure?: (error: unknown) => void,
  onFinish?: (finish: AnswerFinish) => void,
): Promise<void> {
  ctx.res.setHeader("x-request-id", rid("req_"));
  noteIdleModeConflict();
  // 客户端走了的时候，这个信号让读上游的那个循环停下来。
  const abort = new AbortController();
  // **先**把「客户端走了」这件事听上，再去等上游的第一帧：第一帧可能要等
  // 几十秒，这段时间里客户端取消的连接没人听，上游就白算（还在计费）。
  const state = replyState(ctx);
  state.onGone = () => abort.abort();
  if (state.gone) abort.abort();
  // 上游安静了就当作它不会再说话。包在 tee 之前：tee 出来的两条支线都从这
  // 一个计时走，源头才不会因为没人读而挂在那里（挂着就是在计费）。
  let upstream: ReadableStream<Uint8Array>;
  try {
    // 第一块内容读到之前不写头：头一落地（flushHeaders），路由层就换不了目标，
    // 客户端拿到的是 200 里藏一句 error；而这里抛出去，它还能换下一个账号或
    // 目标。peek 出来的流把第一块字节原样交回给下面（不丢、不重排），内容闸
    // 再把信封扣住，等第一块对用户可见的内容。
    upstream = await peekStream(withStreamIdle(body, `model=${model}`), abort.signal);
    // 信封扣住，等第一块对用户可见的内容：内容之前上游失败或静默，头还没发，
    // 原样抛出换目标。
    upstream = await gateUntilContent(upstream, "anthropic", abort.signal);
  } catch (e) {
    if (e instanceof ClientGoneError) {
      reportClientGone(ctx, onFailure);
      ctx.res.end();
      return;
    }
    log.warn(`[DELIVER] 上游在内容出现之前就失败了：${failureLine(e)}`);
    reportFailure(onFailure, e);
    // 响应从没接管过：它还是 Koa 的，调用方写的 sendError 才会落到 socket 上。
    throw e;
  }
  // 第一块内容读到了：现在才接管响应、发头。
  takeOver(ctx);
  sseHead(ctx);
  if (dialect === "anthropic") {
    // The bytes go to the client as they are, apart from one thing: the
    // message_start frame names the model, and it has to name the one the
    // client asked for. The upstream may know it by another name — a tier
    // key, or the name behind a published model.
    //
    // A copy is parsed on the side for the usage: the upstream puts the input
    // tokens in message_start and the output tokens in message_delta, and
    // nobody reads those unless someone parses them.
    const [toClient, toParser] = upstream.tee();
    // 看门狗断开连接时（客户端不读了）也要停上游：它还在吐字就是在计费。
    // tee 的两条支线都要取消，源头才停（取消一条，另一条还在读）。
    onClientGoneTee(ctx, [toClient, toParser], abort);
    const parsing = (async () => {
      const counts: AnswerSegments = { content: 0, thinking: 0, tool: 0 };
      let reason: string | undefined;
      try {
        for await (const event of readSseEvents(toParser, abort.signal)) {
          const json = parseLooseJson(event.data);
          if (onUsage && json?.usage) onUsage(json.usage);
          const type = json?.type;
          if (type === "content_block_delta") {
            const deltaType = json?.delta?.type;
            if (deltaType === "text_delta") counts.content++;
            else if (deltaType === "thinking_delta") counts.thinking++;
            else if (deltaType === "input_json_delta") counts.tool++;
          }
          if (type === "message_delta" && json?.delta?.stop_reason) reason = String(json.delta.stop_reason);
        }
      } catch {
        // The usage is a nice-to-have; the answer itself is what matters.
      }
      if (onFinish && (reason || counts.content + counts.thinking + counts.tool > 0)) {
        onFinish({ reason: reason ?? "未给", ...counts });
      }
    })();
    await writeAnthropicFrames(toClient, ctx, model, pingMs, onFailure, abort);
    // 等那条支线也收工：它不收，tee 的源头就还在吐字（还在计费）。
    await parsing;
    return;
  }
  // 看门狗断开连接时（客户端不读了）也要停上游：它还在吐字就是在计费。
  onClientGone(ctx, upstream, abort);
  try {
    const converted: AnswerSegments = { content: 0, thinking: 0, tool: 0 };
    let convertedReason: string | undefined;
    for await (const chunk of anthropicStreamToOpenAI(upstream, model, onUsage, abort.signal)) {
      if (onFinish && chunk.startsWith("data: {")) {
        const frame = parseLooseJson(chunk.slice(6));
        countOpenAISegments(frame, converted);
        if (frame?.choices?.[0]?.finish_reason) convertedReason = String(frame.choices[0].finish_reason);
      }
      if (!(await writeFrame(ctx, chunk))) {
        // 客户端走了：上游也别接着算（还在计费），这一条也不该记成成功。
        await stopUpstream(upstream, abort);
        reportClientGone(ctx, onFailure);
        break;
      }
    }
    // 上游安静的时候客户端断开：这条请求不算成功。
    reportClientGone(ctx, onFailure);
    if (onFinish && (convertedReason || converted.content + converted.thinking + converted.tool > 0)) {
      onFinish({ reason: convertedReason ?? "未给", ...converted });
    }
  } catch (e) {
    log.warn(`[DELIVER] 发给客户端的错误事件：${failureLine(e)}`);
    await writeFrame(ctx, dialect === "openai" ? (openAIErrorFrame(e) ?? errorEvent(clientMessageOf(e))) : errorEvent(clientMessageOf(e)));
    reportFailure(onFailure, e);
    ctx.res.end();
    // Same contract as the OpenAI path: the bytes stay as they are, and the
    // caller settles this answer as a failure instead of a zero-token success.
    throw e;
  }
  ctx.res.end();
}

/**
 * Tell the caller the upstream stream broke.
 *
 * The bookkeeping (the cooldown) must not turn a failed answer into another
 * failure: if the callback throws, the error is swallowed here.
 */
function reportFailure(onFailure: ((error: unknown) => void) | undefined, error: unknown): void {
  if (!onFailure) return;
  try {
    onFailure(error);
  } catch {
    /* 记账失败不许影响答复 */
  }
}

/**
 * 客户端走了：这条请求不算成功，报给调用方。
 *
 * 只报一次：同一个事件有两条路会碰到它（写帧发现客户端没了、上游的流结束
 * 之后回头一看客户端已经没了）。
 *
 * 为什么非报不可：客户端走了但这条请求被记成成功，日志就与事实相反 —— 用量
 * 走的是估算，账号的冷却被清掉，而实际上客户端一个字都没拿到（2026-11-03，
 * 作者复查发现：上游安静的时候客户端断开，两条路上只有一条报了失败）。
 */
function reportClientGone(ctx: Koa.Context, onFailure?: (error: unknown) => void): void {
  const state = replyState(ctx);
  if (!state.gone || state.goneReported) return;
  state.goneReported = true;
  reportFailure(onFailure, new ClientGoneError());
}

/** A stream of OpenAI chunks that are already parsed (the legacy protocol). */
export async function deliverOpenAIChunks(
  ctx: Koa.Context,
  chunks: AsyncIterable<any>,
  dialect: Dialect,
  model: string,
  onUsage?: (usage: any) => void,
  onFailure?: (error: unknown) => void,
): Promise<void> {
  ctx.res.setHeader("x-request-id", rid("req_"));
  noteIdleModeConflict();
  // 第一块内容读到之前不写头：头一落地（flushHeaders），路由层就换不了目标。
  // 读不到内容就往外抛，那一层还能换下一个账号或目标。
  //
  // 这里也计时：已经解析好的帧那个入口原先一点上限都没有，只靠 undici 兼底 ——
  // 另两个入口都有，三个入口该是一套东西（见 withIteratorIdle）。
  const iterator = withIteratorIdle(chunks, `model=${model}`)[Symbol.asyncIterator]();
  let held: Json[];
  try {
    held = await gateChunksUntilContent(iterator);
  } catch (e) {
    log.warn(`[DELIVER] 上游在内容出现之前就失败了：${failureLine(e)}`);
    reportFailure(onFailure, e);
    // 响应从没接管过：它还是 Koa 的，调用方写的 sendError 才会落到 socket 上。
    throw e;
  }
  // 第一块内容读到了（或者上游一字不说就收工了，那是空答复）：现在才接管响应、发头。
  takeOver(ctx);
  sseHead(ctx);
  const source = restoreHeld(held, iterator);
  if (dialect === "openai") {
    try {
      for await (const chunk of source) {
        if (chunk?.usage && onUsage) onUsage(chunk.usage);
        if (model && chunk && typeof chunk === "object") chunk.model = model;
        if (!(await writeFrame(ctx, sseData(chunk)))) {
          reportClientGone(ctx, onFailure);
          break;
        }
      }
      // 上游安静的时候客户端断开：这条请求不算成功。
      reportClientGone(ctx, onFailure);
      await writeFrame(ctx, SSE_DONE);
    } catch (e) {
      log.warn(`[DELIVER] 发给客户端的错误事件：${failureLine(e)}`);
      await writeFrame(ctx, openAIErrorFrame(e) ?? errorEvent(clientMessageOf(e)));
      reportFailure(onFailure, e);
    }
    ctx.res.end();
    return;
  }
  try {
    for await (const chunk of openaiStreamToAnthropic(source, model)) {
      if (!(await writeFrame(ctx, chunk))) {
        reportClientGone(ctx, onFailure);
        break;
      }
    }
    // 上游安静的时候客户端断开：这条请求不算成功。
    reportClientGone(ctx, onFailure);
  } catch (e) {
    log.warn(`[DELIVER] 发给客户端的错误事件：${failureLine(e)}`);
    await writeFrame(ctx, errorEvent(clientMessageOf(e)));
    reportFailure(onFailure, e);
  }
  ctx.res.end();
}

/**
 * Put the frames that were held back in front of the rest.
 *
 * 扣住的帧是在发头之前读的（那时还不知道该不该发一个 200），但它们就是答复的
 * 前几帧：原样交给后面的循环，不能丢也不能重排。
 */
async function* restoreHeld<T>(held: T[], rest: AsyncIterator<T>): AsyncGenerator<T> {
  try {
    for (const item of held) yield item;
    for (;;) {
      const next: IteratorResult<T> = await rest.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    // 循环提前收工（客户端走了）：上游那一侧的生成器也要停下来（它还在计费）。
    try {
      await rest.return?.();
    } catch {
      /* 已经结束了 */
    }
  }
}

function errorEvent(message: string): string {
  return sseEvent("error", { type: "error", error: { type: "api_error", message } });
}

/* ---------------- 发给客户端的那句话 ---------------- */

/** 上游没把话说完就断了。客户端那边看得懂的那一句。 */
const UPSTREAM_CLOSED_EARLY = "upstream closed the connection before the answer finished";

/** 说不出理由时的那一句：客户端得知道这是一次失败，不是答复。 */
const UPSTREAM_FAILED = "upstream failed";

/** Node/undici 说「连接断了」的整句话（整句就是它才算）。 */
const RAW_DISCONNECT_TEXT = new Set(["terminated", "other side closed", "socket hang up"]);

/** 同一种话，但会跟在别的字后面（`TypeError: fetch failed`）。 */
const RAW_DISCONNECT_PARTS = ["fetch failed", "socket hang up", "other side closed"];

/**
 * 这一句是不是 Node/undici 说的「连接断了」。
 *
 * 抛出来的不一定是个 Error（`throw "socket hang up"` 也是合法的），那时只有
 * 一个字符串可看，所以这句话得能单独判断。
 */
function isRawDisconnectText(text: string): boolean {
  const lowered = text.trim().toLowerCase();
  if (RAW_DISCONNECT_TEXT.has(lowered)) return true;
  return RAW_DISCONNECT_PARTS.some((part) => lowered.includes(part));
}

/**
 * 这个错误的理由是不是 Node/undici 说的「连接断了」。
 *
 * undici 抛的就是 `TypeError: terminated`，它自己那句在 `cause` 里（一个
 * `UND_ERR_*` 的错）。这两样都是「我们的连接怎么了」，不是「你的请求怎么了」。
 */
function isRawConnectionFailure(e: unknown): boolean {
  const seen = new Set<unknown>();
  let current: any = e;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (/^UND_ERR_/.test(String(current.code ?? ""))) return true;
    if (isRawDisconnectText(String(current.message ?? ""))) return true;
    current = current.cause;
  }
  return false;
}

/**
 * 客户端看到的那句话。
 *
 * 只翻我们知道的几种内部错误；别的照旧用 message —— 但绝不把 Node 内部字眼
 * （terminated、fetch failed、UND_ERR_*）发给客户端：客户端拿它当「哪一类
 * 失败」用，那种话它既看不懂，也不是它能处理的东西。
 *
 * 只动这一句：`hint` 里是上游原话，那是给客户端出主意的，另有既定语义
 * （见 peekStream 与 sendError）。
 */
export function clientMessageOf(e: unknown): string {
  // 上游安静了：那句人话本来就是我们自己写的。
  if (e instanceof StreamIdleError) return retryableIdleMessage(e) ?? e.message;
  if (isRawConnectionFailure(e)) return UPSTREAM_CLOSED_EARLY;
  // 抛出来的也可以就是个字符串（`throw "socket hang up"`）：那时没有 message，
  // 按以前那样直接落到回落值就把原文丢了 —— 而原文往往是唯一的线索。
  const said = typeof e === "string" ? e : (e as { message?: unknown } | null | undefined)?.message;
  if (typeof said !== "string") return UPSTREAM_FAILED;
  const text = said.trim();
  // 一句空白不是一句话：`new Error("  ")` 不该让客户端收到一个空格。
  if (!text) return UPSTREAM_FAILED;
  if (isRawDisconnectText(text)) return UPSTREAM_CLOSED_EARLY;
  return text;
}

/** One line about a failure, for the log. The stack is too noisy to keep. */
function failureLine(e: unknown): string {
  const message = (e as { message?: unknown })?.message;
  return typeof message === "string" && message ? message : String(e);
}

/**
 * Fix the message_start frame of an upstream Anthropic stream.
 *
 * The upstream may send a message_start whose `message` is missing or null.
 * Clients read `message.usage` from that frame, so a null there crashes the
 * client on the spot and the whole answer is lost — nothing else in the
 * stream matters then. So a minimal legal message is filled in: the numbers
 * in it are zeros, because the upstream never sent any.
 */
export function repairMessageStart(json: any, model: string): { json: any; repaired: boolean } {
  if (!json || typeof json !== "object" || Array.isArray(json)) return { json, repaired: false };
  const message = json.message;
  if (message && typeof message === "object" && !Array.isArray(message)) {
    message.model = model;
    return { json, repaired: false };
  }
  json.message = {
    id: `msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  return { json, repaired: true };
}

/** Forward an OpenAI stream, frame by frame. */
async function pipeOpenAIChunks(
  body: ReadableStream<Uint8Array>,
  ctx: Koa.Context,
  onFinish?: (finish: AnswerFinish) => void,
  onUsage?: (usage: any) => void,
  model?: string,
  onFailure?: (error: unknown) => void,
  abort?: AbortController,
  reopen?: Reopen,
): Promise<void> {
  // 续写把好几条流接成一条答复：片段计数跨轮累加，结束原因取最后一轮。
  const continueState: ContinueState = { text: "", reasoning: "", toolInFlight: false, attempts: 0 };
  const counts: AnswerSegments = { content: 0, thinking: 0, tool: 0 };
  let finishReason: string | undefined;
  const accFinish = (finish: AnswerFinish) => {
    counts.content += finish.content;
    counts.thinking += finish.thinking;
    counts.tool += finish.tool;
    finishReason = finish.reason;
  };
  let upstream = body;
  try {
    for (;;) {
      let roundGone = false;
      let firstOfRound = true;
      try {
        for await (const chunk of watchFinish(readOpenAIChunks(upstream, abort?.signal), accFinish, onUsage)) {
          if (model && chunk && typeof chunk === "object") chunk.model = model;
          // 续写的轮次不重发开场帧：角色那一份已经立过了。
          if (continueState.attempts > 0 && firstOfRound && isRoleOnlyChunk(chunk)) {
            firstOfRound = false;
            continue;
          }
          firstOfRound = false;
          if (!(await writeFrame(ctx, sseData(chunk)))) {
            // 客户端走了：上游也别接着算（还在计费），这一条也不该记成成功。
            await stopUpstream(upstream, abort);
            reportClientGone(ctx, onFailure);
            roundGone = true;
            break;
          }
        }
        if (roundGone) {
          reportClientGone(ctx, onFailure);
          await writeFrame(ctx, SSE_DONE);
          return;
        }
        // 上游的流结束了，但客户端可能早就走了（上游安静的时候它断开的）：那
        // 这一条不是成功 —— 客户端一个字都没拿到（2026-11-03，作者复查发现）。
        reportClientGone(ctx, onFailure);
        if (onFinish && (finishReason || counts.content + counts.thinking + counts.tool > 0)) {
          onFinish({ reason: finishReason ?? "未给", ...counts });
        }
        // 收尾帧只在最后一轮写：还要继续的轮次里 [DONE] 先扣着。
        await writeFrame(ctx, SSE_DONE);
        return;
      } catch (e) {
        const outcome = await continueWith(continueState, reopen, e, `model=${model ?? ""}`);
        if (outcome.kind === "blocked") {
          log.warn(`[DELIVER] 发给客户端的错误事件：${failureLine(outcome.error)}`);
          await writeFrame(ctx, openAIErrorFrame(outcome.error) ?? sseData({ error: { type: "api_error", message: clientMessageOf(outcome.error) } }));
          await writeFrame(ctx, SSE_DONE);
          reportFailure(onFailure, outcome.error);
          // 字节一个不变，错要抛给调用方：这条答复是失败的，不抛的话调用方
          // 记成成功（用量表上那些 0 token 的「成功」就是这么来的）。
          throw outcome.error;
        }
        upstream = outcome.stream;
        // 回到开头
      }
    }
  } finally {
    // The response has to end, or the client waits for a connection that never
    // closes.
    ctx.res.end();
  }
}


/**
 * 把上游的 Anthropic 流写给客户端，只改一处：message_start 里的模型名。
 *
 * 客户端问的是哪个模型，答复里就该是哪个 —— 上游可能用另一个名字（档位的
 * key，或者发布模型背后的真名）。别的帧逐字不动。
 *
 * With `pingMs` set, a `ping` event goes out whenever the upstream has been
 * quiet for that long. Some hops in front of the gateway (a local HTTP proxy,
 * a NAT gateway) drop idle connections, and a long thinking pause can keep the
 * stream quiet for minutes. The upstream sends `event: ping` right after
 * message_start but then goes silent while the model thinks, so we emit our
 * own.
 *
 * Two rules keep this safe:
 *   - only ping when the stream is actually idle, so a busy stream is not
 *     padded with useless events;
 *   - only ping on an SSE frame boundary, because writing one in the middle
 *     of an upstream frame would corrupt the client's parse.
 */
async function writeAnthropicFrames(
  body: ReadableStream<Uint8Array>,
  ctx: Koa.Context,
  model: string,
  pingMs = 0,
  onFailure?: (error: unknown) => void,
  abort?: AbortController,
): Promise<void> {
  let lastActivity = Date.now();
  let warnedMissingMessage = false;
  // ping 也要认背压：客户端读得慢时，ping 不能自己把缓冲区填满，也不能
  // 因为「写不进去」而把整条流砍了。
  //
  // 它也不能有权把一条正在前进的连接掐掉：ping 走的是同一个看门狗，而看门狗
  // 量的是「最早那一帧等了多久」—— ping 每 5 秒一发（不等前面那帧发出去），
  // 所以它不能把期限往后推（2026-11-02，作者复查发现：ping 一推，看门狗就
  // 永远等不到那个上限，等于没有）。
  //
  // 所以 ping 自己排队：上一帧 ping 还在等，就不再发新的。
  let pingPending = false;
  const writePing = () => {
    if (ctx.res.writableEnded || ctx.res.destroyed) return;
    if (pingPending) return;
    if (Date.now() - lastActivity < pingMs) return;
    pingPending = true;
    void writeFrame(ctx, 'event: ping\ndata: {"type":"ping"}\n\n').then((ok) => {
      pingPending = false;
      if (ok) lastActivity = Date.now();
    });
  };
  const pingTimer = pingMs > 0 ? setInterval(writePing, Math.min(pingMs, 5000)) : null;
  pingTimer?.unref?.();
  try {
    for await (const event of readSseEvents(body, abort?.signal)) {
      let data = event.data;
      if (event.event === "message_start" || (!event.event && data.includes('"message_start"'))) {
        const json = parseLooseJson(data);
        if (json) {
          const fixed = repairMessageStart(json, model);
          if (fixed.repaired && !warnedMissingMessage) {
            warnedMissingMessage = true;
            log.warn("[DELIVER] 上游的 message_start 没有 message，已补一个最小对象");
          }
          data = JSON.stringify(fixed.json);
        }
      }
      const frame = event.event ? `event: ${event.event}\ndata: ${data}\n\n` : `data: ${data}\n\n`;
      if (!(await writeFrame(ctx, frame))) {
        // 客户端走了：上游也别接着算（还在计费），这一条也不该记成成功。
        await stopUpstream(body, abort);
        reportClientGone(ctx, onFailure);
        break;
      }
      lastActivity = Date.now();
    }
    // 上游安静的时候客户端断开：上游的流到这里才结束。不报的话，这条请求
    // 会被记成成功 —— 客户端其实一个字都没拿到（2026-11-03，作者复查发现）。
    reportClientGone(ctx, onFailure);
  } catch (e) {
    log.warn(`[DELIVER] 发给客户端的错误事件：${failureLine(e)}`);
    await writeFrame(ctx, errorEvent(clientMessageOf(e)));
    reportFailure(onFailure, e);
    // The error event, the cooldown and the close are already handled; the
    // error itself must still reach the caller, which settles this answer as
    // a failure. Left here, a cut stream is recorded as a zero-token success.
    throw e;
  } finally {
    if (pingTimer) clearInterval(pingTimer);
    ctx.res.end();
  }
}

/* ---------------- plumbing ---------------- */

/**
 * 这个错误什么时候能重试。
 *
 * 503 说的是「现在不行」，客户端还得知道什么时候行 —— 冷却到几点、套餐窗口
 * 什么时候换。恢复时间算在出错的地方（那里知道它从哪儿来），写头的事情在这里
 */
export function withRetryAfter<T extends Error>(error: T, untilMs: number): T {
  (error as T & { retryAfterUntilMs?: number }).retryAfterUntilMs = untilMs;
  return error;
}

/** 带恢复时间的错误，写出去的 `Retry-After`（秒）。 */
function retryAfterHeaders(e: unknown): Record<string, string> {
  const until = (e as { retryAfterUntilMs?: unknown })?.retryAfterUntilMs;
  if (typeof until !== "number" || !Number.isFinite(until)) return {};
  // 已经过点了也发 1 秒：Retry-After: 0 会被当成「别重试」。
  return { "retry-after": String(Math.max(1, Math.ceil((until - Date.now()) / 1000))) };
}

/**
 * Mark a hand-written failure as terminal for clients that read x-should-retry
 *
 * These answers are produced before any upstream round trip: a bad key, a model
 * that is not published, a malformed catalog request or an unrenderable header
 * template. Repeating the same request cannot turn any of them into a success,
 * so the client must not spend another attempt on it. sendError decides the
 * same question from the failure classification and owns that path alone
 */
export function markTerminalError(ctx: Koa.Context): void {
  ctx.set("x-should-retry", "false");
}

/**
 * Write a failure out.
 *
 * `headers` is for the failures that carry something the client acts on — a
 * 503 with `Retry-After` is the one that matters today.
 */
export function sendError(ctx: Koa.Context, e: unknown, headers: Record<string, string> = {}): void {
  const err = e as AuthError;
  const extra = { ...retryAfterHeaders(e), ...headers };
  if (e instanceof ClientGoneError) {
    // 客户端已经走了：这个答复没人收。日志别写成「上游挂了」—— 上游没坏，
    // 只是没人要了（2026-11-03）。
    log.info(`[DELIVER] 客户端走了，答复没送出去`);
    if (ctx.res.headersSent) {
      ctx.res.end();
      return;
    }
    ctx.status = 499;
    ctx.body = { error: { type: "api_error", message: "the client went away" } };
    return;
  }

  // opencode reads this header ahead of its own error classification: a terminal
  // failure left unmarked gets retried, and a transient one marked false does not
  if (!Object.keys(extra).some((key) => key.toLowerCase() === "x-should-retry")) {
    extra["x-should-retry"] = classifyUpstreamError(e).callerShouldResend ? "true" : "false";
  }
  const status = typeof err?.status === "number" ? err.status : 500;
  if (ctx.res.headersSent) {
    ctx.res.end();
    return;
  }
  ctx.status = status;
  if (Object.keys(extra).length) ctx.set(extra);
  log.warn(`[DELIVER] 答复 ${status}：${err?.message ?? "request failed"}`);
  ctx.body = {
    error: {
      // 503 means the credential is the problem; everything else is the request
      // or the upstream failing. A failure that says otherwise says so.
      type:
        err?.type ??
        (status === 503 ? "authentication_error" : status === 400 ? "invalid_request_error" : "api_error"),
      message: err?.message ?? "request failed",
    },
    ...(err?.hint ? { hint: err.hint } : {}),
  };
}
