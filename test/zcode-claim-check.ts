// test/zcode-claim-check.ts — ZCode 的活动免费额度：看有没有可领的，有就领。
//
//   node --experimental-strip-types test/zcode-claim-check.ts
//
// 离线：上游是本地起的一个假 HTTP 服务，一个真请求都不发出去。
//
// 这一族断言的是**几件必须分开的事**：
//
//   preview 有计划 → 领一个（只领一个），body 是 {"plan_id":…}
//   preview 空     → 一个领取请求都不发（「今天没有可领的」不是失败）
//   preview 401    → unauthorized，不领
//   领到了         → claimed，快照里有计划名与生效时刻
//   1001–1005      → already（终态：这组码客户端不重试；不猜哪一条是「已领过」，
//                    服务端的中文原话原样传上去）
//   3007 / 验证码  → captcha（网关过不了验证码，人得自己去过）
//   claim 401      → unauthorized
//   claim 5xx/超时 → failed（不是终态：下一轮还会再试）
//   开关关掉       → 一个请求都不发
//
// 最后一节是反证：把「空 preview 当失败」「终态当可重试」这两处旧行为装回去，
// 断言必须红。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { HealthSnapshot } from "../lib/provider-kinds.ts";
import type { ProviderRow } from "../lib/providers.ts";

// 会话层在模块求值时读配置，所以数据目录与假上游的地址要设好才能 import
// （与 test/zcode-quota-check.ts 同一套做法）。
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-claim-"));
process.env.FACADE_DATA_DIR = DATA_DIR;

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

/** preview 这一轮怎么答。 */
type PreviewMode = "plans" | "plan-beta" | "empty" | "unauthorized" | "server-error";
/** claim 这一轮怎么答。 */
type ClaimMode =
  | "ok"
  | "terminal"
  | "terminal-captcha"
  | "captcha"
  | "captcha-text"
  | "unauthorized"
  | "server-error"
  | "hang";

let previewMode: PreviewMode = "plans";
let claimMode: ClaimMode = "ok";

/** 收到过几个请求（按路径分）。 */
let previewHits = 0;
let claimHits = 0;
/** 最近一次领取请求的样子。 */
let lastClaimBody = "";
let lastClaimHeaders: Record<string, string> = {};
let lastPreviewUrl = "";
let lastPreviewHeaders: Record<string, string> = {};

const PLANS = [
  {
    plan_id: "plan-alpha",
    name: "ALPHA PLAN",
    description: "第一个",
    priority: 10,
    entitlements: [
      {
        entitlement_id: "ent-alpha",
        show_name: "GLM-5.3",
        meter: "model_usage",
        unit_type: "token",
        capabilities: ["model:glm-5.3"],
        grant_units: 1000,
        period: "one_time",
        priority: 1,
        effective_at: 1800000000,
      },
    ],
  },
  {
    plan_id: "plan-beta",
    name: "BETA PLAN",
    description: "第二个",
    priority: 1,
    entitlements: [],
  },
];

const fake = http.createServer((req, res) => {
  const url = req.url ?? "";
  const send = (code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (): string => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      lastClaimBody = raw;
      lastClaimHeaders = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v ?? "")]),
      );
      respond();
    });
  };
  const respond = (): void => {
    switch (claimMode) {
      case "unauthorized":
        return send(401, { code: 401, msg: "unauthorized" });
      case "server-error":
        return send(500, { code: 500, msg: "internal error" });
      case "terminal":
        // 终态那一组（1001–1005）里的一条：服务端说不能再领了。
        return send(200, { code: 1001, msg: "", data: { message: "今日领取名额已用完" } });
      case "terminal-captcha":
        // 终态码 + 验证码文案：上游换了码，文案兜底要能盖过终态组。
        return send(200, { code: 1003, msg: "", data: { message: "验证码校验失败，请重试" } });
      case "captcha":
        return send(200, { code: 3007, msg: "", data: { message: "验证码校验失败" } });
      case "captcha-text":
        // 码不是 3007，但文案说的是验证码那一件事。
        return send(200, { code: 4001, msg: "", data: { message: "验证码校验失败，请重试" } });
      case "hang":
        return; // 什么都不回：等的是超时
      default:
        return send(200, {
          code: 0,
          msg: "",
          data: {
            plan: {
              user_plan_id: "upl-alpha",
              plan_id: "plan-alpha",
              status: "active",
              starts_at: 1799999000,
              ends_at: 1800086400,
              entitlements: PLANS[0].entitlements,
            },
          },
        });
    }
  };
  if (url.startsWith("/api/v1/zcode-plan/billing/preview")) {
    previewHits++;
    lastPreviewUrl = url;
    lastPreviewHeaders = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v ?? "")]),
    );
    switch (previewMode) {
      case "unauthorized":
        return send(401, { code: 401, msg: "unauthorized" });
      case "server-error":
        return send(500, { code: 500, msg: "internal error" });
      case "plan-beta":
        // 只列另一个计划（另一个 plan_id）：用来验「已经领过的那个不重复领，
        // 换一个新活动照领」。
        return send(200, {
          code: 0,
          msg: "",
          data: { server_time: 1800000000, plans: [PLANS[1]] },
        });
      case "empty":
        // 实测的「没有可领」：HTTP 200、code 0、**没有 data 字段**。
        return send(200, { code: 0, msg: "", logid: "log-test" });
      default:
        return send(200, {
          code: 0,
          msg: "",
          data: { server_time: 1800000000, plans: PLANS },
        });
    }
  }
  if (url.startsWith("/api/v1/zcode-plan/billing/claim")) {
    claimHits++;
    return readBody();
  }
  if (url.startsWith("/api/v1/zcode-plan/billing/balance")) {
    // 额度那一问：领到之后这里要能看到那个计划。
    return send(200, {
      code: 0,
      msg: "",
      data: {
        server_time: 1800000000,
        balances: [],
        plans: [
          {
            user_plan_id: "upl-alpha",
            plan_id: "plan-alpha",
            name: "ALPHA PLAN",
            status: "active",
            starts_at: 1799999000,
            ends_at: 1800086400,
            entitlements: PLANS[0].entitlements,
          },
        ],
      },
    });
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: 404, msg: "not found" }));
});

await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakePort = (fake.address() as { port: number }).port;

process.env.ZCODE_BASE_URL = `http://127.0.0.1:${fakePort}`;
// 超时那一段要能测：20 秒的等待不适合放进测试里。
process.env.ZCODE_QUOTA_TIMEOUT_MS = "400";
process.env.ZCODE_CLAIM_TIMEOUT_MS = "400";

await import("../lib/kinds/zcode.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const { previewClaims, claimPlan } = await import("../lib/zcode/claim.ts");
const { claimOnce, runZcodeAutoClaim, zcodeClaimSnapshot } = await import("../lib/zcode/auto-claim.ts");
const { fetchZcodeQuota } = await import("../lib/zcode/credits.ts");
const { ZCODE_CLIENT_PLATFORM } = await import("../lib/zcode/transport.ts");
const { putHealthSnapshot, peekHealthSnapshot } = await import("../lib/health-cache.ts");
const { setSecret } = await import("../lib/store.ts");
const { providerSecretId } = await import("../lib/credential-ids.ts");
const { addAccount, listProviders } = await import("../lib/providers.ts");

let pass = 0;
let fail = 0;
const problems: string[] = [];

function check(name: string, ok: unknown, detail = ""): void {
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

/** 每一节之前把计数与模式归零。 */
function reset(preview: PreviewMode = "plans", claim: ClaimMode = "ok"): void {
  previewMode = preview;
  claimMode = claim;
  previewHits = 0;
  claimHits = 0;
  lastClaimBody = "";
  lastClaimHeaders = {};
  lastPreviewUrl = "";
  lastPreviewHeaders = {};
  // 领取的状态也复位（结论与「已经领过哪些计划」都在快照里）：否则上一节
  // 领过的计划会让这一节不再 POST，下面的断言就测不到东西了。
  resetClaimState();
}

/**
 * 复位领取的状态。
 *
 * 领取的结论与「已经领过哪些计划」都存在现役的那份健康快照里
 * （zcode[账号].claim），所以复位就是换一份没有结论的快照 —— lib/ 里没有
 * 「只给测试用」的开关。
 */
function resetClaimState(): void {
  putHealthSnapshot({ zcode: {} } as unknown as HealthSnapshot);
}

/* ------------------------------------------------------------------ *
 * 账号
 * ------------------------------------------------------------------ */

const account = addAccount({ platform: "zcode", alias: "领取测试" });
if (!account.ok || !account.id) {
  console.log(`  FAIL 造不出 zcode 账号：${account.message}`);
  process.exit(1);
}
const ACCOUNT_ID = account.id;

setSecret(providerSecretId(ACCOUNT_ID), "session", {
  token: "zcode-test-token",
  accessToken: "zcode-test-token",
  userId: "u-1",
  provider: "zai",
  deviceId: "device-1234",
  generation: 1,
  loginAtMs: Date.now() - 60_000,
  expiresAtMs: 0,
});

const kind = kindOf("zcode");
if (!kind) {
  console.log("  FAIL 注册表里没有 zcode —— lib/kinds/zcode.ts 没有登记");
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 一、preview：看有没有可领的
 * ------------------------------------------------------------------ */

section("一、preview：看有没有可领的");

reset("plans");
const preview = await previewClaims(ACCOUNT_ID);
check("preview 有计划 → ok", preview?.state === "ok", JSON.stringify(preview));
check(
  "preview 的计划读出来了",
  (preview?.state === "ok" ? preview.value.plans.length : 0) === 2,
  JSON.stringify(preview),
);
check(
  "preview 的计划名与优先级",
  preview?.state === "ok" &&
    preview.value.plans[0]?.planId === "plan-alpha" &&
    preview.value.plans[0]?.priority === 10,
  JSON.stringify(preview?.state === "ok" ? preview.value.plans[0] : null),
);
check(
  "preview 的 query 带着版本与平台",
  /app_version=3\.18\.2/.test(lastPreviewUrl) &&
    lastPreviewUrl.includes(`platform=${encodeURIComponent(ZCODE_CLIENT_PLATFORM)}`),
  lastPreviewUrl,
);
check("preview 发了恰好一个请求", previewHits === 1, String(previewHits));

reset("empty");
const empty = await previewClaims(ACCOUNT_ID);
check("preview 空（200 + code 0 + 没有 data）→ ok", empty?.state === "ok", JSON.stringify(empty));
check(
  "preview 空 → 计划是空数组（是「没有」，不是「失败」）",
  empty?.state === "ok" && empty.value.plans.length === 0,
  JSON.stringify(empty),
);

reset("unauthorized");
const previewUnauthorized = await previewClaims(ACCOUNT_ID);
check(
  "preview 401 → unauthorized",
  previewUnauthorized?.state === "unauthorized",
  JSON.stringify(previewUnauthorized),
);

reset("server-error");
const previewFailed = await previewClaims(ACCOUNT_ID);
check("preview 500 → failed", previewFailed?.state === "failed", JSON.stringify(previewFailed));

/* ------------------------------------------------------------------ *
 * 二、领：一次只领一个
 * ------------------------------------------------------------------ */

section("二、领：一次只领一个");

reset("plans");
const claimed = await claimOnce(ACCOUNT_ID);
check("领到了 → claimed", claimed?.state === "claimed", JSON.stringify(claimed));
check("领取请求恰好发了一个", claimHits === 1, String(claimHits));
check(
  "body 是 {\"plan_id\":…}",
  lastClaimBody === JSON.stringify({ plan_id: "plan-alpha" }),
  lastClaimBody,
);
check(
  "头里有 X-ZCode-App-Version",
  typeof lastClaimHeaders["x-zcode-app-version"] === "string" &&
    lastClaimHeaders["x-zcode-app-version"].length > 0,
  JSON.stringify(lastClaimHeaders["x-zcode-app-version"]),
);
check(
  "头里有 X-Platform",
  lastClaimHeaders["x-platform"] === ZCODE_CLIENT_PLATFORM,
  JSON.stringify(lastClaimHeaders["x-platform"]),
);
check(
  "头里有 Authorization（zcodePlatformHeaders 带来的，不是自己叠的）",
  typeof lastClaimHeaders["authorization"] === "string" &&
    lastClaimHeaders["authorization"].length > 0,
  JSON.stringify(lastClaimHeaders["authorization"]),
);
check(
  "领到的计划名与生效时刻记下来了",
  claimed?.state === "claimed" &&
    claimed.planName === "ALPHA PLAN" &&
    typeof claimed.effectiveAt === "string" &&
    claimed.effectiveAt.length > 0,
  JSON.stringify(claimed),
);

/* ------------------------------------------------------------------ *
 * 三、没有可领的时候不领
 * ------------------------------------------------------------------ */

section("三、没有可领的时候不领");

reset("empty");
const none = await claimOnce(ACCOUNT_ID);
check("preview 空 → 结论是 none", none?.state === "none", JSON.stringify(none));
check("preview 空 → 一个领取请求都不发", claimHits === 0, String(claimHits));

reset("unauthorized");
const unauthorized = await claimOnce(ACCOUNT_ID);
check(
  "preview 401 → 结论是 unauthorized",
  unauthorized?.state === "unauthorized",
  JSON.stringify(unauthorized),
);
check("preview 401 → 一个领取请求都不发", claimHits === 0, String(claimHits));

/* ------------------------------------------------------------------ *
 * 四、终态与验证码
 * ------------------------------------------------------------------ */

section("四、终态与验证码");

reset("plans", "terminal");
const already = await claimOnce(ACCOUNT_ID);
check("1001–1005 → already", already?.state === "already", JSON.stringify(already));
check(
  "already 带着服务端的中文原话",
  already?.state === "already" && already.message.includes("名额"),
  JSON.stringify(already),
);
check("already → 只发了一个领取请求（不重试）", claimHits === 1, String(claimHits));

reset("plans", "captcha");
const captcha = await claimOnce(ACCOUNT_ID);
check("3007 → captcha", captcha?.state === "captcha", JSON.stringify(captcha));
check("captcha → 只发了一个领取请求（不重试）", claimHits === 1, String(claimHits));

reset("plans", "captcha-text");
const captchaText = await claimOnce(ACCOUNT_ID);
check(
  "文案含「验证码校验失败」→ captcha（码不是 3007 也算）",
  captchaText?.state === "captcha",
  JSON.stringify(captchaText),
);

reset("plans", "terminal-captcha");
const terminalCaptcha = await claimOnce(ACCOUNT_ID);
check(
  "终态码 + 验证码文案 → captcha（不是 already）",
  terminalCaptcha?.state === "captcha",
  JSON.stringify(terminalCaptcha),
);
check(
  "终态码 + 验证码文案 → 原话带上来",
  terminalCaptcha?.state === "captcha" && terminalCaptcha.message.includes("验证码"),
  JSON.stringify(terminalCaptcha),
);

reset("plans", "unauthorized");
const claimUnauthorized = await claimOnce(ACCOUNT_ID);
check(
  "claim 401 → unauthorized",
  claimUnauthorized?.state === "unauthorized",
  JSON.stringify(claimUnauthorized),
);

reset("plans", "server-error");
const claimFailed = await claimOnce(ACCOUNT_ID);
check("claim 500 → failed", claimFailed?.state === "failed", JSON.stringify(claimFailed));

reset("plans", "hang");
const claimHung = await claimOnce(ACCOUNT_ID);
check("claim 超时 → failed", claimHung?.state === "failed", JSON.stringify(claimHung));

/* ------------------------------------------------------------------ *
 * 五、failed 不是终态：下一轮还会再试
 * ------------------------------------------------------------------ */

section("五、failed 不是终态：下一轮还会再试");

reset("plans", "server-error");
await claimOnce(ACCOUNT_ID);
const firstRound = claimHits;
await claimOnce(ACCOUNT_ID);
check(
  "failed 之后下一轮还会再试（不记「已放弃」）",
  firstRound === 1 && claimHits === 2,
  `${firstRound} → ${claimHits}`,
);

/* ------------------------------------------------------------------ *
 * 六、开关
 * ------------------------------------------------------------------ */

section("六、开关：关掉就一个请求都不发");

reset("plans");
process.env.FACADE_ZCODE_AUTO_CLAIM = "false";
await runZcodeAutoClaim();
check("开关关着 → 一个请求都不发", previewHits === 0 && claimHits === 0, `${previewHits}/${claimHits}`);

reset("plans");
delete process.env.FACADE_ZCODE_AUTO_CLAIM;
await runZcodeAutoClaim();
check(
  "开关开着（默认）→ preview 与 claim 各发一个",
  previewHits === 1 && claimHits === 1,
  `${previewHits}/${claimHits}`,
);
check(
  "自动领取只跑名下的 zcode 账号",
  listProviders().filter((r) => r.kind === "zcode").length === 1,
  JSON.stringify(listProviders().map((r) => ({ id: r.id, kind: r.kind }))),
);

// 定时器那一步：领取是它自己的一步（claim），不是签到（benefits）。
reset("plans");
const { runPeriodicOnce } = await import("../lib/periodic.ts");
await runPeriodicOnce();
check(
  "定时器跑一轮就领了（claim 步进接上了）",
  previewHits >= 1 && claimHits >= 1,
  `${previewHits}/${claimHits}`,
);

/* ------------------------------------------------------------------ *
 * 七、结论进快照，面板看得见
 * ------------------------------------------------------------------ */

section("七、结论进快照，面板看得见");

reset("plans");
// 复位领取的结论：结论存在现役的那份健康快照里（zcode[账号].claim），
// 所以复位就是换一份没有结论的快照 —— lib/ 里没有「只给测试用」的开关。
putHealthSnapshot({ zcode: {} } as unknown as HealthSnapshot);
// 先摆一份快照：领取的结论要当场写进去，不能等下一次全量刷新。
putHealthSnapshot({
  zcode: {
    [ACCOUNT_ID]: {
      quota: {
        state: "ok",
        value: { buckets: [], plans: [], serverTime: new Date(1800000000 * 1000).toISOString() },
        at: Date.now(),
      },
    },
  },
} as unknown as HealthSnapshot);
await claimOnce(ACCOUNT_ID);
const liveClaim = (peekHealthSnapshot<HealthSnapshot>()?.data?.zcode?.[ACCOUNT_ID] as any)?.claim;
check(
  "领取的结论当场写进了现役的快照",
  liveClaim?.state === "claimed" && liveClaim?.planName === "ALPHA PLAN",
  JSON.stringify(liveClaim),
);

const snapshot = {
  zcode: {
    [ACCOUNT_ID]: {
      quota: {
        state: "ok",
        value: { buckets: [], plans: [], serverTime: new Date(1800000000 * 1000).toISOString() },
        at: Date.now(),
      },
      claim: zcodeClaimSnapshot(ACCOUNT_ID),
    },
  },
} as unknown as HealthSnapshot;
putHealthSnapshot(snapshot);
const note = kind.quotas(
  { id: ACCOUNT_ID, platform: "zcode", kind: "zcode" } as unknown as ProviderRow,
  snapshot,
)[0]?.credits?.note ?? "";
check("额度卡的 note 里带着领取的结论", /领取：已领到/.test(note), JSON.stringify(note));
check(
  "note 里有计划名",
  note.includes("ALPHA PLAN"),
  JSON.stringify(note),
);

// 终态也要看得见：面板要能说出「今天为什么没领到」。
reset("plans", "terminal");
await claimOnce(ACCOUNT_ID);
const terminalSnapshot = {
  zcode: {
    [ACCOUNT_ID]: {
      quota: {
        state: "ok",
        value: { buckets: [], plans: [], serverTime: new Date(1800000000 * 1000).toISOString() },
        at: Date.now(),
      },
      claim: zcodeClaimSnapshot(ACCOUNT_ID),
    },
  },
} as unknown as HealthSnapshot;
putHealthSnapshot(terminalSnapshot);
const terminalNote =
  kind.quotas(
    { id: ACCOUNT_ID, platform: "zcode", kind: "zcode" } as unknown as ProviderRow,
    terminalSnapshot,
  )[0]?.credits?.note ?? "";
check(
  "终态的 note 说着「已领过」并带上原话",
  /领取：已领过/.test(terminalNote) && terminalNote.includes("名额"),
  JSON.stringify(terminalNote),
);

// 「此刻没有可领的」不能被写成「名额已用完」：preview 没给 data，分不出来是
// 名额用完了、已经领过，还是活动还没开始 —— 不能编一个结论。
reset("empty");
await claimOnce(ACCOUNT_ID);
const noneSnapshot = {
  zcode: {
    [ACCOUNT_ID]: {
      quota: {
        state: "ok",
        value: { buckets: [], plans: [], serverTime: new Date(1800000000 * 1000).toISOString() },
        at: Date.now(),
      },
      claim: zcodeClaimSnapshot(ACCOUNT_ID),
    },
  },
} as unknown as HealthSnapshot;
putHealthSnapshot(noneSnapshot);
const noneNote =
  kind.quotas(
    { id: ACCOUNT_ID, platform: "zcode", kind: "zcode" } as unknown as ProviderRow,
    noneSnapshot,
  )[0]?.credits?.note ?? "";
check(
  "note 说的是「此刻没有可领的」",
  /领取：此刻没有可领的/.test(noneNote),
  JSON.stringify(noneNote),
);
check(
  "note 没有把「此刻」说成「名额已用完」",
  !noneNote.includes("名额已用完"),
  JSON.stringify(noneNote),
);

// 结论只有一份，就在现役的快照里：换了快照就没有旧结论（进程里不再另存一份）。
putHealthSnapshot({ zcode: {} } as unknown as HealthSnapshot);
check(
  "换了快照 → 结论也跟着换（没有另一份内存里的旧结论）",
  zcodeClaimSnapshot(ACCOUNT_ID) === undefined,
  JSON.stringify(zcodeClaimSnapshot(ACCOUNT_ID)),
);

/* ------------------------------------------------------------------ *
 * 八、领到之后额度那一问能看到那个计划
 * ------------------------------------------------------------------ */

section("八、领到之后额度那一问能看到那个计划");

reset("plans");
await claimOnce(ACCOUNT_ID);
const quota = await fetchZcodeQuota(ACCOUNT_ID);
check("额度问到了", quota?.state === "ok", JSON.stringify(quota));
check(
  "额度里的 plans 反映了领到的计划",
  quota?.state === "ok" && quota.value.plans.length === 1 && quota.value.plans[0]?.planId === "plan-alpha",
  JSON.stringify(quota?.state === "ok" ? quota.value.plans : null),
);

putHealthSnapshot({ zcode: {} } as unknown as HealthSnapshot);

/* ------------------------------------------------------------------ *
 * 九、每次尝试都有一行日志
 * ------------------------------------------------------------------ */

section("九、每次尝试都有一行日志");

/**
 * 收一轮里打出去的行（log 与 warn 分开：失败那一行得是 warn）。
 *
 * 不真的连上游，只是把 console 换掉。
 */
async function captureLogs(
  fn: () => Promise<unknown>,
): Promise<{ log: string[]; warn: string[] }> {
  const log: string[] = [];
  const warn: string[] = [];
  const realLog = console.log;
  const realWarn = console.warn;
  console.log = (...args: unknown[]) => {
    log.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    warn.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = realLog;
    console.warn = realWarn;
  }
  return { log, warn };
}

/** 一轮里的 [ZCODE] 那几行。 */
function claimLines(lines: string[]): string[] {
  return lines.filter((l) => l.includes("[ZCODE] claim"));
}

reset("plans");
const claimedLogs = await captureLogs(() => claimOnce(ACCOUNT_ID));
const claimedLine = claimLines(claimedLogs.log)[0] ?? "";
check(
  "领到了：日志里有账号、状态与领到的计划",
  claimedLine.includes(`account=${ACCOUNT_ID}`) &&
    claimedLine.includes("state=claimed") &&
    claimedLine.includes("ALPHA PLAN"),
  claimedLine,
);
check(
  "领到了：日志里带着生效时刻",
  /effective=\d{4}-\d{2}-\d{2}T/.test(claimedLine),
  claimedLine,
);
check(
  "领到了：日志里带着 preview 的结论",
  /preview=2\b/.test(claimedLine),
  claimedLine,
);
check(
  "领到了：日志里 plan_id 是截断的",
  claimedLine.includes("plan-alp") && !claimedLine.includes("plan-alpha("),
  claimedLine,
);
check("领到了：只有一行", claimLines(claimedLogs.log).length === 1, claimedLine);

reset("plans", "terminal");
const terminalLogs = await captureLogs(() => claimOnce(ACCOUNT_ID));
const terminalLine = claimLines(terminalLogs.log)[0] ?? "";
check(
  "终态：日志里带着上游原话",
  terminalLine.includes("state=already") && terminalLine.includes("今日领取名额已用完"),
  terminalLine,
);

reset("empty");
const noneLogs = await captureLogs(() => claimOnce(ACCOUNT_ID));
const noneLine = claimLines(noneLogs.log)[0] ?? "";
check(
  "没有可领：日志里写着「没有可领」",
  noneLine.includes("没有可领") && noneLine.includes("state=none"),
  noneLine,
);

reset("plans", "server-error");
const failedLogs = await captureLogs(() => claimOnce(ACCOUNT_ID));
const failedLine = claimLines(failedLogs.warn)[0] ?? "";
check(
  "失败：日志走的是 warn（要能一眼看见）",
  failedLine.includes("state=failed") && failedLine.includes(`account=${ACCOUNT_ID}`),
  failedLine,
);
check("失败：没有混进普通 log 里", claimLines(failedLogs.log).length === 0, failedLine);

/* ------------------------------------------------------------------ *
 * 十、platform 只有一份：query 与 X-Platform 头必须是同一个值
 * ------------------------------------------------------------------ */

section("十、platform 只有一份：query 与 X-Platform 头必须是同一个值");

reset("plans");
await previewClaims(ACCOUNT_ID);
const queryPlatform = new URL(lastPreviewUrl, "http://127.0.0.1").searchParams.get("platform");
check(
  "preview 的 query platform 与 X-Platform 头是同一个值",
  queryPlatform === ZCODE_CLIENT_PLATFORM &&
    lastPreviewHeaders["x-platform"] === ZCODE_CLIENT_PLATFORM,
  `${queryPlatform} / ${lastPreviewHeaders["x-platform"]}`,
);

const claimSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "lib", "zcode", "claim.ts"),
  "utf8",
);
const claimCode = claimSource
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");
check(
  "claim.ts 里没有自己写死的平台标识（只有 transport 那一份）",
  !claimCode.includes("win32-x64"),
  claimCode.match(/win32-x64/g)?.join(",") ?? "",
);
const transportSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "lib", "zcode", "transport.ts"),
  "utf8",
);
check(
  "transport.ts 里平台标识只写了一次",
  (transportSource.match(/win32-x64/g) ?? []).length === 1,
  String((transportSource.match(/win32-x64/g) ?? []).length),
);

/* ------------------------------------------------------------------ *
 * 十一、同一个计划不重复 POST
 * ------------------------------------------------------------------ */

section("十一、同一个计划不重复 POST");

reset("plans");
const firstClaim = await claimOnce(ACCOUNT_ID);
check("第一轮领到了", firstClaim?.state === "claimed", JSON.stringify(firstClaim));
check("第一轮发了一个领取请求", claimHits === 1, String(claimHits));

// 第二轮：preview 还是列着刚领过的那个计划（上游滞后）。不能再 POST。
const hitsAfterFirst = claimHits;
const secondRound = await claimOnce(ACCOUNT_ID);
check(
  "同一个计划再来一轮 → 不再 POST",
  claimHits === hitsAfterFirst,
  `${hitsAfterFirst} → ${claimHits}`,
);
check(
  "第二轮的结论还是「已领到」（不是「已领过」）",
  secondRound?.state === "claimed",
  JSON.stringify(secondRound),
);

// 换一个计划（新的 plan_id）：新活动不能被这个保护挡住。
// 这里不复位领取的状态（要留着「已经领过 plan-alpha」那份记忆）。
previewMode = "plan-beta";
claimHits = 0;
const thirdRound = await claimOnce(ACCOUNT_ID);
check("换一个计划 → 照发 POST", claimHits === 1, String(claimHits));
check(
  "换一个计划 → 领到的是那个计划",
  thirdRound?.state === "claimed" && thirdRound.planName === "BETA PLAN",
  JSON.stringify(thirdRound),
);

const { closeStore } = await import("../lib/store.ts");
closeStore();
fake.close();
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
if (fail > 0) process.exitCode = 1;
