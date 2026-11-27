// test/forward-headers-check.ts — what the upstream actually receives
//
//   node --experimental-strip-types test/forward-headers-check.ts
//
// Offline: the upstream is an http server on loopback, no request leaves the machine.
//
// The gateway forwards the client's headers upstream, so the upstream must see
// the client's User-Agent instead of the gateway's own name, and the client's
// copy of content-type / authorization must not be able to displace the ones
// the gateway sets for the account's key
//
// Every assertion reads the headers the fake upstream really got, so a header
// the gateway only "thinks" it sent cannot pass here

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";

// the lib modules open the store on import, so the data dir has to point
// somewhere disposable before they load
process.env.FACADE_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "forward-headers-check-"));

const { openAiPlatformChat } = await import("../lib/router/openai-platform.ts");
const { anthropicPlatformChat } = await import("../lib/router/upstreams/open-platform.ts");

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

/** The account's inference key. */
const KEY = "sk-test-0123456789abcdefghij"; // privacy:allow — fabricated sample

const BODY: Record<string, unknown> = {
  model: "facade-check",
  messages: [{ role: "user", content: "hi" }],
};

/* ------------------------------------------------------------------ *
 * The fake upstream: record the headers, answer with a small body
 * ------------------------------------------------------------------ */

const received: IncomingHttpHeaders[] = [];

const server = createServer((req, res) => {
  received.push(req.headers);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ id: "fake", choices: [] }));
});

await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});

const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

const openAiPlatform = { id: "facade-check", label: "FacadeCheck", base, key: KEY };

/**
 * Run one upstream call and hand back the headers that call produced.
 *
 * The count check keeps the assertions honest: without it a call that never
 * reached the server would silently answer with the previous call's headers
 */
async function capture(chat: () => Promise<Response>): Promise<IncomingHttpHeaders> {
  const before = received.length;
  const response = await chat();
  await response.text();
  if (received.length !== before + 1) {
    throw new Error(`the upstream got ${received.length - before} requests, expected 1`);
  }
  return received[received.length - 1];
}

/** The header value as one string, so a duplicated header is visible in the report */
function headerValue(headers: IncomingHttpHeaders, name: string): string {
  const value = headers[name];
  if (value === undefined) return "<absent>";
  return Array.isArray(value) ? value.join(", ") : value;
}

/* ------------------------------------------------------------------ *
 * One: the client's User-Agent reaches the upstream
 * ------------------------------------------------------------------ */

section("一、OpenAI 方言：客户端的 User-Agent 原样到上游");

{
  const headers = await capture(() =>
    openAiPlatformChat(openAiPlatform, BODY, { "user-agent": "curl/8.5.0" }),
  );
  const ua = headerValue(headers, "user-agent");
  check("上游收到的 user-agent 就是客户端那个", ua === "curl/8.5.0", ua);
  check("那个值里没有网关自己的名字", !ua.includes("buddy"), ua);
}

section("二、OpenAI 方言：客户端没发 User-Agent 时网关也不补自己的");
// 键一定在：调用方没给 UA 时 undici 会补一个默认的 `node`。这条钉的是
// 「网关没有把自己的名字塞进去」，不是「这个头不存在」。
{
  const headers = await capture(() => openAiPlatformChat(openAiPlatform, BODY, {}));
  const ua = headerValue(headers, "user-agent");
  check("网关没有补自己的名字", !ua.includes("buddy"), ua);
}

section("三、Anthropic 方言：同样两条");

{
  const platform = { id: "facade-check", label: "FacadeCheck", base, key: KEY };
  const headers = await capture(() =>
    anthropicPlatformChat(platform, BODY, { "user-agent": "curl/8.5.0" }),
  );
  const ua = headerValue(headers, "user-agent");
  check("上游收到的 user-agent 就是客户端那个", ua === "curl/8.5.0", ua);
  check("那个值里没有网关自己的名字", !ua.includes("buddy"), ua);
}

{
  const platform = { id: "facade-check", label: "FacadeCheck", base, key: KEY };
  const headers = await capture(() => anthropicPlatformChat(platform, BODY, {}));
  const ua = headerValue(headers, "user-agent");
  check("网关没有补自己的名字", !ua.includes("buddy"), ua);
}

section("四、客户端那份 content-type / authorization 顶不掉网关自己的");

{
  const headers = await capture(() =>
    openAiPlatformChat(openAiPlatform, BODY, {
      "content-type": "text/plain",
      authorization: "Bearer CLIENT-SENT",
    }),
  );
  check(
    "上游收到的 content-type 是 application/json",
    headerValue(headers, "content-type") === "application/json",
    headerValue(headers, "content-type"),
  );
  check(
    "上游收到的 authorization 是账号那把 key",
    headerValue(headers, "authorization") === `Bearer ${KEY}`,
    headerValue(headers, "authorization"),
  );
}

server.close();

console.log("");
console.log(`${pass} ok, ${fail} fail`);
if (fail > 0) {
  console.log("");
  console.log("转发出去的头不对 —— 见上面每条 FAIL。");
  process.exitCode = 1;
} else {
  console.log("转发出去的头：客户端的 User-Agent 原样到上游，网关自己的头顶不掉。");
}
