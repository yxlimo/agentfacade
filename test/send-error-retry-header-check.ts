// test/send-error-retry-header-check.ts — HTTP 错误的 x-should-retry 头
//
//   node --experimental-strip-types test/send-error-retry-header-check.ts
//
// 离线：本机假上游 + 假开放平台 + 真 HTTP 服务，不连任何真平台
//
// 覆盖：
//   1 内容出现之前静默超时（假上游吐一帧就安静）→ x-should-retry: true
//   2 429 限流 → true
//   3 上游 5xx → true
//   4 额度类失败 → false
//   5 鉴权类失败 → false
//   6 ClientGoneError（499）→ 没有这个头
//   7 调用方显式传同名头 → 以调用方为准（大小写两种写法）
//   8 分类的每个 kind 都有重发判据，类型与运行时都对齐
//   9 手写错误响应也带 x-should-retry: false（真 Koa app）：
//     未知模型 404、无效 api key 401、目录 400/404、头模板取不到会话 400
//
// 判据只有一份：classifyUpstreamError(e).callerShouldResend。它问的是「调用方要不要重发
// 整个请求」，与 retrySameAccountNow（路由器现在要不要换账号再试）不是同一个问题。opencode
// 把这个头看得比自己的分类更重，所以「不该重试」必须明写 false，不能靠它猜

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type Koa from "koa";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "send-error-retry-"));
process.env.FACADE_DATA_DIR = tmp;
process.env.ROUTER_RETRY_BUDGET_MS = "50";
process.env.ROUTER_FIRST_FRAME_MS = "60_000";
process.env.ROUTER_STREAM_IDLE_MS = "150";
process.env.REQUIRE_API_KEY = "true";

const { AuthError } = await import("../lib/credential.ts");
const { createOpenPlatform, syncPlatformModels } = await import("../lib/open-platforms.ts");
const { addAccount } = await import("../lib/providers.ts");
const { writeOpenPlatformKey } = await import("../lib/open-platform-credentials.ts");
const { ClientGoneError, StreamIdleError, sendError } = await import("../lib/router/deliver.ts");
const { classifyUpstreamError, FAILURE_KINDS, CALLER_RESEND_BY_KIND } = await import("../lib/router/provider-selection.ts");
const { handle } = await import("../lib/router/handle.ts");
const { loadKeys } = await import("../lib/api-keys.ts");
const { app } = await import("../lib/router/app.ts");
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

// 真 Koa app：鉴权、目录、根路由都走用户真正打到的那条链路
const appServer = http.createServer(app.callback());
await new Promise<void>((resolve) => appServer.listen(0, "127.0.0.1", resolve));
const appPort = (appServer.address() as { port: number }).port;
const apiKey = Object.values(loadKeys())[0] ?? "";
// 目录 404 要在任何模型发布之前打：一旦建了假平台，根路由就有清单了
const bareCatalog = await fetch(`http://127.0.0.1:${appPort}/v1/models`, {
  headers: { authorization: `Bearer ${apiKey}` },
});
const bareBody = await bareCatalog.text();
check(
  "目录 404（没有发布模型）：x-should-retry: false",
  bareCatalog.status === 404 && bareCatalog.headers.get("x-should-retry") === "false",
  `${bareCatalog.status} ${bareBody.slice(0, 200)}`,
);

// 假上游：三种失败各走一条路径，按 x-scenario 选择
const upstream = http.createServer((req, res) => {
  const scenario = String(req.headers["x-scenario"] ?? "");
  const body = { error: { message: "fake upstream failure" } };
  if (scenario === "server") {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
    return;
  }
  if (scenario === "quota") {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "out_of_credits", message: "no credits" } }));
    return;
  }
  if (scenario === "auth") {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "invalid api key" } }));
    return;
  }
  if (scenario === "rate-limit") {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "too many requests" } }));
    return;
  }
  if (scenario === "timeout") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    // A role-only frame does not open the content gate, so the silence that
    // follows is reported before any headers go out
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-retry-header-idle",
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta: { role: "assistant" } }],
      })}\n\n`,
    );
    // Deliberately leave the stream open
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
const upstreamPort = (upstream.address() as { port: number }).port;

const scenarios: Record<string, string> = {
  server: "retry-header-server",
  quota: "retry-header-quota",
  auth: "retry-header-auth",
  timeout: "retry-header-timeout",
  "rate-limit": "retry-header-rate-limit",
  inject: "retry-header-inject",
};
for (const [scenario, platform] of Object.entries(scenarios)) {
  const made = createOpenPlatform({
    id: platform,
    label: `Retry Header Fake ${scenario}`,
    baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    headers: scenario === "inject" ? [{ name: "x-facade-session", value: "{session-id}" }] : [],
  });
  check(`假开放平台 ${scenario} 建好了`, made.ok === true, made.message);
  const model = `retry-header-${scenario}-model`;
  syncPlatformModels(platform, [model]);
  const account = addAccount({ platform });
  check(`假账号 ${scenario} 建好了`, account.ok === true, account.message);
  if (account.ok && account.id) writeOpenPlatformKey(account.id, "sk-TESTONLY-retry-header"); // privacy:allow — 编造的样例
}

// 半份 fixture 就够：handle 与 sendError 只碰这些成员
function fakeCtx(res: http.ServerResponse, requestBody: object, requestHeaders: object): Koa.Context {
  const ctx: Partial<Koa.Context> = {
    res,
    status: 200,
    respond: true,
    set(field: string | Record<string, string | string[]>, value?: string | string[]) {
      const pairs = typeof field === "string" ? { [field]: value ?? "" } : field;
      for (const [key, val] of Object.entries(pairs)) res.setHeader(key, val);
      return ctx as Koa.Context;
    },
  };
  Object.defineProperty(ctx, "request", { value: { body: requestBody, headers: requestHeaders } });
  let body: unknown;
  Object.defineProperty(ctx, "body", {
    get: () => body,
    set(value: unknown) {
      body = value;
      if (ctx.respond === false || res.headersSent || res.writableEnded) return;
      res.statusCode = ctx.status ?? 200;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(value));
    },
  });
  return ctx as Koa.Context;
}

const route = http.createServer(async (req, res) => {
  const direct = String(req.headers["x-direct"] ?? "");
  if (direct) {
    const ctx = fakeCtx(res, {}, {});
    if (direct === "gone") sendError(ctx, new ClientGoneError());
    else {
      const retryable = new AuthError("upstream failed", "上游没有响应。", 503);
      const headers: Record<string, string> = direct === "override-upper" ? { "X-Should-Retry": "false" } : { "x-should-retry": "false" };
      sendError(ctx, retryable, headers);
    }
    return;
  }
  const scenario = String(req.headers["x-scenario"] ?? "");
  const ctx = fakeCtx(
    res,
    {
      model: `retry-header-${scenario}-model`,
      stream: scenario === "timeout",
      messages: [{ role: "user", content: "hello" }],
    },
    { "x-scenario": scenario },
  );
  try {
    await handle(ctx, "openai", scenarios[scenario]);
  } catch {
    // handle 把失败留给 sendError：真 HTTP 服务上仍然拿得到响应头
    // handle 已经把失败写成 HTTP 答复：这里不再写第二遍
  }
});


await new Promise<void>((resolve) => route.listen(0, "127.0.0.1", resolve));
const routePort = (route.address() as { port: number }).port;

interface Answer {
  status: number;
  retryHeader: string | undefined;
  body: string;
}
async function run(direct: string, scenario = ""): Promise<Answer> {
  return await new Promise<Answer>((resolve) => {
    let body = "";
    const req = http.request(
      {
        port: routePort,
        host: "127.0.0.1",
        path: "/",
        method: "POST",
        headers: { "x-direct": direct, "x-scenario": scenario },
      },
      (r) => {
        r.setEncoding("utf8");
        r.on("data", (chunk: string) => (body += chunk));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, retryHeader: r.headers["x-should-retry"] as string | undefined, body }));
        r.on("close", () => resolve({ status: r.statusCode ?? 0, retryHeader: r.headers["x-should-retry"] as string | undefined, body }));
        r.on("error", () => resolve({ status: r.statusCode ?? 0, retryHeader: r.headers["x-should-retry"] as string | undefined, body }));
      },
    );
    req.on("error", () => resolve({ status: 0, retryHeader: undefined, body }));
    req.end("{}");
  });
}

const timeout = await run("", "timeout");
const rateLimit = await run("", "rate-limit");
const server = await run("", "server");
const quota = await run("", "quota");
const auth = await run("", "auth");
const gone = await run("gone");
const override = await run("override");
const overrideUpper = await run("override-upper");

check("静默超时：x-should-retry: true", timeout.retryHeader === "true", `${timeout.status} ${JSON.stringify(timeout.body)}`);
check("静默超时走的是真链路：吐了一帧但没到内容提交点", timeout.body.includes("upstream sent nothing") && timeout.body.includes("mid-stream"), `${timeout.status} ${JSON.stringify(timeout.body)}`);
check("429 限流：x-should-retry: true", rateLimit.retryHeader === "true", `${rateLimit.status} ${JSON.stringify(rateLimit.body)}`);
check("5xx：x-should-retry: true", server.retryHeader === "true", `${server.status} ${JSON.stringify(server.body)}`);
check("额度失败：x-should-retry: false", quota.retryHeader === "false", `${quota.status} ${JSON.stringify(quota.body)}`);
check("鉴权失败：x-should-retry: false", auth.retryHeader === "false", `${auth.status} ${JSON.stringify(auth.body)}`);
check("客户端走了：499 且没有这个头", gone.status === 499 && gone.retryHeader === undefined, `${gone.status} ${String(gone.retryHeader)}`);
check("调用方显式 false 不被覆盖", override.retryHeader === "false", String(override.retryHeader));
check("调用方大写名字也不被覆盖", overrideUpper.retryHeader === "false", String(overrideUpper.retryHeader));

const appUrl = `http://127.0.0.1:${appPort}`;
const authed = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
const postJson = (path: string, model: string) =>
  fetch(`${appUrl}${path}`, {
    method: "POST",
    headers: authed,
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
  });

const badDialect = await fetch(`${appUrl}/v1/models?dialect=bogus`, { headers: authed });
const badDialectBody = await badDialect.text();
check(
  "目录 400（方言不认识）：x-should-retry: false",
  badDialect.status === 400 && badDialect.headers.get("x-should-retry") === "false",
  `${badDialect.status} ${badDialectBody.slice(0, 200)}`,
);

const badKey = await fetch(`${appUrl}/v1/messages`, {
  method: "POST",
  headers: { authorization: "Bearer sk-TESTONLY-wrong-key", "content-type": "application/json" }, // privacy:allow — 编造的样例
  body: JSON.stringify({ model: "retry-header-server-model", messages: [{ role: "user", content: "hello" }] }),
});
const badKeyBody = await badKey.text();
check(
  "无效 api key 401：x-should-retry: false",
  badKey.status === 401 && badKey.headers.get("x-should-retry") === "false",
  `${badKey.status} ${badKeyBody.slice(0, 200)}`,
);

const noModel = await postJson("/v1/messages", "no-such-model-xyz");
const noModelBody = await noModel.text();
check(
  "未知模型 404：x-should-retry: false",
  noModel.status === 404 && noModel.headers.get("x-should-retry") === "false",
  `${noModel.status} ${noModelBody.slice(0, 200)}`,
);

const noSession = await postJson("/retry-header-inject/v1/messages", "retry-header-inject-model");
const noSessionBody = await noSession.text();
check(
  "注入头取不到会话 400：x-should-retry: false",
  noSession.status === 400 && noSession.headers.get("x-should-retry") === "false",
  `${noSession.status} ${noSessionBody.slice(0, 200)}`,
);
const idleFailure = classifyUpstreamError(new StreamIdleError(150, "model=fake", "mid-stream"));
const limitedFailure = classifyUpstreamError(new AuthError("rate limited", "", 429));
check(
  "timeout：retrySameAccountNow false 而 callerShouldResend true",
  idleFailure.kind === "timeout" && idleFailure.retrySameAccountNow === false && idleFailure.callerShouldResend === true,
  JSON.stringify(idleFailure),
);
check(
  "rate-limit：retrySameAccountNow false 而 callerShouldResend true",
  limitedFailure.kind === "rate-limit" && limitedFailure.retrySameAccountNow === false && limitedFailure.callerShouldResend === true,
  JSON.stringify(limitedFailure),
);
const verdictKeys = Object.keys(CALLER_RESEND_BY_KIND).sort();
const kindNames = [...FAILURE_KINDS].sort();
check(
  "每个 kind 都有 verdict，键集合一致",
  verdictKeys.length === kindNames.length &&
    kindNames.every((kind, i) => verdictKeys[i] === kind) &&
    kindNames.every((kind) => typeof CALLER_RESEND_BY_KIND[kind] === "boolean"),
  `${kindNames.join(",")} vs ${verdictKeys.join(",")}`,
);
const shouldResend = ["server", "connection", "timeout", "rate-limit"] as const;
const shouldNotResend = [
  "refused",
  "credential",
  "quota",
  "no-balance",
  "model",
  "request",
  "queued",
  "unreachable",
  "unknown",
] as const;
check(
  "verdict 按 kind 分开（可重发四类，其余不重发）",
  shouldResend.every((kind) => CALLER_RESEND_BY_KIND[kind] === true) &&
    shouldNotResend.every((kind) => CALLER_RESEND_BY_KIND[kind] === false),
  JSON.stringify(CALLER_RESEND_BY_KIND),
);

upstream.closeAllConnections?.();
route.closeAllConnections?.();
appServer.closeAllConnections?.();
await new Promise<void>((resolve) => upstream.close(() => resolve()));
await new Promise<void>((resolve) => route.close(() => resolve()));
await new Promise<void>((resolve) => appServer.close(() => resolve()));
closeStore();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${fail === 0 ? "PASS" : "FAIL"}: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
