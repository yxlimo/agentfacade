// test/log-capture.ts — 抓取 log.* 打算说的话，不碰传输层。
//
// 这里 patch lib/log.ts 导出的 log 对象，把每次调用的文案收进数组。它抓的是
// 「代码打算说什么」：级别过滤、stdout/stderr 分流、JSON 形状这些属于传输层，
// 由 test/log-check.ts 用子进程钉住。抓到 log.info 不等于验了输出字节 —— 两层
// 分工，别把它们混成一个测试。
//
// log 是稳定的 const 对象，调用点写 log.info(...) 是调用时查属性，所以事后 patch
// 生效；收尾一定 restore，免得污染同进程后面的断言。

import { log } from "../lib/log.ts";

export type LogMethod = "debug" | "info" | "warn" | "error";

export interface LogCapture {
  /** 每个方法收到的行，按调用顺序 */
  lines: Record<LogMethod, string[]>;
  /** 选中的方法合在一起的行，保持全局调用顺序 */
  all: string[];
  /** 把 log.* 放回原样 */
  restore(): void;
}

interface Options {
  methods?: LogMethod[];
  /** 是否把抓到的行照旧转给原 log 方法（默认吞掉，不打到终端） */
  forward?: boolean | ((line: string) => boolean);
  /** 把一次调用的参数拼成一行；默认按 console 语义空格 join。某项要认 Error 时用这个。 */
  format?: (args: unknown[]) => string;
  /** 调用方自带的收集数组：抓到的行也推进这里，all 就指向它。要原地清空的场景用。 */
  sink?: string[];
}

export function captureLog(options: Options = {}): LogCapture {
  const methods = options.methods ?? ["debug", "info", "warn", "error"];
  const lines: Record<LogMethod, string[]> = { debug: [], info: [], warn: [], error: [] };
  const all: string[] = options.sink ?? [];
  const originals = new Map<LogMethod, (...args: unknown[]) => unknown>();
  // log 的四个方法签名一致，写属性需要绕开「各键返回类型」的严格检查
  const target = log as unknown as Record<LogMethod, (...args: unknown[]) => unknown>;

  for (const method of methods) {
    const original = target[method];
    originals.set(method, original);
    target[method] = (...args: unknown[]) => {
      const line = options.format ? options.format(args) : args.map((one) => String(one)).join(" ");
      lines[method].push(line);
      all.push(line);
      const forward = options.forward;
      if (forward === true || (typeof forward === "function" && forward(line))) {
        original(...args);
      }
    };
  }

  return {
    lines,
    all,
    restore() {
      for (const [method, original] of originals) target[method] = original;
    },
  };
}
