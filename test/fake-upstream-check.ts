// test/fake-upstream-check.ts — 假上游模块与探针两个离线开关的自检。
//
//   node --experimental-strip-types test/fake-upstream-check.ts
//
// 覆盖：
//   · startFakeUpstream：默认响应、requests 按序记录（含 body）、自定义 handler
//   · close() 在 1 秒内返回（守住 keep-alive 挂死：只 server.close() 会永不返回）
//   · close 之后连接失败
//   · probe --dry-run：一个请求都不发，打印 URL 与头键名
//   · probe --fake：发到探针自己进程内的假上游，打印有「发出」与「收到」两侧
//   · 附带：pre-commit hook 存在、可执行、内容含 mise run verify（这个文件跑在
//     check:misc 里，hook 被人删掉时门禁会红）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { startFakeUpstream } from "./fake-upstream.ts";

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

// ── 模块本体 ─────────────────────────────────────────────────────────────

// 盯梢用：探针 --dry-run 时这里必须一个请求都收不到。
const watcher = await startFakeUpstream();

{
  const fake = await startFakeUpstream();
  check("url 是 127.0.0.1 的随机端口", /^http:\/\/127\.0\.0\.1:\d+$/.test(fake.url), fake.url);

  const res1 = await fetch(`${fake.url}/a?x=1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hi: 1 }),
  });
  const body1 = (await res1.json()) as { code: number; msg: string; data: { path: string; method: string } };
  check("默认响应 code=0", res1.status === 200 && body1.code === 0, JSON.stringify(body1));
  check("默认响应带回 path 与 method", body1.data.path === "/a?x=1" && body1.data.method === "POST", JSON.stringify(body1));

  const res2 = await fetch(`${fake.url}/b`);
  await res2.text();
  check("requests 按顺序记录两个请求", fake.requests.length === 2 && fake.requests[0].url === "/a?x=1" && fake.requests[1].url === "/b", JSON.stringify(fake.requests.map((r) => r.url)));
  check("body 全文被记下", fake.requests[0].body === '{"hi":1}', fake.requests[0].body);
  check("头被记下", fake.requests[0].headers["content-type"] === "application/json", JSON.stringify(fake.requests[0].headers));
  check("method 被记下", fake.requests[0].method === "POST", fake.requests[0].method);

  // keep-alive 挂死的守卫：只 server.close() 的写法这里会超过 1 秒。
  const started = Date.now();
  await fake.close();
  const elapsed = Date.now() - started;
  check("close() 在 1 秒内返回", elapsed < 1000, `${elapsed} ms`);

  let failed = false;
  try {
    await fetch(`${fake.url}/after-close`);
  } catch {
    failed = true;
  }
  check("close 之后连接失败", failed);
}

{
  const fake = await startFakeUpstream((req) => {
    if (req.url === "/teapot") return { status: 418, body: { custom: true } };
    return undefined;
  });
  const res = await fetch(`${fake.url}/teapot`);
  const body = (await res.json()) as { custom: boolean };
  check("自定义 handler 生效（状态与正文）", res.status === 418 && body.custom === true, `${res.status} ${JSON.stringify(body)}`);
  const resDefault = await fetch(`${fake.url}/defaulted`);
  check("handler 返回 undefined 用默认响应", resDefault.status === 200 && JSON.parse(await resDefault.text()).code === 0);
  await fake.close();
}

// ── 探针的 --dry-run / --fake ────────────────────────────────────────────

// 临时数据目录 + 一个假账号的会话（同 test/probe-check.ts 的做法）。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-upstream-check-"));
process.env.FACADE_DATA_DIR = dataDir;
process.env.ZCODE_BASE_URL = watcher.url;

const { saveSession } = await import("../lib/zcode/auth.ts");
saveSession(
  {
    // privacy:allow — 编造的样例，假上游不看内容
    token: "zcode-TESTONLY-fake-upstream-token",
    provider: "zai",
    deviceId: "dev-TESTONLY0000000000",
  } as any,
  "probe-test",
);

const TOOL = path.join(import.meta.dirname!, "../tools/probe.ts");

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const argv = ["--experimental-strip-types", TOOL, "--account", "probe-test", "--platform", "probe-test", ...args];
  const config = path.join(dataDir, "probe.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      platform: "probe-test",
      headers: "zcodePlatformHeaders",
      base: "ZCODE_BASE",
      requests: [{ name: "whoami", method: "GET", path: "/me", write: false }],
    }),
  );
  argv.push("--config", config);
  return new Promise((resolve) => {
    const child = spawn("node", argv, {
      env: { ...process.env, FACADE_DATA_DIR: dataDir, ZCODE_BASE_URL: watcher.url },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

{
  const r = await run(["--request", "whoami", "--dry-run"]);
  check("--dry-run 退出码 0", r.code === 0, `${r.code} ${r.err}`);
  check("--dry-run 没发出任何请求", watcher.requests.length === 0, JSON.stringify(watcher.requests));
  check("--dry-run 打印真实 URL", r.out.includes(`${watcher.url}/me`), r.out);
  check("--dry-run 打印头键名（不打印值）", r.out.includes("authorization") && r.out.includes("值长度") && !r.out.includes("zcode-TESTONLY"), r.out);
}

{
  const before = watcher.requests.length;
  const r = await run(["--request", "whoami", "--fake"]);
  check("--fake 退出码 0", r.code === 0, `${r.code} ${r.err}`);
  check("--fake 打印「发出」一侧", r.out.includes("发出"), r.out);
  check("--fake 打印「收到」一侧", r.out.includes("收到") && r.out.includes("HTTP 200"), r.out);
  check("--fake 拿到假上游的默认响应", r.out.includes('"code":0'), r.out);
  check("--fake 的请求发到探针进程内的假上游，不是外面的", watcher.requests.length === before, JSON.stringify(watcher.requests));
}

await watcher.close();

// ── 附带：pre-commit hook 不许被人删掉 ──────────────────────────────────

{
  const hookPath = path.join(import.meta.dirname!, "../.githooks/pre-commit");
  check(".githooks/pre-commit 存在", fs.existsSync(hookPath));
  if (fs.existsSync(hookPath)) {
    const mode = fs.statSync(hookPath).mode & 0o111;
    check(".githooks/pre-commit 有可执行位", mode !== 0, `mode=${fs.statSync(hookPath).mode.toString(8)}`);
    const text = fs.readFileSync(hookPath, "utf8");
    check("hook 内容包含 mise run verify", text.includes("mise run verify"), text.slice(0, 120));
  }
}

console.log("");
if (fail === 0) {
  console.log("假上游与探针开关：" + pass + " 项全过。");
} else {
  console.log("假上游与探针开关：" + pass + " 项过，" + fail + " 项没过。");
  process.exitCode = 1;
}
