// tools/probe.ts — 声明式的上游探针：配置在 tools/probes/<platform>.json，
// 这里的执行器只负责把它们发出去、把拿到的事实打印出来。
//
//   mise run probe -- --platform zcode --list
//   mise run probe -- --account <id> --platform zcode --request balance
//   mise run probe -- --account <id> --platform zcode --request claim --arg planId=xxx --yes-write
//
// 为什么不能手写一次性脚本：2026-10-28 那次手写探针里多叠了一个大写的
// Authorization，而 zcodePlatformHeaders() 已带小写 authorization —— fetch
// 把两个键拼成非法值，上游一律 401，据此误判「令牌过期」。手写探针的错
// 长得像上游的错。所以：头只来自白名单函数，配置里不许出现凭据字面量，
// 执行器自己也绝不添加 authorization / x-api-key / cookie。

import fs from "node:fs";
import path from "node:path";
import { scrubForLog } from "../lib/log-scrub.ts";
// 假上游只有两条固定入口之一：手动看探针会发什么，用 --dry-run / --fake，
// 不许自己在 /tmp 写服务器文件用 & 起后台进程。
import { startFakeUpstream } from "../test/fake-upstream.ts";
import { loadSession, ZCODE_BASE, ZCODE_VERSION } from "../lib/zcode/auth.ts";
import { ZCODE_CLAIM_APP_VERSION } from "../lib/zcode/claim.ts";
import { zcodeMarketingHeaders } from "../lib/zcode/marketing.ts";
import { ZCODE_CLIENT_PLATFORM, zcodePlatformHeaders } from "../lib/zcode/transport.ts";

// ── 白名单 ────────────────────────────────────────────────────────────────

/**
 * 头函数的登记处。配置里的 "headers" 只能写这里出现过的名字 —— 凭据头的
 * 拼法（哪些头、大小写、带不带 device id）是各平台 kind 的事，探针不许
 * 自己再拼一份。要给新平台加探针：在 lib/<kind>/transport.ts 里找现成的
 * 头函数，登记进来，再写 tools/probes/<platform>.json。
 *
 * 函数自己负责按 account 加载会话；拿不到会话就抛错，执行器不会兜底补头。
 */
export type HeaderFactory = (account: string) => Record<string, string>;

export const HEADER_FACTORIES: Record<string, HeaderFactory> = {
  zcodePlatformHeaders(account: string) {
    const session = loadSession(account);
    if (!session) throw new Error(`账号 ${account} 没有 zcode 会话（先在面板里登录这个账号）`);
    return zcodePlatformHeaders(session);
  },
  // 投放接口（marketing/touch）：平台头 + 账单那一版的 App-Version + 语言。
  // 头在 lib 里拼（同一份常量），探针只调用它 —— 两边不会各写一份。
  zcodeMarketingHeaders(account: string) {
    const session = loadSession(account);
    if (!session) throw new Error(`账号 ${account} 没有 zcode 会话（先在面板里登录这个账号）`);
    return zcodeMarketingHeaders(session);
  },
};

/** base 名字的登记处：配置里的 "base" 只能指向仓库里已有的常量。 */
export const BASES: Record<string, () => string> = {
  ZCODE_BASE: () => ZCODE_BASE,
};

/**
 * `$const.<NAME>` 的登记处：配置里只能引用这里出现过的仓库常量。
 *
 * 为什么不让配置写版本号/平台字面量：网关真实发的版本来自 lib 里的常量，
 * 探针配置里再写死一份必然漂移（preview 的 app_version 就漂过一次），
 * 问出去的是「另一个客户端身份」的问题，答案对网关没有代表性。
 */
export const CONSTS: Record<string, () => string> = {
  ZCODE_VERSION: () => ZCODE_VERSION,
  ZCODE_CLAIM_APP_VERSION: () => ZCODE_CLAIM_APP_VERSION,
  ZCODE_CLIENT_PLATFORM: () => ZCODE_CLIENT_PLATFORM,
};

// ── 配置 ─────────────────────────────────────────────────────────────────

export interface ProbeRequest {
  name: string;
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  write?: boolean;
  notes?: string;
  /**
   * 这一条用哪个头函数（默认用配置文件里的那个）。
   *
   * 为什么允许单独指定：同一平台里不同接口的头不一样（投放接口要账单那一版
   * 的 App-Version 与语言）。头还是在 lib 里拼，配置只写名字。
   */
  headers?: string;
}

export interface ProbeConfig {
  platform: string;
  headers: string;
  base: string;
  requests: ProbeRequest[];
}

/** 配置里不许出现的键名：探针配置只描述形状，凭据永远来自白名单函数。 */
const CREDENTIAL_KEY = /(authorization|cookie|token|api[-_]?key|password|secret|bearer|x-api-key)/i;

/** 值里像版本号/平台字面量的形状：配置要写常量名，不是值。 */
const DRIFT_VALUE = [/^3\.\d+/, /^win32|^darwin|^linux/i];

/** 值里像真凭据的形状：Bearer 前缀、sk- 开头的 key、JWT 的两段 base64。 */
const CREDENTIAL_VALUE = [/^bearer\s/i, /^sk-[A-Za-z0-9_-]{16,}$/, /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/];

function findLiterals(value: unknown, where: string): string[] {
  const hits: string[] = [];
  const walk = (v: unknown, where: string) => {
    if (typeof v === "string") {
      if (CREDENTIAL_VALUE.some((re) => re.test(v))) hits.push(`${where}: 值长得像凭据`);
      else if (DRIFT_VALUE.some((re) => re.test(v))) hits.push(`${where}: 值长得像版本号/平台字面量 —— 写常量名（$const.X），不写值`);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${where}[${i}]`));
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        if (CREDENTIAL_KEY.test(k)) hits.push(`${where}.${k}: 配置里不许出现凭据键名`);
        walk(child, `${where}.${k}`);
      }
    }
  };
  walk(value, where);
  return hits;
}

/** 校验配置：凭据字面量、白名单名字、请求的基本形状。不合法就抛错。 */
export function validateConfig(config: ProbeConfig): void {
  const problems: string[] = [];
  for (const hit of findLiterals(config, "config")) problems.push(hit);
  if (!(config.headers in HEADER_FACTORIES)) {
    problems.push(
      `headers "${config.headers}" 不在白名单里（可选：${Object.keys(HEADER_FACTORIES).join(", ")}）—— 这个平台的凭据头从哪来没定义`,
    );
  }
  if (!(config.base in BASES)) {
    problems.push(`base "${config.base}" 不在登记处（可选：${Object.keys(BASES).join(", ")}）`);
  }
  const names = new Set<string>();
  for (const req of config.requests ?? []) {
    if (!req.name || !req.method || !req.path) problems.push(`请求缺 name / method / path：${JSON.stringify(req)}`);
    if (names.has(req.name)) problems.push(`请求名重复：${req.name}`);
    names.add(req.name);
    if (req.headers && !(req.headers in HEADER_FACTORIES)) {
      problems.push(
        `请求 ${req.name} 的 headers "${req.headers}" 不在白名单里（可选：${Object.keys(HEADER_FACTORIES).join(", ")}）`,
      );
    }
  }
  if (problems.length) throw new Error(`探针配置不合法：\n  - ${problems.join("\n  - ")}`);
}

export function loadConfig(file: string): ProbeConfig {
  const config = JSON.parse(fs.readFileSync(file, "utf8")) as ProbeConfig;
  validateConfig(config);
  return config;
}

// ── 参数 ─────────────────────────────────────────────────────────────────

interface Args {
  account?: string;
  platform?: string;
  request?: string;
  config?: string;
  arg: Record<string, string>;
  yesWrite: boolean;
  raw: boolean;
  timeoutMs: number;
  list: boolean;
  dryRun: boolean;
  fake: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { arg: {}, yesWrite: false, raw: false, timeoutMs: 20_000, list: false, dryRun: false, fake: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--account") args.account = argv[++i];
    else if (a === "--platform") args.platform = argv[++i];
    else if (a === "--request") args.request = argv[++i];
    else if (a === "--config") args.config = argv[++i];
    else if (a === "--arg") {
      const kv = argv[++i] ?? "";
      const eq = kv.indexOf("=");
      if (eq <= 0) throw new Error(`--arg 要 k=v 的形状，拿到的是 "${kv}"`);
      args.arg[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === "--yes-write") args.yesWrite = true;
    else if (a === "--raw") args.raw = true;
    else if (a === "--timeout") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`--timeout 要正整数毫秒，拿到的是 "${argv[i]}"`);
      args.timeoutMs = n;
    } else if (a === "--list") args.list = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--fake") args.fake = true;
    else throw new Error(`不认识的参数：${a}`);
  }
  return args;
}

// ── $arg 注入 ────────────────────────────────────────────────────────────

const ARG_REF = /^\$arg\.([A-Za-z0-9_]+)$/;
const CONST_REF = /^\$const\.([A-Za-z0-9_]+)$/;

function substitute(
  value: unknown,
  provided: Record<string, string>,
  where: string,
  missing: string[],
  constErrors: string[],
): unknown {
  if (typeof value === "string") {
    const c = CONST_REF.exec(value);
    if (c) {
      if (!(c[1] in CONSTS)) {
        constErrors.push(`${where}: CONSTS 里没有 ${c[1]}（可选：${Object.keys(CONSTS).join(", ")}）`);
        return value;
      }
      return CONSTS[c[1]]();
    }
    const m = ARG_REF.exec(value);
    if (m) {
      if (!(m[1] in provided)) {
        missing.push(`${where} 需要 --arg ${m[1]}=…`);
        return value;
      }
      return provided[m[1]];
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => substitute(v, provided, `${where}[${i}]`, missing, constErrors));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v, provided, `${where}.${k}`, missing, constErrors);
    return out;
  }
  return value;
}

// ── 执行 ─────────────────────────────────────────────────────────────────

const CREDENTIAL_HEADER = /^(authorization|x-api-key|cookie)$/i;

export function assertCredentialHeader(headers: Record<string, string>): void {
  if (!Object.keys(headers).some((k) => CREDENTIAL_HEADER.test(k))) {
    throw new Error("解析出来的头里没有任何凭据头（authorization / x-api-key / cookie）—— 这个平台的凭据头从哪来没定义，不发送");
  }
}

/**
 * path 里的替换：$const.X / $arg.X 可以出现在路径中间（如 /echo/$const.X），
 * 逐个出现位置替换；不像 query/body 那样要求整个值就是引用。
 */
function substituteInline(
  value: string,
  provided: Record<string, string>,
  where: string,
  missing: string[],
  constErrors: string[],
): string {
  return value.replace(/\$(?:arg|const)\.([A-Za-z0-9_]+)/g, (whole, name) => {
    if (whole.startsWith("$const")) {
      if (!(name in CONSTS)) {
        constErrors.push(`${where}: CONSTS 里没有 ${name}（可选：${Object.keys(CONSTS).join(", ")}）`);
        return whole;
      }
      return CONSTS[name]();
    }
    if (!(name in provided)) {
      missing.push(`${where} 需要 --arg ${name}=…`);
      return whole;
    }
    return provided[name];
  });
}

/** 拼 URL：base + path，query 原样拼进去（值来自配置或 --arg，不再加工）。 */
function buildUrl(
  base: string,
  req: ProbeRequest,
  provided: Record<string, string>,
): { url: string; missing: string[]; constErrors: string[] } {
  const missing: string[] = [];
  const constErrors: string[] = [];
  const pathPart = substituteInline(req.path, provided, "path", missing, constErrors);
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query ?? {})) {
    search.set(k, String(substitute(v, provided, `query.${k}`, missing, constErrors)));
  }
  const qs = search.toString();
  return { url: `${base}${pathPart}${qs ? `?${qs}` : ""}`, missing, constErrors };
}

/** 请求引用了哪些 $arg 名字（不算缺，只是清单）。 */
export function requestArgNames(req: ProbeRequest): string[] {
  const names: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") {
      const m = ARG_REF.exec(value);
      if (m) names.push(m[1]);
      return;
    }
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(req.path);
  collect(req.query ?? {});
  collect(req.body ?? {});
  return [...new Set(names)];
}

function printJsonFacts(bodyText: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    console.log("正文不是 JSON —— 探针只摆事实，不猜它是什么");
    return;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const keys = Object.keys(parsed as Record<string, unknown>);
    console.log(`JSON 顶层键：${keys.join(", ") || "(空对象)"}`);
    for (const key of ["code", "msg", "data"]) {
      if (key in (parsed as Record<string, unknown>)) {
        const v = (parsed as Record<string, unknown>)[key];
        console.log(`  ${key} = ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
      }
    }
  } else {
    console.log(`JSON 顶层是 ${Array.isArray(parsed) ? `数组（${parsed.length} 项）` : typeof parsed}`);
  }
}

async function runOne(config: ProbeConfig, req: ProbeRequest, args: Args, file: string): Promise<void> {
  const headerFactory = HEADER_FACTORIES[req.headers ?? config.headers];
  if (!headerFactory) {
    throw new Error(`headers "${req.headers ?? config.headers}" 不在白名单里 —— 这个平台的凭据头从哪来没定义`);
  }
  const base = BASES[config.base]?.();
  if (!base) throw new Error(`base "${config.base}" 不在登记处`);

  // 写操作的闸门在发送之前：一旦写出去就没有降级的余地。
  if (req.write && !args.yesWrite) {
    console.log(`拒绝执行：${req.name} 是写操作，会改变上游状态。确认要执行时加 --yes-write`);
    return;
  }
  if (req.write) {
    if (!args.account) throw new Error("写操作必须明确 --account <id>：写的是哪个账号的权益");
    console.log(`⚠ 这是写操作，会改变上游状态（账号 ${args.account}，配置 ${file}）`);
  }

  const missing = requestArgNames(req)
    .filter((name) => !(name in args.arg))
    .map((name) => `这个请求需要 --arg ${name}=…`);
  if (missing.length) {
    throw new Error(`缺命令行参数：\n  - ${missing.join("\n  - ")}`);
  }

  // 看而不发的两个开关不经过发送闸门：凭据头加载不出来照样摆事实（没有
  // --account 也能看形状）；真正要发送的路径仍走 assertCredentialHeader。
  let headers: Record<string, string>;
  let headerNote = "";
  if (args.dryRun || args.fake) {
    try {
      headers = headerFactory(args.account ?? "");
    } catch (err) {
      headers = {};
      headerNote = `（凭据头没加载出来：${(err as Error).message}）`;
    }
  } else {
    headers = headerFactory(args.account ?? "");
    assertCredentialHeader(headers);
  }

  const { url, constErrors } = buildUrl(base, req, args.arg);
  if (constErrors.length) throw new Error(`配置引用了未登记的常量：\n  - ${constErrors.join("\n  - ")}`);
  const body =
    req.body === undefined
      ? undefined
      : JSON.stringify(substitute(req.body, args.arg, "body", missing, constErrors));
  const method = req.method.toUpperCase();

  // 「我要看这个探针到底会发什么」的标准答案，替代自己在 /tmp 写个 srv.mjs。
  // --dry-run：一个请求都不发；--fake：发到进程内假上游，绝不碰真上游。
  if (args.dryRun || args.fake) {
    const describe = (target: string) => {
      console.log(`${method} ${target}${headerNote}`);
      for (const [k, v] of Object.entries(headers)) console.log(`  ${k}: <值长度 ${v.length}>`);
      console.log(body === undefined ? "  body:（无）" : `  body: ${body}`);
    };
    if (args.dryRun) {
      console.log("--dry-run：不发送，将要发出的请求如下");
      describe(url);
      return;
    }
    const fake = await startFakeUpstream();
    try {
      const u = new URL(url);
      const target = `${fake.url}${u.pathname}${u.search}`;
      console.log("--fake：发到进程内假上游，发出去的是：");
      describe(target);
      const res = await fetch(target, {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body,
      });
      const text = await res.text();
      console.log(`← 收到 HTTP ${res.status}：${text}`);
    } finally {
      await fake.close();
    }
    return;
  }

  console.log(`→ ${method} ${url}`);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body,
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.log(`✗ 请求没有拿到响应（${Date.now() - started} ms）：${reason}`);
    console.log("拿到的东西：什么都没有 —— 连接层就失败了，上游一个字都没说");
    return;
  }
  const elapsed = Date.now() - started;
  const text = await res.text();
  console.log(`← HTTP ${res.status}（${elapsed} ms）`);
  console.log(args.raw ? text : scrubForLog(text, 1500));
  printJsonFacts(text);
}

// ── main ─────────────────────────────────────────────────────────────────

function configPathFor(platform: string): string {
  return path.join(import.meta.dirname!, "probes", `${platform}.json`);
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(String((err as Error).message));
    return 2;
  }

  if (!args.platform) {
    console.error("缺 --platform（tools/probes/ 下现在有哪些平台，看目录）");
    return 2;
  }

  const file = args.config ?? configPathFor(args.platform);
  if (!fs.existsSync(file)) {
    console.error(`没有这个平台的探针配置：${file} —— 别硬凑，等真有人用再加`);
    return 2;
  }

  let config: ProbeConfig;
  try {
    config = loadConfig(file);
  } catch (err) {
    console.error(String((err as Error).message));
    return 2;
  }

  if (args.list) {
    console.log(`平台 ${config.platform}（配置 ${file}）声明的请求：`);
    for (const req of config.requests) {
      console.log(`  ${req.name.padEnd(12)} ${req.method.padEnd(5)} ${req.path}${req.write ? "  [写操作]" : ""}`);
      if (req.notes) console.log(`    ${req.notes}`);
    }
    return 0;
  }

  if (!args.request) {
    console.error("缺 --request（用 --list 看这个平台有哪些请求）");
    return 2;
  }
  const req = config.requests.find((r) => r.name === args.request);
  if (!req) {
    console.error(`配置里没有名为 "${args.request}" 的请求（有：${config.requests.map((r) => r.name).join(", ")}）`);
    return 2;
  }

  try {
    await runOne(config, req, args, file);
  } catch (err) {
    console.error(String((err as Error).message));
    return 2;
  }
  return 0;
}

// 直接跑才进 main；被测试 import 时不做事。
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await main(process.argv.slice(2));
}
