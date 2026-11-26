// test/admin-config-check.ts — the settings the panel shows, and the three
// timeout knobs that used to be environment-only.
//
//   node --experimental-strip-types test/admin-config-check.ts
//
// Offline: one temporary data directory, no network, no upstream.
//
// What it covers:
//   1. the panel's list holds the twelve keys — the four timeouts, the
//      periodic timer, the health snapshot, check-in, Qoder's queue retry;
//   2. each of those twelve has a label and one sentence, and the sentence is
//      short enough to read in one line (the panel's own rule: 30 characters; the
//      tool-opening knob gets one more, it has to say what 0 means);
//   3. the three ROUTER_* defaults are the ones the router itself uses —
//      a number that drifted here would change the routing behaviour without
//      anything else noticing;
//   4. the environment wins: a deployment that pins ROUTER_FIRST_FRAME_MS keeps
//      the deployment's value, whatever the panel says;
//   5. the panel's value really reaches the router: a database override of the
//      idle limit is in force for the next stream — the point of reading the
//      setting per answer instead of once at module load;
//   6. only the settings that are read per request are hot, so the panel says
//      "pending restart" about exactly the ones that need it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "admin-config-"));
process.env.FACADE_DATA_DIR = tmp;
// This round checks the defaults, so none of the three may be pinned by
// This round checks the defaults, so none of the four may be pinned by
for (const key of ["ROUTER_FIRST_FRAME_MS", "ROUTER_STREAM_IDLE_MS", "ROUTER_TOOL_OPENING_MS", "ROUTER_RETRY_BUDGET_MS"]) {
  delete process.env[key];
}

const { configItems, setConfigValue } = await import("../lib/admin/config.ts");
const { configClear, configNumber, configOverride, configPendingRestart, configSnapshot, reloadConfig } = await import(
  "../lib/config.ts"
);
const { ConfigKind, ConfigUnit } = await import("../lib/gen/agentfacade/admin/v1/admin_pb.ts");
const {
  STREAM_FIRST_FRAME_DEFAULT_MS,
  STREAM_IDLE_DEFAULT_MS,
  StreamIdleError,
  withStreamIdle,
  CONTINUE_MAX_MAX,
  CONTINUE_MAX_MIN,
} = await import("../lib/router/deliver.ts");
const { ATTEMPT_BUDGET_DEFAULT_MS } = await import("../lib/router/upstreams/policy.ts");
const { STREAM_LIMIT_MAX_MS } = await import("../lib/router/stream-limits.ts");

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    problems.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log("");
  console.log(title);
}

/** One item on the panel, by key. */
const item = (key: string) => configItems().find((i) => i.key === key);

/* ------------------------------------------------------------------ *
 * 一、面板上有这八个
 * ------------------------------------------------------------------ */

section("面板上的十二个键");
const NEW_KEYS = [
  "ROUTER_FIRST_FRAME_MS",
  "ROUTER_STREAM_IDLE_MS",
  "ROUTER_TOOL_OPENING_MS",
  "ROUTER_RETRY_BUDGET_MS",
  "PERIODIC_ENABLED",
  "HEALTH_CACHE_MS",
  "BENEFITS_DISABLED",
  "BENEFITS_INTERVAL_MS",
  "QODER_LEGACY_RETRY_MS",
  "ROUTER_CONTINUE_ON_IDLE",
  "ROUTER_CONTINUE_MAX",
  "ROUTER_IDLE_ERROR_RETRYABLE",
];
const keys = configItems().map((i) => i.key);
for (const key of NEW_KEYS) {
  check(`面板上有 ${key}`, keys.includes(key), JSON.stringify(keys));
}

// 数字型的那几个要把值显示出来：一个空的控件等于告诉用户「现在是多少不知道」，
// 而实际生效的总是某个数（签到间隔是 3600000，其余为下面的默认值）。
for (const key of ["BENEFITS_INTERVAL_MS", "HEALTH_CACHE_MS", "QODER_LEGACY_RETRY_MS"]) {
  check(`${key} 面板上有值`, Number(item(key)?.value) > 0, JSON.stringify(item(key)?.value));
  check(`${key} 面板上有默认值`, Number(item(key)?.fallback) > 0, JSON.stringify(item(key)?.fallback));
}
check("签到间隔默认是一小时", Number(item("BENEFITS_INTERVAL_MS")?.value) === 3_600_000, JSON.stringify(item("BENEFITS_INTERVAL_MS")?.value));

// 一句说明一条控件：没有说明的那一项，面板上只剩一个键名，谁也不知道能改。
// 说明要在面板上一行放得下：这条对每一项都一样，没有例外。

for (const key of NEW_KEYS) {
  const row = item(key);
  check(`${key} 有名字`, Boolean(row?.label) && row!.label !== key, JSON.stringify(row?.label));
  check(`${key} 有说明`, Boolean(row?.description), JSON.stringify(row?.description));
  check(
    `${key} 的说明不超过 30 字`,
    (row?.description ?? "").length <= 30,
    `${row?.description?.length} 字：${row?.description}`,
  );
}

/* ------------------------------------------------------------------ *
 * 二、三个旋钮的默认值
 * ------------------------------------------------------------------ */

section("三个超时旋钮的默认值");

// 路由里那份是准的：面板这一份与它必须一样，不然「默认值」有两个说法。
const DEFAULTS: [string, number, number][] = [
  ["ROUTER_FIRST_FRAME_MS", 300_000, STREAM_FIRST_FRAME_DEFAULT_MS],
  ["ROUTER_STREAM_IDLE_MS", 180_000, STREAM_IDLE_DEFAULT_MS],
  ["ROUTER_RETRY_BUDGET_MS", 180_000, ATTEMPT_BUDGET_DEFAULT_MS],
];
for (const [key, want, inRouter] of DEFAULTS) {
  check(`${key} 的默认值是 ${want}`, configNumber(key, -1) === want, String(configNumber(key, -1)));
  check(`${key} 面板显示的默认值也是 ${want}`, item(key)?.fallback === String(want), String(item(key)?.fallback));
  check(`${key} 与路由里那份一致`, inRouter === want, `${key}: 路由 ${inRouter} vs 期望 ${want}`);
  check(`${key} 现在生效的就是默认值`, item(key)?.value === String(want), String(item(key)?.value));
}

/* ------------------------------------------------------------------ *
 * 三、环境变量优先
 * ------------------------------------------------------------------ */

section("环境变量优先");

// 部署钉住的东西，部署说了算：面板写的那份在库里等着，但生效的是环境变量。
process.env.ROUTER_FIRST_FRAME_MS = "1234";
reloadConfig();
check("设了 env 之后读到 env 的值", configNumber("ROUTER_FIRST_FRAME_MS", 300_000) === 1234, String(configNumber("ROUTER_FIRST_FRAME_MS", 300_000)));
check("面板显示的是 env 的值", item("ROUTER_FIRST_FRAME_MS")?.value === "1234", String(item("ROUTER_FIRST_FRAME_MS")?.value));
check(
  "面板说这个值来自环境变量",
  item("ROUTER_FIRST_FRAME_MS")?.source === "environment",
  String(item("ROUTER_FIRST_FRAME_MS")?.source),
);

// 撤了环境变量就回到默认值：库里没有覆盖，代码里那份说了算。
delete process.env.ROUTER_FIRST_FRAME_MS;
reloadConfig();
check("撤了 env 之后回到默认值", configNumber("ROUTER_FIRST_FRAME_MS", 300_000) === 300_000, String(configNumber("ROUTER_FIRST_FRAME_MS", -1)));
check("面板显示的也回到默认值", item("ROUTER_FIRST_FRAME_MS")?.value === "300000", String(item("ROUTER_FIRST_FRAME_MS")?.value));

/* ------------------------------------------------------------------ *
 * 四、面板改的那份到了路由手里
 * ------------------------------------------------------------------ */

section("面板改的值真的生效");

configOverride("ROUTER_STREAM_IDLE_MS", "60");
reloadConfig();
check("改完读到的就是新值", configNumber("ROUTER_STREAM_IDLE_MS", 180_000) === 60, String(configNumber("ROUTER_STREAM_IDLE_MS", -1)));

/**
 * 一条先说一句、然后永远沉默的流。
 *
 * 第一帧是真的帧（不是心跳），所以闸从「等第一帧」换到「中途那个窗口」——
 * 中途那个窗口正是面板改的那个数。
 */
const encoder = new TextEncoder();
let sent = false;
const body = new ReadableStream<Uint8Array>({
  pull(controller) {
    if (!sent) {
      sent = true;
      controller.enqueue(encoder.encode('data: {"a":1}\n\n'));
      return;
    }
    return new Promise<void>(() => {
      /* 上游从此不说话 */
    });
  },
});

// 闸自己的定时器是 unref 的：只挂着它，事件循环会空着退出，这个 await 就永远
// 没人叫醒。这个定时器只是把事件循环撑住。
const guard = setTimeout(() => {
  /* 撑住事件循环，收尾时清掉 */
}, 5_000);
let firstFrame = "";
let gateError: unknown = null;
try {
  const gated = withStreamIdle(body, "check");
  const chunks = gated.getReader();
  const first = await chunks.read();
  firstFrame = first.done ? "" : new TextDecoder().decode(first.value);
  await chunks.read();
} catch (e) {
  gateError = e;
}
clearTimeout(guard);

check("第一帧原样交出来了", firstFrame.includes('"a":1'), firstFrame);
check(
  "中途沉默按面板那个数判超时",
  gateError instanceof StreamIdleError && gateError.idleMs === 60,
  gateError instanceof StreamIdleError ? `idleMs=${gateError.idleMs}` : String(gateError),
);
check(
  "句子说清是中途沉默",
  gateError instanceof StreamIdleError && gateError.phase === "mid-stream",
  gateError instanceof StreamIdleError ? gateError.message : String(gateError),
);

configClear("ROUTER_STREAM_IDLE_MS");
reloadConfig();
check("清掉覆盖之后又回到默认值", configNumber("ROUTER_STREAM_IDLE_MS", 180_000) === 180_000, String(configNumber("ROUTER_STREAM_IDLE_MS", -1)));

/* ------------------------------------------------------------------ *
 * 五、热的与要重启的
 * ------------------------------------------------------------------ */

section("热的与要重启的");

// 热的是「每条请求各读一次」的那些：面板改完就是新的值，所以面板不该再说
// 「要重启」。其余的（读一次就定在常量里）面板必须说清楚要重启。
const HOT: [string, string][] = [
  ["ROUTER_FIRST_FRAME_MS", "1111"],
  ["ROUTER_STREAM_IDLE_MS", "2222"],
  ["ROUTER_TOOL_OPENING_MS", "4444"],
  ["ROUTER_RETRY_BUDGET_MS", "3333"],
  ["BENEFITS_DISABLED", "true"],
];
const NEEDS_RESTART: [string, string][] = [
  ["PERIODIC_ENABLED", "false"],
  ["HEALTH_CACHE_MS", "60000"],
  ["BENEFITS_INTERVAL_MS", "1800000"],
  ["QODER_LEGACY_RETRY_MS", "5000"],
];

check("一开始没有待重启的东西", configPendingRestart() === false);

for (const [key, value] of HOT) {
  configOverride(key, value);
  reloadConfig();
  check(`${key} 改了不算待重启（它是热的）`, configPendingRestart() === false, String(configPendingRestart()));
  check(`${key} 生效的是新值`, String(item(key)?.value) === value, String(item(key)?.value));
  configClear(key);
  reloadConfig();
  check(`${key} 清掉之后又没有待重启的东西`, configPendingRestart() === false);
}

for (const [key, value] of NEEDS_RESTART) {
  configOverride(key, value);
  reloadConfig();
  check(`${key} 改了算待重启（它读一次就定住）`, configPendingRestart() === true, String(configPendingRestart()));
  configClear(key);
  reloadConfig();
  check(`${key} 清掉之后又没有待重启的东西`, configPendingRestart() === false);
}

check("变得回去：首帧上限又是 300000", configNumber("ROUTER_FIRST_FRAME_MS", 300_000) === 300_000, String(configNumber("ROUTER_FIRST_FRAME_MS", -1)));
check("变得回去：快照间隔又是 300000", configNumber("HEALTH_CACHE_MS", 300_000) === 300_000, String(configNumber("HEALTH_CACHE_MS", -1)));

/* ------------------------------------------------------------------ *
 * 六、两个续写设置的默认值与范围夹取
 * ------------------------------------------------------------------ */

section("续写设置的默认值与范围夹取");

check("ROUTER_CONTINUE_ON_IDLE 默认是关", item("ROUTER_CONTINUE_ON_IDLE")?.value === "false", String(item("ROUTER_CONTINUE_ON_IDLE")?.value));
check("ROUTER_CONTINUE_ON_IDLE 默认值也是关", item("ROUTER_CONTINUE_ON_IDLE")?.fallback === "false", String(item("ROUTER_CONTINUE_ON_IDLE")?.fallback));
check("ROUTER_CONTINUE_MAX 默认是 2", configNumber("ROUTER_CONTINUE_MAX", -1) === 2, String(configNumber("ROUTER_CONTINUE_MAX", -1)));
check("ROUTER_CONTINUE_MAX 面板显示的默认值也是 2", item("ROUTER_CONTINUE_MAX")?.fallback === "2", String(item("ROUTER_CONTINUE_MAX")?.fallback));

section("静默超时报可重试的开关");

check("ROUTER_IDLE_ERROR_RETRYABLE 默认是关", item("ROUTER_IDLE_ERROR_RETRYABLE")?.value === "false", String(item("ROUTER_IDLE_ERROR_RETRYABLE")?.value));
check("ROUTER_IDLE_ERROR_RETRYABLE 默认值也是关", item("ROUTER_IDLE_ERROR_RETRYABLE")?.fallback === "false", String(item("ROUTER_IDLE_ERROR_RETRYABLE")?.fallback));
check("面板上有 ROUTER_IDLE_ERROR_RETRYABLE", keys.includes("ROUTER_IDLE_ERROR_RETRYABLE"), JSON.stringify(keys));

const retryableOn = setConfigValue("ROUTER_IDLE_ERROR_RETRYABLE", "true");
check("ROUTER_IDLE_ERROR_RETRYABLE 能打开", retryableOn.ok === true, retryableOn.message);
check("ROUTER_IDLE_ERROR_RETRYABLE 设成 true 后读到 true", item("ROUTER_IDLE_ERROR_RETRYABLE")?.value === "true", String(item("ROUTER_IDLE_ERROR_RETRYABLE")?.value));

configClear("ROUTER_IDLE_ERROR_RETRYABLE");
reloadConfig();
check("清掉之后回到默认值 false", item("ROUTER_IDLE_ERROR_RETRYABLE")?.value === "false", String(item("ROUTER_IDLE_ERROR_RETRYABLE")?.value));

// 0 到 5 是合法范围。越界写进去的值要夹回边界，并且说出来，不静默改数。
const clampMin = setConfigValue("ROUTER_CONTINUE_MAX", "-1");
check("越界下界夹回 0", clampMin.ok === true && configNumber("ROUTER_CONTINUE_MAX", -1) === 0, String(configNumber("ROUTER_CONTINUE_MAX", -1)));
check("下界夹取在返回里说出来", clampMin.message.includes("夹回"), clampMin.message);
check("面板显示的是夹后的 0", item("ROUTER_CONTINUE_MAX")?.value === "0", String(item("ROUTER_CONTINUE_MAX")?.value));

const clampMax = setConfigValue("ROUTER_CONTINUE_MAX", "99");
check("越界上界夹回 5", clampMax.ok === true && configNumber("ROUTER_CONTINUE_MAX", -1) === 5, String(configNumber("ROUTER_CONTINUE_MAX", -1)));
check("上界夹取在返回里说出来", clampMax.message.includes("夹回"), clampMax.message);
check("面板显示的是夹后的 5", item("ROUTER_CONTINUE_MAX")?.value === "5", String(item("ROUTER_CONTINUE_MAX")?.value));

// 范围内的值原样收下，不夹也不说。
const inRange = setConfigValue("ROUTER_CONTINUE_MAX", "3");
check("范围内的值原样收下", inRange.ok === true && configNumber("ROUTER_CONTINUE_MAX", -1) === 3, String(configNumber("ROUTER_CONTINUE_MAX", -1)));
check("范围内的值不说夹取", !inRange.message.includes("夹回"), inRange.message);

// 0 是合法值：就是不续写。
const zero = setConfigValue("ROUTER_CONTINUE_MAX", "0");
check("0 是合法值，就是不续写", zero.ok === true && configNumber("ROUTER_CONTINUE_MAX", -1) === 0, String(configNumber("ROUTER_CONTINUE_MAX", -1)));

configClear("ROUTER_CONTINUE_MAX");
reloadConfig();
check("清掉之后回到默认值 2", configNumber("ROUTER_CONTINUE_MAX", -1) === 2, String(configNumber("ROUTER_CONTINUE_MAX", -1)));

/* ------------------------------------------------------------------ *
 * 七、控件类型、单位、边界与文案
 * ------------------------------------------------------------------ */

section("控件类型、单位与边界");

const rows = configItems();
const MILLISECOND_KEYS = new Set([
  "ROUTER_FIRST_FRAME_MS",
  "ROUTER_STREAM_IDLE_MS",
  "ROUTER_TOOL_OPENING_MS",
  "ROUTER_RETRY_BUDGET_MS",
  "HEALTH_CACHE_MS",
  "BENEFITS_INTERVAL_MS",
  "QODER_LEGACY_RETRY_MS",
]);
const KIND_BY_TYPE: Record<string, number> = {
  string: ConfigKind.STRING,
  number: ConfigKind.NUMBER,
  boolean: ConfigKind.BOOLEAN,
};
const types = new Map(configSnapshot().map((setting) => [setting.key, setting.type]));

for (const row of rows) {
  const want = MILLISECOND_KEYS.has(row.key) ? ConfigUnit.MILLISECONDS : ConfigUnit.UNSPECIFIED;
  check(`${row.key} 的单位按声明给出`, row.unit === want, `声明 ${want}，实到 ${row.unit}`);
}
check("声明为毫秒的一共七个键", MILLISECOND_KEYS.size === 7, String(MILLISECOND_KEYS.size));

for (const row of rows) {
  const type = types.get(row.key);
  check(
    `${row.key} 的控件类型与 Setting.type 一致`,
    type !== undefined && row.kind === KIND_BY_TYPE[type],
    `type=${String(type)}，kind=${row.kind}`,
  );
}
const boolKeys = rows.filter((row) => types.get(row.key) === "boolean");
check("布尔键是 BOOLEAN 控件", boolKeys.length > 0 && boolKeys.every((row) => row.kind === ConfigKind.BOOLEAN), JSON.stringify(boolKeys.map((row) => [row.key, row.kind])));

const continueMax = rows.find((row) => row.key === "ROUTER_CONTINUE_MAX")!;
check(
  "ROUTER_CONTINUE_MAX 有下界且取自 deliver.ts",
  continueMax.hasMin === true && continueMax.minValue === BigInt(CONTINUE_MAX_MIN),
  `hasMin=${continueMax.hasMin}，min=${continueMax.minValue}`,
);
check(
  "ROUTER_CONTINUE_MAX 有上界且取自 deliver.ts",
  continueMax.hasMax === true && continueMax.maxValue === BigInt(CONTINUE_MAX_MAX),
  `hasMax=${continueMax.hasMax}，max=${continueMax.maxValue}`,
);

// The three stream gates are capped by the same constant the router clamps with:
// the panel must report that number, otherwise a value the panel accepts
// silently becomes a different one in force.
const STREAM_KEYS = ["ROUTER_FIRST_FRAME_MS", "ROUTER_STREAM_IDLE_MS", "ROUTER_TOOL_OPENING_MS"];
const BOUNDED_KEYS = new Set([...STREAM_KEYS, "ROUTER_CONTINUE_MAX"]);
for (const key of STREAM_KEYS) {
  const row = rows.find((r) => r.key === key)!;
  check(
    `${key} 有上界且取自 stream-limits.ts`,
    row.hasMax === true && row.maxValue === BigInt(STREAM_LIMIT_MAX_MS),
    `hasMax=${row.hasMax}，max=${row.maxValue}`,
  );
  check(`${key} 没有下界`, row.hasMin === false && row.minValue === 0n, `hasMin=${row.hasMin}，min=${row.minValue}`);
}

// The fourth knob: how long to wait for the tool arguments after the opening
// frame has arrived. Off by default (0), so the mid-stream window stays in
// charge — the panel must not claim a limit that is not in force.
const opening = rows.find((row) => row.key === "ROUTER_TOOL_OPENING_MS");
check("面板上有 ROUTER_TOOL_OPENING_MS", Boolean(opening), JSON.stringify(rows.map((row) => row.key)));
check("它的单位是毫秒（面板上按秒显示与填写）", opening?.unit === ConfigUnit.MILLISECONDS, String(opening?.unit));
check("它的控件是数字", opening?.kind === ConfigKind.NUMBER, String(opening?.kind));
check(
  "它的默认值是 0（不单独计时）",
  opening?.fallback === "0" && configNumber("ROUTER_TOOL_OPENING_MS", -1) === 0,
  `fallback=${opening?.fallback}，读到 ${configNumber("ROUTER_TOOL_OPENING_MS", -1)}`,
);
check(
  "它有上界且取自 stream-limits.ts",
  opening?.hasMax === true && opening?.maxValue === BigInt(STREAM_LIMIT_MAX_MS),
  `hasMax=${opening?.hasMax}，max=${opening?.maxValue}`,
);
check(
  "它没有下界（0 是合法值）",
  opening?.hasMin === false && opening?.minValue === 0n,
  `hasMin=${opening?.hasMin}，min=${opening?.minValue}`,
);
check(
  "面板报的流闸上限与夹取用的是同一个常量",
  STREAM_KEYS.every((key) => rows.find((r) => r.key === key)!.maxValue === BigInt(STREAM_LIMIT_MAX_MS)),
  String(STREAM_KEYS.map((key) => rows.find((r) => r.key === key)?.maxValue)),
);
for (const row of rows.filter((row) => !BOUNDED_KEYS.has(row.key))) {
  check(
    `${row.key} 没有上下界`,
    row.hasMin === false && row.hasMax === false && row.minValue === 0n && row.maxValue === 0n,
    `hasMin=${row.hasMin}，hasMax=${row.hasMax}`,
  );
}
check(
  "面板报的界与 deliver.ts 夹取用的界一致",
  continueMax.minValue === BigInt(CONTINUE_MAX_MIN) && continueMax.maxValue === BigInt(CONTINUE_MAX_MAX),
  `面板 ${continueMax.minValue}-${continueMax.maxValue}，路由 ${CONTINUE_MAX_MIN}-${CONTINUE_MAX_MAX}`,
);
check(
  "夹取提示语也用同一对界",
  clampMin.message.includes(String(CONTINUE_MAX_MIN)) && clampMax.message.includes(String(CONTINUE_MAX_MAX)),
  `${clampMin.message} / ${clampMax.message}`,
);

const COPY: [string, string, string][] = [
  ["ROUTER_FIRST_FRAME_MS", "等首字时限", "等首字最多多久（秒），上限 600"],
  ["ROUTER_STREAM_IDLE_MS", "多久算静默", "连续多久没有新内容就算静默（秒）"],
  ["ROUTER_TOOL_OPENING_MS", "工具开局最多等多久", "工具开头到了、参数还没来，最多等多久（秒）；0 表示不计时"],
  ["ROUTER_RETRY_BUDGET_MS", "重试总时限", "一次请求的重试总时限（秒）"],
  ["ROUTER_CONTINUE_ON_IDLE", "静默后自动续写", "判定为静默后替客户端把话说完"],
  ["ROUTER_CONTINUE_MAX", "最多续写几次", "一次答复最多续写几次，0 就不续"],
  ["ROUTER_IDLE_ERROR_RETRYABLE", "静默时报可重试", "与自动续写二选一：让客户端重发"],
  ["HEALTH_CACHE_MS", "快照刷新间隔", "额度与状态快照多久刷新（秒）"],
  ["BENEFITS_INTERVAL_MS", "签到间隔", "签到任务多久跑一次（秒）"],
  ["QODER_LEGACY_RETRY_MS", "排队重试间隔", "Qoder 旧协议排队后隔多久重试（秒）"],
];
for (const [key, label, description] of COPY) {
  const row = rows.find((item) => item.key === key);
  check(
    `${key} 的面板文案`,
    row?.label === label && row?.description === description,
    JSON.stringify({ label: row?.label, description: row?.description }),
  );
}
check(
  "「流空闲上限」这个名字不再出现",
  rows.every((row) => !row.label.includes("流空闲上限") && !row.description.includes("流空闲上限")),
  JSON.stringify(rows.filter((row) => row.label.includes("流空闲上限")).map((row) => row.key)),
);
check(
  "说明里不再出现「毫秒」",
  rows.every((row) => !row.description.includes("毫秒")),
  JSON.stringify(rows.filter((row) => row.description.includes("毫秒")).map((row) => row.key)),
);
const positions = COPY.map(([key]) => rows.findIndex((row) => row.key === key));
check(
  "静默那一组的注册顺序没打乱",
  positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!)),
  JSON.stringify(positions),
);

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

section("结果");
console.log(`pass=${pass} fail=${fail}`);
if (problems.length) {
  console.log("");
  for (const problem of problems) console.log(`  - ${problem}`);
}
process.exit(fail ? 1 : 0);
