// test/log-check.ts — 日志出口的对外行为：默认逐字节、分流、级别、JSON、多参。
//
//   node --experimental-strip-types test/log-check.ts
//
// lib/log.ts 是叶子模块，只读 env、不发请求、不碰库。这里用子进程跑它，
// 分开收 stdout 与 stderr，再把看到的东西和 console.* 以前的行为对齐。
// 不启服务器、不碰上游、不碰默认数据目录。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(ROOT, "lib/log.ts");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "log-check-"));

let pass = 0;
let fail = 0;

function check(name: string, ok: unknown, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(script: string, env: Record<string, string> = {}): RunResult {
  // process.env 的键是 string | undefined，这里只要 string：显式收窄，
  // 让 delete 两行有自己的类型。
  const childEnv: Record<string, string | undefined> = { ...process.env, FACADE_DATA_DIR: dataDir };
  delete childEnv.FACADE_LOG_LEVEL;
  delete childEnv.FACADE_LOG_FORMAT;
  Object.assign(childEnv, env);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "-e", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: childEnv,
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const load = `const { log } = await import(${JSON.stringify(LOG)});`;

try {
  console.log("");
  console.log("默认文本：stdout 原样、stderr 空");
  {
    const r = run(`${load}\nlog.info("[TEST] 原样文案");`);
    check("退出码 0", r.status === 0, String(r.status));
    check("stdout 一字不差（含中文与方括号）", r.stdout === "[TEST] 原样文案\n", JSON.stringify(r.stdout));
    check("stderr 空", r.stderr === "", JSON.stringify(r.stderr));
  }

  console.log("");
  console.log("分流：info → stdout，warn/error → stderr");
  {
    const r = run(`${load}\nlog.info("[TEST] out");\nlog.warn("[TEST] err");`);
    check("info 在 stdout", r.stdout === "[TEST] out\n", JSON.stringify(r.stdout));
    check("warn 在 stderr", r.stderr === "[TEST] err\n", JSON.stringify(r.stderr));
  }
  {
    const r = run(`${load}\nlog.error("[TEST] boom");`);
    check("error 在 stderr", r.stderr === "[TEST] boom\n", JSON.stringify(r.stderr));
    check("error 时 stdout 空", r.stdout === "", JSON.stringify(r.stdout));
  }

  console.log("");
  console.log("级别：FACADE_LOG_LEVEL=warn 滤掉 info");
  {
    const r = run(`${load}\nlog.info("[TEST] hidden");\nlog.warn("[TEST] kept");`, {
      FACADE_LOG_LEVEL: "warn",
    });
    const all = r.stdout + r.stderr;
    check("info 不出现", !all.includes("[TEST] hidden"), JSON.stringify(all));
    check("warn 仍在", all.includes("[TEST] kept"), JSON.stringify(all));
  }
  {
    const r = run(`${load}\nlog.info("[TEST] silent-out");`, { FACADE_LOG_LEVEL: "silent" });
    check("silent 什么都不出", r.stdout === "" && r.stderr === "", JSON.stringify(r.stdout + r.stderr));
  }

  console.log("");
  console.log("JSON：FACADE_LOG_FORMAT=json 每行一个带 level/message/timestamp 的对象");
  {
    const r = run(`${load}\nlog.info("[TEST] json line");`, { FACADE_LOG_FORMAT: "json" });
    const line = r.stdout.trim();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
    check("stdout 是一行合法 JSON", parsed !== null, JSON.stringify(line));
    check("有 level", parsed?.level === "info", JSON.stringify(parsed));
    check("message 仍带 [TEST]", parsed?.message === "[TEST] json line", JSON.stringify(parsed));
    check("有 timestamp 字符串", typeof parsed?.timestamp === "string", JSON.stringify(parsed));
    check("JSON 模式 stderr 空", r.stderr === "", JSON.stringify(r.stderr));
  }

  console.log("");
  console.log("多参：按 console 语义用空格 join 成一条 message");
  {
    const r = run(`${load}\nlog.info("a", 1, "b");`);
    check("a 1 b 一条", r.stdout === "a 1 b\n", JSON.stringify(r.stdout));
  }
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log("");
console.log(`${pass} ok, ${fail} failed`);
if (fail) process.exit(1);
