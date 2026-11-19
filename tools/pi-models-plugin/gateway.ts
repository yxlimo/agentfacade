// 网关地址从哪来、/v1/models 怎么拉。网络与文件系统都在这一层，方便测试注入。
//
// 地址的解析顺序与 helper/common.py 的 resolve_gateway() 一致（脚本里是
// --gateway > FACADE_GATEWAY > 配置文件，插件没有命令行参数，所以从环境变量
// 起）：PI_BUDDY_GATEWAY > FACADE_GATEWAY > ~/.config/buddy-helper/config.json
// 的 gateway 字段。**不内置默认地址**：猜错（127.0.0.1 还是 NAS 上那份）等于
// 对着错的网关取模型清单，报出来的东西没意义。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 三级都没配时试这个。不是猜的：`helper/README.md` 把 `http://127.0.0.1:6450`
 * 写成默认地址（网关通常就跑在本机），脚本的用户手册也这么讲。实测本机
 * 127.0.0.1:6450 与局域网那份地址返回同一份 17 条清单。
 *
 * 只试这一个，不做局域网扫描：扫描要花时间、结果不确定，而 pi 的扩展工厂在启动
 * 路径上被 await —— 拿启动延迟换一次没把握的发现不划算。用户要指别处，写配置文件
 * （`buddy_sync.py --set-gateway`）或设环境变量。
 */
export const DEFAULT_GATEWAY = "http://127.0.0.1:6450";

/** 默认值也连不上时的提示：既说清怎么指别处，也说明这不是 fatal */
export const NO_GATEWAY_HINT =
  `no gateway configured and the default ${DEFAULT_GATEWAY} is unreachable: set PI_BUDDY_GATEWAY, ` +
  'or FACADE_GATEWAY, or write {"gateway": "http://gateway.example:6450"} ' +
  "to ~/.config/buddy-helper/config.json";

/**
 * 启动时等网关的上限。pi 的扩展工厂是 async，它在启动路径上被 await，
 * 所以这个数字直接等于「网关挂掉时 pi 多等多久」。1500ms 留了 500ms 余量给
 * 请求本身以外的开销（实测见 README），保证不可达时不超过 2 秒。
 */
export const DEFAULT_TIMEOUT_MS = 1500;

/** 配置文件名与键名照抄脚本，两边读同一份文件 */
const CONFIG_DIR = [".config", "buddy-helper"];
const CONFIG_FILE = "config.json";

export type ResolvedGateway =
  | { ok: true; gateway: string; from: "PI_BUDDY_GATEWAY" | "FACADE_GATEWAY" | "config file" | "default" }
  | { ok: false; error: string };

/** 末尾的斜杠一律去掉：后面统一拼 `/v1/models` */
function clean(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

/** http(s) 才认。写错的地址（少了 scheme、写成 file://）在这里就报出来 */
function usable(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** 配置文件里的 gateway 字段。没有文件、文件坏了、没有这个键都当没有 */
export function readGatewayConfig(home: string = os.homedir()): string {
  const file = path.join(home, ...CONFIG_DIR, CONFIG_FILE);
  try {
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof data !== "object" || data === null) return "";
    return clean((data as Record<string, unknown>).gateway);
  } catch {
    return "";
  }
}

/**
 * 这次要用的网关地址。四级：PI_BUDDY_GATEWAY → FACADE_GATEWAY → 配置文件 →
 * `DEFAULT_GATEWAY`。前三级写错了（不是 http(s)）就报错，不悄悄换成默认值 ——
 * 写错地址的人需要知道写错了，拿默认值顶上去只会让他以为配置生效了。
 *
 * env 与 home 可以传：测试要把配置文件指到临时目录，不能读真实主目录。
 */
export function resolveGateway(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): ResolvedGateway {
  const candidates: Array<[string, "PI_BUDDY_GATEWAY" | "FACADE_GATEWAY"]> = [
    ["PI_BUDDY_GATEWAY", "PI_BUDDY_GATEWAY"],
    ["FACADE_GATEWAY", "FACADE_GATEWAY"],
  ];
  for (const [name, from] of candidates) {
    const value = clean(env[name]);
    if (!value) continue;
    return usable(value) ? { ok: true, gateway: value, from } : { ok: false, error: `${name} is not an http(s) URL: ${value}` };
  }
  const configured = readGatewayConfig(home);
  if (configured) {
    return usable(configured)
      ? { ok: true, gateway: configured, from: "config file" }
      : { ok: false, error: `config file gateway is not an http(s) URL: ${configured}` };
  }
  // 默认值让插件开箱能用（网关一般就在本机）。连不上时 fetch 那边会失败，
  // 插件保持不注册、models.json 继续生效，所以这个默认值不会把谁坑死。
  return { ok: true, gateway: DEFAULT_GATEWAY, from: "default" };
}

/** 网关的模型清单地址。主路由是根路径下的 /v1/models */
export function modelsUrl(gateway: string): string {
  return `${gateway}/v1/models`;
}

export type ModelListResult =
  | { ok: true; data: unknown[] }
  /** cancelled：调用方（pi）自己取消了这次刷新，不是网关的问题，不该当成失败报给人看 */
  | { ok: false; cancelled: boolean; error: string };

export interface FetchOptions {
  timeoutMs?: number;
  /** pi 给的取消信号（刷新目录时带着）；与超时取先到的一个 */
  signal?: AbortSignal;
  /** 注入 fetch 用，测试靠它制造永不响应的上游 */
  fetchImpl?: typeof fetch;
}

/**
 * 拉模型清单。**任何失败都只是 error，不抛**：调用方（启动路径）要能安静地
 * 保持原状，不能让 pi 的启动崩在一个拉不到的网关上。
 */
export async function fetchModelList(gateway: string, options: FetchOptions = {}): Promise<ModelListResult> {
  const url = modelsUrl(gateway);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const run = options.fetchImpl ?? fetch;

  // 传进来的 signal 可能已经 abort 了（pi 会把旧那次的刷新取消掉）。已经 abort 的
  // signal 不再触发 abort 事件，光加监听器会眼看着请求照发出去
  if (options.signal?.aborted) return { ok: false, cancelled: true, error: `${url} cancelled` };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onOuterAbort);

  // 超时可能发生在拿到响应头之后（读 body 时），所以错误文案统一先看 timedOut
  const fail = (message: string): ModelListResult =>
    timedOut
      ? { ok: false, cancelled: false, error: `${url} timed out after ${timeoutMs}ms` }
      : { ok: false, cancelled: false, error: message };

  try {
    const response = await run(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return fail(`${url} answered HTTP ${response.status}`);
    const payload: unknown = await response.json().catch(() => undefined);
    if (typeof payload !== "object" || payload === null) return fail(`${url} did not answer a JSON object`);
    const data = (payload as Record<string, unknown>).data;
    // data 不是数组时按失败处理而不是按空清单处理：空清单会让调用方以为
    // 「网关上一个模型都没有」，那是另一件事（也不注册，但警告的含义不同）
    if (!Array.isArray(data)) return fail(`${url} has no "data" list`);
    return { ok: true, data };
  } catch (error) {
    if (timedOut) return fail(`${url} timed out after ${timeoutMs}ms`);
    if (options.signal?.aborted) return { ok: false, cancelled: true, error: `${url} cancelled` };
    return fail(`${url} unreachable: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}
