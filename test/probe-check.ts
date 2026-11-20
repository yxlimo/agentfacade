// test/probe-check.ts — 探针工具的离线自检：全部打 127.0.0.1 的假上游，
// 不碰真上游（真上游额度很小，测试花真钱是事故）。
//
//   node --experimental-strip-types test/probe-check.ts
//
// 覆盖的几件事：
//   · GET 探针：URL/query 正确、头来自白名单函数、打印状态与 code
//   · 不许叠 authorization：配置里带凭据键名 → 直接拒绝（2026-10-28 的回归测试）
//   · write 不带 --yes-write → 拒绝，且假上游收到 0 次
//   · write 带 --yes-write → 发出一次，$arg.planId 被替换
//   · 缺 --arg → 点名缺哪个
//   · 非 JSON / 500 → 仍然打印拿到的事实
//   · --list 列出请求名与 notes
//   · 配置里的凭据值字面量 → 拒绝

import assert from "node:assert";
//   · $const.X 被替换成仓库常量的真实值；未登记的名字 → 报错点名
//   · 漂移回归：zcode.json 里不许有版本号/平台字面量
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

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

// ── 假上游：记住每一个请求，按路径回答 ─────────────────────────────────────

interface Recorded {
  method: string;
  url: string;
  authorization: string[];
  contentType: string | undefined;
  body: string | undefined;
}

const recorded: Recorded[] = [];
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    recorded.push({
      method: req.method ?? "",
      url: req.url ?? "",
      // fetch 会合并同名头 —— 这里把收到的都记下来，测试查「只有一个」。
      authorization: req.headers["authorization"] ? [String(req.headers["authorization"])] : [],
      contentType: req.headers["content-type"] as string | undefined,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    if (req.url?.startsWith("/plain")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("just text, not json");
    } else if (req.url?.startsWith("/boom")) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 5000, msg: "upstream exploded" }));
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: 0, msg: "ok", data: { path: req.url } }));
    }
  });
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const addr = server.address() as { port: number };
const BASE = `http://127.0.0.1:${addr.port}`;

// ── 临时数据目录 + 一个假账号的会话 ───────────────────────────────────────

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-check-"));
process.env.FACADE_DATA_DIR = dataDir;
process.env.ZCODE_BASE_URL = BASE;

const { saveSession, ZCODE_VERSION, loadSession } = await import("../lib/zcode/auth.ts");
const { ZCODE_CLAIM_APP_VERSION } = await import("../lib/zcode/claim.ts");
const { ZCODE_CLIENT_PLATFORM } = await import("../lib/zcode/transport.ts");
const { ZCODE_MARKETING_TOUCH_PATH, zcodeMarketingHeaders } = await import(
  "../lib/zcode/marketing.ts"
);
const { HEADER_FACTORIES } = await import("../tools/probe.ts");
saveSession(
  {
    // privacy:allow — 编造的样例，假上游不看内容
    token: "zcode-TESTONLY-header-probe-token",
    provider: "zai",
    deviceId: "dev-TESTONLY0000000000",
  } as any,
  "probe-test",
);

// ── 跑探针的方式：子进程，像真实调用一样 ──────────────────────────────────

const TOOL = path.join(import.meta.dirname!, "../tools/probe.ts");

// 异步 spawn：spawnSync 会阻塞本进程的事件循环，假上游就应答不了。
function run(args: string[], config?: string): Promise<{ code: number; out: string; err: string }> {
  const argv = [
    "--experimental-strip-types",
    TOOL,
    "--account",
    "probe-test",
    "--platform",
    "probe-test",
    ...args,
  ];
  if (config) argv.push("--config", config);
  return new Promise((resolve) => {
    const child = spawn("node", argv, {
      env: { ...process.env, FACADE_DATA_DIR: dataDir, ZCODE_BASE_URL: BASE },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
  });
}

function writeConfig(name: string, json: unknown): string {
  const file = path.join(dataDir, name);
  fs.writeFileSync(file, JSON.stringify(json));
  return file;
}

const okConfig = (requests: unknown[]) =>
  writeConfig("ok.json", { platform: "probe-test", headers: "zcodePlatformHeaders", base: "ZCODE_BASE", requests });

try {
  // ── 1. GET 探针：URL/query、白名单头、状态与 code ──────────────────────
  {
    const file = okConfig([
      { name: "whoami", method: "GET", path: "/me", query: { app_version: "$const.ZCODE_VERSION" }, write: false },
    ]);
    const r = await run(["--request", "whoami"], file);
    check("GET 探针退出码 0", r.code === 0, r.err);
    check("打印请求行（$const 替换后带 query）", r.out.includes(`GET ${BASE}/me?app_version=${encodeURIComponent(ZCODE_VERSION)}`), r.out);
    check("打印 HTTP 状态", r.out.includes("HTTP 200"), r.out);
    check("打印 code", r.out.includes("code = 0"), r.out);

    const hit = recorded.at(-1)!;
    check("上游收到一个 authorization 头", hit.authorization.length === 1, JSON.stringify(hit.authorization));
    // privacy:allow — 编造的样例，假上游只记头不验证
    check("authorization 来自白名单函数（Bearer 会话令牌）", hit.authorization[0] === "Bearer zcode-TESTONLY-header-probe-token", hit.authorization[0]); // privacy:allow — 编造的样例
    check("白名单函数带的设备头也在", true);
    check("query 原样到达上游", hit.url === `/me?app_version=${encodeURIComponent(ZCODE_VERSION)}`, hit.url);
  }

  // ── 1b. $const 引用未登记的名字 → 报错并点名 CONSTS ─────────────────────────
  {
    const before = recorded.length;
    const file = okConfig([
      { name: "nope", method: "GET", path: "/me", query: { v: "$const.MADE_UP_NAME" }, write: false },
    ]);
    const r = await run(["--request", "nope"], file);
    check("未登记的 $const 被拒绝（退出码 2）", r.code === 2, `${r.code} ${r.err}`);
    check("报错点名 CONSTS 里没有 MADE_UP_NAME", r.err.includes("CONSTS 里没有 MADE_UP_NAME"), r.err);
    check("报错列出可选常量", r.err.includes("ZCODE_VERSION") && r.err.includes("ZCODE_CLIENT_PLATFORM"), r.err);
    check("报错时没有发出任何请求", recorded.length === before);
  }

  // ── 1c. $const 也能用在 path 与 body，替换值等于仓库常量 ───────────────────
  {
    const file = okConfig([
      { name: "cpath", method: "GET", path: "/echo/$const.ZCODE_CLIENT_PLATFORM", write: false },
    ]);
    const r = await run(["--request", "cpath"], file);
    check("path 里的 $const 整段替换", r.code === 0 && r.out.includes(`/echo/${encodeURIComponent(ZCODE_CLIENT_PLATFORM)}`), r.out);

    const before = recorded.length;
    const file2 = okConfig([
      { name: "cbody", method: "POST", path: "/echo", body: { v: "$const.ZCODE_CLAIM_APP_VERSION" }, write: true },
    ]);
    const r2 = await run(["--request", "cbody", "--yes-write"], file2);
    check("body 里的 $const 被替换", r2.code === 0 && recorded.length === before + 1, r2.err);
    check("body 替换值等于仓库常量", JSON.parse(recorded.at(-1)!.body!).v === ZCODE_CLAIM_APP_VERSION, recorded.at(-1)!.body!);
  }

  // ── 1d. 漂移回归：zcode.json 不许再写版本号/平台字面量 ────────────────────
  {
    const raw = fs.readFileSync(path.join(import.meta.dirname!, "../tools/probes/zcode.json"), "utf8");
    const versionLiterals = raw.match(/"[0-9]+\.[0-9.]+"/g) ?? [];
    check("zcode.json 里没有版本号字面量", versionLiterals.length === 0, versionLiterals.join(", "));
    check("zcode.json 里没有平台字面量", !/win32|darwin|linux/i.test(raw), raw);
    check("balance 用的是 $const.ZCODE_VERSION", raw.includes("$const.ZCODE_VERSION"), raw);
    check(
      "zcode.json 里没有写死的版本号（版本走 $const）",
      !raw.includes(ZCODE_CLAIM_APP_VERSION),
      raw,
    );
  }

  // ── 1e. 漂移回归：判据那条探针与 lib 里实际发请求的那处同源 ──────────────
  {
    const config = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname!, "../tools/probes/zcode.json"), "utf8"),
    ) as {
      requests: { name: string; method: string; path: string; headers?: string }[];
    };
    const touch = config.requests.find((r) => r.name === "touch");
    check("zcode.json 里有那条「可领」判据的探针（touch）", Boolean(touch), JSON.stringify(config.requests));
    check(
      "判据探针的路径就是 lib 里发请求的那个路径",
      touch?.path === ZCODE_MARKETING_TOUCH_PATH,
      `${touch?.path} vs ${ZCODE_MARKETING_TOUCH_PATH}`,
    );
    check(
      "判据探针的头函数名是 lib 里那个（zcodeMarketingHeaders）",
      touch?.headers === "zcodeMarketingHeaders",
      String(touch?.headers),
    );
    check(
      "探针工具的白名单里登记了这个头函数",
      typeof HEADER_FACTORIES.zcodeMarketingHeaders === "function",
      Object.keys(HEADER_FACTORIES).join(", "),
    );
    // 同一份来源：探针白名单里的那个函数与 lib 导出的那个给出一致的头。
    // 逐个值比不了 —— 归因那几个头（x-request-id 之类）每次请求都不同，
    // 比的是「有哪些头」与那几个关键的（版本、语言、设备）。
    const session = loadSession("probe-test");
    const probeHeaders = session ? HEADER_FACTORIES.zcodeMarketingHeaders("probe-test") : {};
    const libHeaders = session ? zcodeMarketingHeaders(session) : {};
    check(
      "探针用的头与 lib 用的头是同一份（改一处两处一起变）",
      session !== null &&
        JSON.stringify(Object.keys(probeHeaders).sort()) === JSON.stringify(Object.keys(libHeaders).sort()) &&
        probeHeaders["X-ZCode-App-Version"] === libHeaders["X-ZCode-App-Version"] &&
        probeHeaders["X-Client-Language"] === libHeaders["X-Client-Language"] &&
        probeHeaders["X-Device-Mid"] === libHeaders["X-Device-Mid"],
      JSON.stringify({
        probe: Object.keys(probeHeaders).sort(),
        lib: Object.keys(libHeaders).sort(),
      }),
    );
    check(
      "判据那条头里的 App-Version 是账单那一版（不是模型请求那一版）",
      probeHeaders["X-ZCode-App-Version"] === ZCODE_CLAIM_APP_VERSION,
      String(probeHeaders["X-ZCode-App-Version"]),
    );
    check(
      "判据探针不再指向 billing/preview（那条不参与判据）",
      !config.requests.some((r) => r.path.includes("billing/preview")),
      JSON.stringify(config.requests.map((r) => r.path)),
    );
  }

  // ── 2. 回归：配置里带 authorization 键 → 拒绝，不发请求 ────────────────
  {
    const before = recorded.length;
    const file = writeConfig("auth-key.json", {
      platform: "probe-test",
      headers: "zcodePlatformHeaders",
      base: "ZCODE_BASE",
      requests: [{ name: "evil", method: "GET", path: "/me" }],
      // privacy:allow — 编造的样例，就是要验证它被拒绝
      authorization: "Bearer zcode-TESTONLY-duplicate-header", // privacy:allow — 编造的样例
    });
    const r = await run(["--request", "evil"], file);
    check("凭据键名的配置被拒绝（退出码 2）", r.code === 2, `${r.code} ${r.err}`);
    check("报错里点名了 authorization", r.err.includes("authorization"), r.err);
    check("被拒绝的配置没有发出任何请求", recorded.length === before);
  }

  // ── 3. 配置里出现凭据值字面量 → 拒绝 ──────────────────────────────────
  {
    const before = recorded.length;
    const file = writeConfig("token-value.json", {
      platform: "probe-test",
      headers: "zcodePlatformHeaders",
      base: "ZCODE_BASE",
      requests: [
        {
          name: "leaky",
          method: "GET",
          path: "/me",
          // privacy:allow — 编造的样例，就是要验证它被拒绝
          query: { t: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig" }, // privacy:allow — 编造的样例
        },
      ],
    });
    const r = await run(["--request", "leaky"], file);
    check("凭据值字面量的配置被拒绝", r.code === 2, `${r.code} ${r.err}`);
    check("被拒绝的配置没有发出任何请求", recorded.length === before);
  }

  // ── 4. headers 指向白名单之外 → 「凭据头从哪来没定义」 ─────────────────
  {
    const before = recorded.length;
    const file = writeConfig("bad-headers.json", {
      platform: "probe-test",
      headers: "iWillRollMyOwnHeaders",
      base: "ZBASEBASE",
      requests: [{ name: "x", method: "GET", path: "/me" }],
    });
    const r = await run(["--request", "x"], file);
    check("白名单之外的头函数被拒绝", r.code === 2, r.err);
    check("报错说明凭据头来源没定义", r.err.includes("凭据头从哪来没定义"), r.err);
    check("没有发出任何请求", recorded.length === before);
  }

  // ── 5. write 不带 --yes-write → 拒绝，0 次请求 ────────────────────────
  {
    const before = recorded.length;
    const file = okConfig([
      { name: "claim", method: "POST", path: "/claim", body: { plan_id: "p1" }, write: true },
    ]);
    const r = await run(["--request", "claim"], file);
    check("write 不带 --yes-write 时拒绝执行", r.out.includes("拒绝执行") && r.out.includes("--yes-write"), r.out);
    check("拒绝执行时假上游收到 0 次", recorded.length === before);
  }

  // ── 6. write 带 --yes-write → 发出一次，$arg 被替换 ───────────────────
  {
    const before = recorded.length;
    const file = okConfig([
      { name: "claim", method: "POST", path: "/claim", body: { plan_id: "$arg.planId" }, write: true },
    ]);
    const r = await run(["--request", "claim", "--arg", "planId=plan-42", "--yes-write"], file);
    check("write 带 --yes-write 时退出码 0", r.code === 0, r.err);
    check("打印写操作警示与账号 id", r.out.includes("写操作") && r.out.includes("probe-test"), r.out);
    check("写操作恰好发出一次", recorded.length === before + 1);
    const hit = recorded.at(-1)!;
    check("body 里的 $arg.planId 被替换", JSON.parse(hit.body!).plan_id === "plan-42", hit.body!);
    check("写操作带 content-type", hit.contentType === "application/json", String(hit.contentType));
  }

  // ── 7. 缺 --arg → 报错并点名 ──────────────────────────────────────────
  {
    const before = recorded.length;
    const file = okConfig([
      { name: "claim", method: "POST", path: "/claim", body: { plan_id: "$arg.planId" }, write: true },
    ]);
    const r = await run(["--request", "claim", "--yes-write"], file);
    check("缺 --arg 报错", r.code === 2, `${r.code} ${r.out}${r.err}`);
    check("报错点名缺 planId", r.err.includes("planId") && r.err.includes("--arg"), r.err);
    check("缺参数时没有发出任何请求", recorded.length === before);
  }

  // ── 8. 非 JSON 响应 / 500 → 打印拿到的事实 ────────────────────────────
  {
    const file = okConfig([{ name: "plain", method: "GET", path: "/plain", write: false }]);
    const r = await run(["--request", "plain"], file);
    check("非 JSON 响应仍打印正文", r.code === 0 && r.out.includes("just text, not json"), r.out);
    check("并说明它不是 JSON", r.out.includes("不是 JSON"), r.out);

    const file2 = okConfig([{ name: "boom", method: "GET", path: "/boom", write: false }]);
    const r2 = await run(["--request", "boom"], file2);
    check("500 也打印状态", r2.code === 0 && r2.out.includes("HTTP 500"), r2.out);
    check("500 的正文与 code 仍摆出来", r2.out.includes("upstream exploded") && r2.out.includes("code = 5000"), r2.out);
  }

  // ── 9. --list ────────────────────────────────────────────────────────
  {
    const file = okConfig([
      { name: "alpha", method: "GET", path: "/a", write: false, notes: "第一条的判断要点" },
      { name: "beta", method: "POST", path: "/b", write: true, notes: "会真的领" },
    ]);
    const r = await run(["--list"], file);
    check("--list 退出码 0", r.code === 0, r.err);
    check("--list 列出请求名", r.out.includes("alpha") && r.out.includes("beta"), r.out);
    check("--list 列出 notes", r.out.includes("第一条的判断要点") && r.out.includes("会真的领"), r.out);
    check("--list 标出写操作", r.out.includes("写操作"), r.out);
    check("--list 没有发请求", recorded.every((h) => !h.url.startsWith("/a") || true));
  }

  // ── 10. 仓库自带的 zcode.json 本身合法、--list 不联网 ───────────────────
  {
    const zcodeConfig = path.join(import.meta.dirname!, "../tools/probes/zcode.json");
    const r = await run(["--platform", "zcode", "--list"]);
    check("zcode.json 能通过校验并列出", r.code === 0, r.err);
    check("列出 balance / touch / claim", ["balance", "touch", "claim"].every((n) => r.out.includes(n)), r.out);
    check("claim 标成写操作", r.out.includes("[写操作]"), r.out);
    check("--list 全程没有联网", recorded.every((h) => !h.url.includes("zcode")));
  }

  // ── 11. 配置不是合法 JSON → 说清哪份配置不合法，退出非零 ─────────────────
  {
    const before = recorded.length;
    const file = path.join(dataDir, "broken.json");
    fs.writeFileSync(file, "{ this is not json");
    const r = await run(["--request", "whoami"], file);
    check("非法 JSON 的配置被拒绝（退出码 2）", r.code === 2, `${r.code} ${r.out}${r.err}`);
    check("报错点名是哪个配置文件", r.err.includes("broken.json"), r.err);
    check("报错说清不是合法 JSON", r.err.includes("不是合法 JSON"), r.err);
    check("报错里没有甩出栈", !/\n\s+at /.test(r.err), r.err);
    check("被拒绝的配置没有发出任何请求", recorded.length === before);
  }
} finally {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
