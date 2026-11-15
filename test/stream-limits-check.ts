// test/stream-limits-check.ts — 两道闸与下层超时的关系，一次说清。
//
//   node --experimental-strip-types test/stream-limits-check.ts
//
// 离线：只 import 两个模块，不起服务、不连任何上游、不监听端口。
//
// 事故链（生产实录）：
//
//   [DELIVER] terminated
//   [ROUTE]  openai account=13 cannot serve it (timeout UND_ERR_BODY_TIMEOUT)
//   [REQ]    coder-a 312523ms
//
// 下层（undici 的 bodyTimeout，300s）比上层的闸门（生产把空闲设成 360s）先掐断，
// 于是客户端收到的是 Node 那句 `terminated`，闸门的配置与那句人话全都没用上。
//
// 这条测试盯住三件事：
//   1. 不变式：下层的 bodyTimeout **严格大于**闸门的上限（STREAM_LIMIT_MAX_MS）——
//      不变式写在 lib/fetch-dispatcher.ts 的 FETCH_BODY_TIMEOUT_MS（由上限推导，
//      不是另一个魔数），断言在这里；
//   2. 夹取：超过上限的夹到上限，0 与负数原样保留（那是「关闸」，不是夹取）；
//   3. 夹取判断：streamLimitWasCapped() 对上面每一个值都判对。

import {
  STREAM_FIRST_FRAME_DEFAULT_MS,
  STREAM_IDLE_DEFAULT_MS,
  STREAM_LIMIT_MAX_MS,
  clampStreamLimit,
  streamLimitWasCapped,
} from "../lib/router/stream-limits.ts";
import {
  FETCH_BODY_TIMEOUT_MS,
  fetchTimeoutOptions,
  fetchTimeoutsAreLooserThanStreamLimit,
} from "../lib/fetch-dispatcher.ts";

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

/* ------------------------------------------------------------------ *
 * 一、下层必须比上层的上限更松
 * ------------------------------------------------------------------ */

section("下层的 bodyTimeout 严格大于闸门上限");

check(
  "bodyTimeout 严格大于 STREAM_LIMIT_MAX_MS",
  fetchTimeoutOptions().bodyTimeout > STREAM_LIMIT_MAX_MS,
  `${fetchTimeoutOptions().bodyTimeout} vs ${STREAM_LIMIT_MAX_MS}`,
);
check(
  "推导出来的那一个数也严格大于上限",
  FETCH_BODY_TIMEOUT_MS > STREAM_LIMIT_MAX_MS,
  `${FETCH_BODY_TIMEOUT_MS} vs ${STREAM_LIMIT_MAX_MS}`,
);
check("不变式的问句答的是「是」", fetchTimeoutsAreLooserThanStreamLimit() === true);
check(
  "下层的 headersTimeout 与 bodyTimeout 一样松（头迟到的流也一样由闸门说话）",
  fetchTimeoutOptions().headersTimeout > STREAM_LIMIT_MAX_MS,
  String(fetchTimeoutOptions().headersTimeout),
);
check(
  "bodyTimeout 是由上限推导的，不是另一个魔数",
  FETCH_BODY_TIMEOUT_MS === Math.ceil(STREAM_LIMIT_MAX_MS * 1.5),
  `${FETCH_BODY_TIMEOUT_MS}`,
);

/* ------------------------------------------------------------------ *
 * 二、夹取
 * ------------------------------------------------------------------ */

section("夹取：超过上限的夹到上限，0 与负数原样保留");

const CLAMPS: [number, number][] = [
  [900_000, 600_000],
  [0, 0],
  [-1, -1],
  [180_000, 180_000],
];

for (const [input, want] of CLAMPS) {
  check(`clampStreamLimit(${input}) = ${want}`, clampStreamLimit(input) === want, String(clampStreamLimit(input)));
}

check(
  `夹取用到的上限就是 ${STREAM_LIMIT_MAX_MS}`,
  clampStreamLimit(STREAM_LIMIT_MAX_MS) === STREAM_LIMIT_MAX_MS,
  String(clampStreamLimit(STREAM_LIMIT_MAX_MS)),
);
check(
  "上限之上一点点也要夹",
  clampStreamLimit(STREAM_LIMIT_MAX_MS + 1) === STREAM_LIMIT_MAX_MS,
  String(clampStreamLimit(STREAM_LIMIT_MAX_MS + 1)),
);
check(
  "默认值都在上限之内（默认值不该被夹）",
  STREAM_FIRST_FRAME_DEFAULT_MS <= STREAM_LIMIT_MAX_MS && STREAM_IDLE_DEFAULT_MS <= STREAM_LIMIT_MAX_MS,
  `${STREAM_FIRST_FRAME_DEFAULT_MS} / ${STREAM_IDLE_DEFAULT_MS}`,
);

/* ------------------------------------------------------------------ *
 * 三、夹取判断
 * ------------------------------------------------------------------ */

section("streamLimitWasCapped() 的判断");

const CAPPED: [number, boolean][] = [
  [900_000, true],
  [0, false],
  [-1, false],
  [180_000, false],
];

for (const [input, want] of CAPPED) {
  check(`streamLimitWasCapped(${input}) = ${want}`, streamLimitWasCapped(input) === want, String(streamLimitWasCapped(input)));
}

check("上限本身不算被夹", streamLimitWasCapped(STREAM_LIMIT_MAX_MS) === false);
check("上限之上算被夹", streamLimitWasCapped(STREAM_LIMIT_MAX_MS + 1) === true);

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

console.log("");
console.log(`  ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
