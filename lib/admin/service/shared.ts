// lib/admin/service/shared.ts — 面板形状的小工具：取整、毫秒、presence 收窄。
//
// 从 service.ts 上半原样搬来：proto 的 int32/int64 与 presence 的规矩都在这几个
// 函数里收口，视图层与各方法分片都从这里拿，不再各写一份。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import { UsageBucketSchema, UsageSummarySchema } from "../../gen/agentfacade/admin/v1/admin_pb.ts";
import type { UsageTotals } from "../usage.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 服务的版本号。 */
export function serviceVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "..", "package.json"), "utf8"));
    return String(pkg.version ?? "");
  } catch {
    return "";
  }
}

/** 一个用量的合计。 */
export function usageSummaryMessage(summary: UsageTotals) {
  return create(UsageSummarySchema, {
    requests: BigInt(summary.requests),
    succeeded: BigInt(summary.succeeded),
    failed: BigInt(summary.failed),
    promptTokens: BigInt(summary.promptTokens),
    completionTokens: BigInt(summary.completionTokens),
    reasoningTokens: BigInt(summary.reasoningTokens),
    latencyMsSum: BigInt(summary.latencyMsSum),
  });
}

/** 一组用量。 */
export function usageBucketMessage(bucket: { key: string; summary: UsageTotals }) {
  return create(UsageBucketSchema, {
    key: bucket.key,
    summary: usageSummaryMessage(bucket.summary),
  });
}

/**
 * 0–100 的整数百分比。
 *
 * proto 里这两个百分比字段是 int32：上游给的是算出来的小数（端砚报
 * 95.458552），不取整的话 JSON 里就带着小数，客户端解码时抛「expected
 * number (int32)」，整个面板整页报错（2026-10-28 真出过）。
 */
export function percentInt(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 整毫秒。
 *
 * proto 的时间戳是 int64：BigInt(浮点) 会直接抛 RangeError。
 */
export function wholeMs(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * 面板送来的可选一格：没给与给了空串是两件事。
 *
 * 契约里带 presence 的格没给时是 undefined，往下那一层拿 undefined 当「别动」、
 * 拿空串当「清空」。收成 String(value ?? "") 会把两件事糊成一件，只改一部分
 * 字段的调用方就把没送的格清掉了。
 */
export function givenText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : value;
}

/**
 * 面板送来的可选开关：没给与给了 false 是两件事。
 *
 * 契约里带 presence 的 bool 没给时是 undefined。只改别的字段的调用方不能把一个
 * 打开着的开关顺手关掉，所以这一格保持 undefined 往下传（那一层拿 undefined 当
 * 「别动」）。
 */
export function givenBool(value: boolean | undefined): boolean | undefined {
  return value === undefined ? undefined : value;
}
