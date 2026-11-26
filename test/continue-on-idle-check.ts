// test/continue-on-idle-check.ts — a quiet upstream can be resumed from the checkpoint
//
//   node --experimental-strip-types test/continue-on-idle-check.ts
//
// Offline: a local fake upstream, a local router server and a real client socket.
// No lib file is touched here, and deliver.ts is not read by this test.
//
// The three cases run in child processes because the idle and continue switches
// are read when the router modules are loaded. Each child owns a fresh data dir.
//
// A continues once and the client sees one Anthropic message with both halves
// B keeps the shipped default, so the client sees an error and one upstream call
// C has tool arguments in flight, which is not a resumable text checkpoint

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IDLE_MS = 200;
const FIRST_FRAME_MS = 1_000;
const CONTINUE_HINT = "上一条回答被上游中断了，从断点继续写，不要重复已经写过的内容";
const CASE_NAME = process.env.CONTINUE_CASE;
const WATCHDOG_MS = 20_000;

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

type Frame = { event: string; data: Record<string, unknown> };

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

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

type ChatBody = {
  model?: unknown;
  stream?: unknown;
  messages?: Array<{ role?: unknown; content?: unknown }>;
};

function messagesOf(value: unknown): Array<{ role?: unknown; content?: unknown }> {
  return Array.isArray(value) ? (value as Array<{ role?: unknown; content?: unknown }>) : [];
}

function textDeltaOf(frame: Frame): { index: number; text: string } | null {
  if (frame.event !== "content_block_delta") return null;
  const delta = asObject(frame.data.delta);
  if (!delta || delta.type !== "text_delta" || typeof delta.text !== "string") return null;
  return { index: Number(frame.data.index), text: delta.text };
}

type CaseReport = {
  frames: Frame[];
  text: string;
  bodies: ChatBody[];
  status: number;
};

async function runCase(which: "A" | "B" | "C"): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "continue-idle-"));
  process.env.FACADE_DATA_DIR = tmp;
  process.env.ROUTER_STREAM_IDLE_MS = String(IDLE_MS);
  process.env.ROUTER_FIRST_FRAME_MS = String(FIRST_FRAME_MS);

  const { createOpenPlatform, syncPlatformModels } = await import("../lib/open-platforms.ts");
  const { addAccount } = await import("../lib/providers.ts");
  const { writeOpenPlatformKey } = await import("../lib/open-platform-credentials.ts");
  const { handle } = await import("../lib/router/handle.ts");

  type HandleCtx = Parameters<typeof handle>[0];
  const model = "continue-open-model";
  const bodies: ChatBody[] = [];

  function sseChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
    return `data: ${JSON.stringify({
      id: "chatcmpl-continue",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`;
  }

  // The first request writes visible bytes and then stops without ending the
  // response, so the only thing that can move the stream forward is the idle gate.
  const upstream = http.createServer((req, res) => {
    if (!req.url?.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    const pieces: Buffer[] = [];
    req.on("data", (piece: Buffer) => pieces.push(piece));
    req.on("end", () => {
      const parsed: unknown = JSON.parse(Buffer.concat(pieces).toString("utf8"));
      bodies.push(asObject(parsed) as ChatBody);
      res.writeHead(200, { "content-type": "text/event-stream" });

      if (bodies.length === 1) {
        if (which === "C") {
          res.write(sseChunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_cont", type: "function", function: { name: "read", arguments: "{\"path\":" } }] }));
          res.write(sseChunk({ tool_calls: [{ index: 0, function: { arguments: "\"a.txt\"}" } }] }));
        } else {
          res.write(sseChunk({ role: "assistant", content: "" }));
          res.write(sseChunk({ content: "前半" }));
        }
        return;
      }

      res.write(sseChunk({ role: "assistant", content: "" }));
      res.write(sseChunk({ content: "后半" }));
      res.write(sseChunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = (upstream.address() as { port: number }).port;

  const madePlatform = createOpenPlatform({
    id: "continue-open",
    label: "Continue Fake",
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
  });
  if (!madePlatform.ok) throw new Error(madePlatform.message);
  syncPlatformModels("continue-open", [model]);
  const madeAccount = addAccount({ platform: "continue-open" });
  if (!madeAccount.ok || !madeAccount.id) throw new Error(madeAccount.message);
  writeOpenPlatformKey(madeAccount.id, "sk-continue-fake"); // privacy:allow — fabricated test key

  function routeCtx(res: http.ServerResponse): HandleCtx {
    const ctx = {} as HandleCtx;
    let stored: unknown;
    Object.assign(ctx, {
      res,
      status: 200,
      respond: true,
      set: (headers: Record<string, string>) => {
        for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
      },
      request: {
        body: { model, stream: true, max_tokens: 64, messages: [{ role: "user", content: "写下去" }] },
        headers: {},
      },
    });
    Object.defineProperty(ctx, "body", {
      get: () => stored,
      set: (value: unknown) => {
        stored = value;
        if (!ctx.respond || res.headersSent || res.writableEnded) return;
        res.statusCode = ctx.status;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify(value));
      },
    });
    return ctx;
  }

  const route = http.createServer(async (_req, res) => {
    try {
      await handle(routeCtx(res), "anthropic", "continue-open");
    } catch {
      if (!res.writableEnded) res.end();
    }
  });
  await new Promise<void>((resolve) => route.listen(0, "127.0.0.1", resolve));
  const routePort = (route.address() as { port: number }).port;

  const clientText = await new Promise<string>((resolve) => {
    const req = http.request({ port: routePort, host: "127.0.0.1", path: "/", method: "POST" }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (piece: string) => { text += piece; });
      res.on("end", () => resolve(text));
      res.on("close", () => resolve(text));
      res.on("error", () => resolve(text));
    });
    req.on("error", () => resolve(""));
    req.end("{}");
  });

  upstream.closeAllConnections?.();
  route.closeAllConnections?.();
  upstream.close();
  route.close();

  const report: CaseReport = { frames: parseFrames(clientText), text: clientText, bodies, status: 200 };
  console.log(`REPORT ${JSON.stringify(report)}`);
}

async function main(): Promise<void> {
  if (CASE_NAME === "A" || CASE_NAME === "B" || CASE_NAME === "C") {
    await runCase(CASE_NAME);
    return;
  }

  const here = fileURLToPath(import.meta.url);
  const runChild = (which: "A" | "B" | "C") =>
    new Promise<{ report: CaseReport | null; code: number | null; stderr: string }>((resolve) => {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "continue-parent-"));
      const child = spawn(process.execPath, ["--experimental-strip-types", here], {
        env: {
          ...process.env,
          CONTINUE_CASE: which,
          FACADE_DATA_DIR: dataDir,
          ROUTER_CONTINUE_ON_IDLE: which === "A" ? "true" : "false",
          ROUTER_CONTINUE_MAX: "2",
        },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (piece: Buffer) => { out += piece.toString(); });
      child.stderr.on("data", (piece: Buffer) => { err += piece.toString(); });
      child.on("close", (code) => {
        const line = out.split("\n").find((entry) => entry.startsWith("REPORT "));
        let report: CaseReport | null = null;
        if (line) {
          try {
            report = JSON.parse(line.slice(7)) as CaseReport;
          } catch {
            report = null;
          }
        }
        resolve({ report, code, stderr: err });
      });
      setTimeout(() => child.kill(), WATCHDOG_MS).unref?.();
    });

  const a = await runChild("A");
  section("A. 开续写：两段落在同一个正文块里");
  check("A 子进程正常退出", a.code === 0, `exit ${a.code}：${a.stderr.slice(0, 300)}`);
  const af = a.report?.frames ?? [];
  const starts = af.filter((frame) => frame.event === "message_start");
  const stops = af.filter((frame) => frame.event === "message_stop");
  const errors = af.filter((frame) => frame.event === "error");
  const textBlocks = af.filter((frame) => frame.event === "content_block_start" && asObject(frame.data.content_block)?.type === "text");
  const deltas = af.map(textDeltaOf).filter((value): value is { index: number; text: string } => value !== null);
  check("A 只有一份 message_start", starts.length === 1, `${starts.length} 份`);
  check("A 正文块只开了一次", textBlocks.length === 1, `${textBlocks.length} 次`);
  check("A 两段增量落在同一个 index", deltas.length === 2 && deltas.every((d) => d.index === Number(textBlocks[0]?.data.index)), JSON.stringify(deltas));
  check("A 正文连续是「前半后半」", deltas.map((d) => d.text).join("") === "前半后半", deltas.map((d) => d.text).join(""));
  check("A 只有一份 message_stop", stops.length === 1, `${stops.length} 份`);
  check("A 没有 error 帧", errors.length === 0, JSON.stringify(errors.map((e) => e.data)));
  check("A 假上游收到两个请求", a.report?.bodies.length === 2, `${a.report?.bodies.length ?? 0} 个`);
  const secondMessages = messagesOf(a.report?.bodies[1]?.messages);
  check("A 第二个请求带上 assistant 断点", String(secondMessages.at(-2)?.content) === "前半" && secondMessages.at(-2)?.role === "assistant", JSON.stringify(secondMessages.slice(-2)));
  check("A 第二个请求带上继续写的指令", secondMessages.at(-1)?.role === "user" && secondMessages.at(-1)?.content === CONTINUE_HINT, JSON.stringify(secondMessages.slice(-1)));

  const b = await runChild("B");
  section("B. 默认关：不重发，客户端看到错误");
  check("B 子进程正常退出", b.code === 0, `exit ${b.code}：${b.stderr.slice(0, 300)}`);
  check("B 客户端收到 error 帧", (b.report?.frames ?? []).some((frame) => frame.event === "error"), (b.report?.text ?? "").slice(0, 200));
  check("B 假上游只收到一个请求", b.report?.bodies.length === 1, `${b.report?.bodies.length ?? 0} 个`);

  const c = await runChild("C");
  section("C. 工具调用在途：不把参数断点当正文续写");
  check("C 子进程正常退出", c.code === 0, `exit ${c.code}：${c.stderr.slice(0, 300)}`);
  check("C 客户端收到 error 帧", (c.report?.frames ?? []).some((frame) => frame.event === "error"), (c.report?.text ?? "").slice(0, 200));
  check("C 没有收尾帧", !(c.report?.frames ?? []).some((frame) => frame.event === "message_stop"), (c.report?.text ?? "").slice(-200));
  check("C 假上游只收到一个请求", c.report?.bodies.length === 1, `${c.report?.bodies.length ?? 0} 个`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

await main();
