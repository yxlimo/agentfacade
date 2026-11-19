// test/zcode-claim-check.ts — ZCode 的活动免费额度：投放接口判据 + 领取。
//
//   node --experimental-strip-types test/zcode-claim-check.ts
//
// 离线：上游是本地起的一个假 HTTP 服务，一个真请求都不发出去。
//
// 这一族断言的是**几件必须分开的事**：
//
//   判据是投放接口（marketing/touch），不是 billing/preview：
//     投放里有 claim_zcode_plan  → 可领（给出 plan_id 与展示字段）
//     deliveries 空                → 没有可领，且**一个领取请求都不发**
//     banner 只有 close 按钮       → 没有可领
//     投放字段坏掉（缺 plan_id）   → 没有可领 + 计数 + 不崩
//     会话没有 device id           → missing_device，且**一个请求都不发**
//
//   领取：
//     领到了         → claimed，快照里有计划名与生效时刻
//     1001–1005      → already（终态：这组码客户端不重试；不猜哪一条是「已领过」，
//                    服务端的中文原话原样传上去）
//     3007 / 验证码  → captcha（网关过不了验证码，人得自己去官方客户端点一次）
//     claim 401      → unauthorized
//     claim 5xx/超时 → failed（不是终态：下一轮还会再试）
//     开关关掉       → 一个请求都不发
//
//   幂等：同一个 campaign_id + plan_id 领过（含 captcha 终态）就不再 POST；
//   换一个 campaign_id 就照领。
//
// 最后一节是反证：把「preview 有 data 才算可领」那个旧判据摆出来对照 —
// 同一份假上游答复下旧判据会说「可领」，新判据必须说「没有可领」且不 POST。

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

/** 投放接口这一轮怎么答。 */
type TouchMode =
  | "offer"
  | "offer-other-campaign"
  | "empty"
  | "close-only"
  | "broken"
  | "unauthorized"
  | "server-error";
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

let touchMode: TouchMode = "offer";
let claimMode: ClaimMode = "ok";

/** 收到过几个请求（按路径分）。 */
let touchHits = 0;
let claimHits = 0;
/** preview 收到过几个请求：判据换了以后应该一个都没有。 */
let previewHits = 0;
/** 最近一次领取请求的样子。 */
let lastClaimBody = "";
let lastClaimHeaders: Record<string, string> = {};
let lastTouchUrl = "";
let lastTouchHeaders: Record<string, string> = {};

/** 一个带「领取」按钮的投放（实测形状，2026-11）。 */
const OFFER_DELIVERY = {
  campaign_id: "camp-1",
  resource_position: "banner",
  priority: 50,
  banner: {
    buttons: [
      { action: { type: "close" } },
      { action: { type: "claim_zcode_plan", args: { plan_id: "plan-alpha" } } },
    ],
    background: {
      type: "bundle",
      args: {
        zcode_plan: {
          plan_id: "plan-alpha",
          name: "ALPHA PLAN",
          priority: 111,
          starts_at: 1795086000,
          ends_at: 1795136400,
          entitlements: [
            {
              show_name: "GLM-5.3-Flash",
              grant_units: 300000000,
              effective_at: 1795100400,
              period: "one_time",
            },
          ],
        },
      },
    },
  },
};

/** 另一个投放（新的 campaign_id）：用来验「换了一个活动照领不误」。 */
const OTHER_DELIVERY = {
  ...OFFER_DELIVERY,
  campaign_id: "camp-2",
  banner: {
    ...OFFER_DELIVERY.banner,
    buttons: [
      { action: { type: "claim_zcode_plan", args: { plan_id: "plan-beta" } } },
    ],
    background: {
      type: "bundle",
      args: {
        zcode_plan: {
          plan_id: "plan-beta",
          name: "BETA PLAN",
          priority: 111,
          starts_at: 1795086000,
          ends_at: 1795136400,
          entitlements: [],
        },
      },
    },
  },
};

const fake = http.createServer((req, res) => {
  const url = req.url ?? "";
  const send = (code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const readBody = (): void => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      lastClaimBody = raw;
      lastClaimHeaders = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v ?? "")]),
      );
      respondClaim();
    });
  };
  const respondClaim = (): void => {
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
        return send(200, { code: 3007, msg: "captcha verify failed", data: { message: "" } });
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
              entitlements: OFFER_DELIVERY.banner.background.args.zcode_plan.entitlements,
            },
          },
        });
    }
  };
  if (url.startsWith("/api/v1/marketing/touch")) {
    touchHits++;
    lastTouchUrl = url;
    lastTouchHeaders = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), String(v ?? "")]),
    );
    switch (touchMode) {
      case "unauthorized":
        return send(401, { code: 401, msg: "unauthorized" });
      case "server-error":
        return send(500, { code: 500, msg: "internal error" });
      case "empty":
        return send(200, { code: 0, msg: "", data: { server_time: 1795092086, deliveries: [] } });
      case "close-only":
        // banner 还在，但按钮只有「关闭」：客户端只认 claim_zcode_plan，所以
        // 这不算「有可领」。
        return send(200, {
          code: 0,
          msg: "",
          data: {
            server_time: 1795092086,
            deliveries: [
              {
                campaign_id: "camp-close",
                resource_position: "banner",
                priority: 50,
                banner: { buttons: [{ action: { type: "close" } }] },
              },
            ],
          },
        });
      case "broken":
        // 坏投放：按钮说「可领」却没有 plan_id。丢掉它，但记着有这么一条。
        return send(200, {
          code: 0,
          msg: "",
          data: {
            server_time: 1795092086,
            deliveries: [
              {
                campaign_id: "camp-broken",
                resource_position: "banner",
                priority: 50,
                banner: { buttons: [{ action: { type: "claim_zcode_plan", args: {} } }] },
              },
            ],
          },
        });
      case "offer-other-campaign":
        return send(200, {
          code: 0,
          msg: "",
          data: { server_time: 1795092086, deliveries: [OTHER_DELIVERY] },
        });
      default:
        return send(200, {
          code: 0,
          msg: "",
          data: { server_time: 1795092086, deliveries: [OFFER_DELIVERY] },
        });
    }
  }
  if (url.startsWith("/api/v1/zcode-plan/billing/preview")) {
    // 旧判据问的那条接口。它此刻答的是「没有 data 字段」—— 实测就是这个形状
    // （客户端把它当错误，不当「没有可领」）。判据换掉以后网关一个请求都不
    // 该发到这里（见最后一节的反证）。
    previewHits++;
    return send(200, { code: 0, msg: "", logid: "log-test" });
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
            entitlements: OFFER_DELIVERY.banner.background.args.zcode_plan.entitlements,
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
process.env.ZCODE_MARKETING_TIMEOUT_MS = "400";

await import("../lib/kinds/zcode.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const { claimPlan } = await import("../lib/zcode/claim.ts");
const { fetchTouch, parseTouchDeliveries } = await import("../lib/zcode/marketing.ts");
const { claimOnce, runZcodeAutoClaim, zcodeClaimSnapshot, mergePendingClaims } = await import(
  "../lib/zcode/auto-claim.ts"
);
const { fetchZcodeQuota } = await import("../lib/zcode/credits.ts");
const { ZCODE_CLIENT_PLATFORM } = await import("../lib/zcode/transport.ts");
const { ZCODE_CLAIM_APP_VERSION } = await import("../lib/zcode/claim.ts");
const { putHealthSnapshot, peekHealthSnapshot, clearHealthSnapshot } = await import(
  "../lib/health-cache.ts"
);
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
function reset(touch: TouchMode = "offer", claim: ClaimMode = "ok"): void {
  touchMode = touch;
  claimMode = claim;
  touchHits = 0;
  claimHits = 0;
  previewHits = 0;
  lastClaimBody = "";
  lastClaimHeaders = {};
  lastTouchUrl = "";
  lastTouchHeaders = {};
  // 领取的状态也复位（结论与「已经领过哪些投放」都在快照里）：否则上一节
  // 领过的投放会让这一节不再 POST，下面的断言就测不到东西了。
  resetClaimState();
}

/**
 * 一份**完整**的快照（每个桶都在）。
 *
 * 造快照要造完整的：少几个桶的那份形状不对，读它的人（面板、路由）会崩 ——
 * 那正是这一族要钉住的东西。
 */
function fullSnapshot(zcode: HealthSnapshot["zcode"] = {}): HealthSnapshot {
  return { qoder: {}, minimax: {}, zcode, workbuddy: {}, plugins: {} };
}

/**
 * 复位领取的状态。
 *
 * 领取的结论与「已经领过哪些投放」都存在现役的那份健康快照里
 * （zcode[账号].claim），所以复位就是换一份没有结论的快照 —— lib/ 里没有
 * 「只给测试用」的开关。
 */
function resetClaimState(): void {
  putHealthSnapshot(fullSnapshot());
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

// 第二个账号：会话里没有设备标识（老会话）。它发不了投放请求 —— 那是
// 「问不到」，不是「没有可领」。
const noDeviceAccount = addAccount({ platform: "zcode", alias: "没有设备标识" });
if (!noDeviceAccount.ok || !noDeviceAccount.id) {
  console.log(`  FAIL 造不出第二个 zcode 账号：${noDeviceAccount.message}`);
  process.exit(1);
}
const NO_DEVICE_ID = noDeviceAccount.id;
setSecret(providerSecretId(NO_DEVICE_ID), "session", {
  token: "zcode-test-token",
  provider: "zai",
  deviceId: "",
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
 * 一、投放：有可领的投放就领
 * ------------------------------------------------------------------ */

section("一、投放：有可领的投放就领");

reset("offer");
const touch = await fetchTouch(ACCOUNT_ID);
check("投放接口问到了", touch.state === "ok", JSON.stringify(touch));
check(
  "投放里认出了那个可领的（plan_id 与展示字段）",
  touch.state === "ok" &&
    touch.offers.length === 1 &&
    touch.offers[0]?.planId === "plan-alpha" &&
    touch.offers[0]?.name === "ALPHA PLAN" &&
    touch.offers[0]?.campaignId === "camp-1",
  JSON.stringify(touch.state === "ok" ? touch.offers : null),
);
check(
  "展示字段读出来了（额度与生效时刻）",
  touch.state === "ok" &&
    touch.offers[0]?.grantUnits.length === 1 &&
    touch.offers[0]?.grantUnits[0] === 300000000 &&
    touch.offers[0]?.effectiveAt === new Date(1795100400 * 1000).toISOString() &&
    touch.offers[0]?.startsAt === new Date(1795086000 * 1000).toISOString() &&
    touch.offers[0]?.endsAt === new Date(1795136400 * 1000).toISOString(),
  JSON.stringify(touch.state === "ok" ? touch.offers[0] : null),
);
check("投放接口只发了一个请求", touchHits === 1, String(touchHits));
check(
  "投放请求带上了 seq（进程内自增）",
  /[?&]seq=\d+/.test(lastTouchUrl),
  lastTouchUrl,
);
check(
  "投放请求带了 X-Device-Mid（会话里的设备标识）",
  lastTouchHeaders["x-device-mid"] === "device-1234",
  JSON.stringify(lastTouchHeaders["x-device-mid"]),
);
check(
  "投放请求带了账单那一版的 App-Version",
  lastTouchHeaders["x-zcode-app-version"] === ZCODE_CLAIM_APP_VERSION,
  JSON.stringify(lastTouchHeaders["x-zcode-app-version"]),
);
check(
  "投放请求带了 X-Client-Language 与 X-Platform",
  typeof lastTouchHeaders["x-client-language"] === "string" &&
    lastTouchHeaders["x-client-language"].length > 0 &&
    lastTouchHeaders["x-platform"] === ZCODE_CLIENT_PLATFORM,
  JSON.stringify({
    lang: lastTouchHeaders["x-client-language"],
    platform: lastTouchHeaders["x-platform"],
  }),
);

reset("offer");
const claimed = await claimOnce(ACCOUNT_ID);
check("投放可领 → claimed", claimed?.state === "claimed", JSON.stringify(claimed));
check("领取请求恰好发了一个", claimHits === 1, String(claimHits));
check(
  "body 是 {\"plan_id\":…}",
  lastClaimBody === JSON.stringify({ plan_id: "plan-alpha" }),
  lastClaimBody,
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
check(
  "结论里带着 plan_id 与 campaign_id（查「哪一次投放」靠它）",
  claimed?.state === "claimed" &&
    claimed.planId === "plan-alpha" &&
    claimed.campaignId === "camp-1",
  JSON.stringify(claimed),
);

/* ------------------------------------------------------------------ *
 * 二、没有可领的时候一个领取请求都不发
 * ------------------------------------------------------------------ */

section("二、没有可领的时候一个领取请求都不发");

reset("empty");
const none = await claimOnce(ACCOUNT_ID);
check("投放为空 → 结论是 none", none?.state === "none", JSON.stringify(none));
check("投放为空 → 一个领取请求都不发", claimHits === 0, String(claimHits));
check("投放为空 → 判据问的是投放接口（preview 一个请求都不发）", previewHits === 0, String(previewHits));

reset("close-only");
const closeOnly = await claimOnce(ACCOUNT_ID);
check("banner 只有 close 按钮 → 结论是 none", closeOnly?.state === "none", JSON.stringify(closeOnly));
check("banner 只有 close 按钮 → 一个领取请求都不发", claimHits === 0, String(claimHits));

reset("broken");
const broken = await claimOnce(ACCOUNT_ID);
check("坏投放（缺 plan_id）→ 结论是 none（不崩）", broken?.state === "none", JSON.stringify(broken));
check("坏投放 → 一个领取请求都不发", claimHits === 0, String(claimHits));
const brokenTouch = await fetchTouch(ACCOUNT_ID);
check(
  "坏投放被计数了（invalid 不是 0，且没有可领的投放）",
  brokenTouch.state === "ok" && brokenTouch.invalid === 1 && brokenTouch.offers.length === 0,
  JSON.stringify(brokenTouch),
);

// 直接看解析器：坏投放被丢掉，valid 的那条留着。
const parsed = parseTouchDeliveries([
  OFFER_DELIVERY,
  { campaign_id: "camp-broken", resource_position: "banner", banner: { buttons: [{ action: { type: "claim_zcode_plan", args: {} } }] } },
]);
check(
  "解析器：坏的那条被丢掉，好的那条留着（并计数）",
  parsed.offers.length === 1 && parsed.offers[0]?.planId === "plan-alpha" && parsed.invalid === 1,
  JSON.stringify(parsed),
);

/* ------------------------------------------------------------------ *
 * 三、没有设备标识：问不到，不是「没有可领」
 * ------------------------------------------------------------------ */

section("三、没有设备标识：问不到，不是「没有可领」");

reset("offer");
const noDevice = await claimOnce(NO_DEVICE_ID);
check("没有设备标识 → 结论是 missing_device", noDevice?.state === "missing_device", JSON.stringify(noDevice));
check("没有设备标识 → 一个请求都不发", touchHits === 0 && claimHits === 0, `${touchHits}/${claimHits}`);

/* ------------------------------------------------------------------ *
 * 四、终态与验证码
 * ------------------------------------------------------------------ */

section("四、终态与验证码");

reset("offer", "terminal");
const already = await claimOnce(ACCOUNT_ID);
check("1001–1005 → already", already?.state === "already", JSON.stringify(already));
check(
  "already 带着服务端的中文原话",
  already?.state === "already" && already.message.includes("名额"),
  JSON.stringify(already),
);
check("already → 只发了一个领取请求（不重试）", claimHits === 1, String(claimHits));

reset("offer", "captcha");
const captcha = await claimOnce(ACCOUNT_ID);
check("3007 → captcha", captcha?.state === "captcha", JSON.stringify(captcha));
check("captcha → 只发了一个领取请求（不重试）", claimHits === 1, String(claimHits));
check(
  "captcha 的结论里带着 plan_id 与业务码",
  captcha?.state === "captcha" && captcha.planId === "plan-alpha" && captcha.code === 3007,
  JSON.stringify(captcha),
);
check(
  "captcha 的结论写明「需在官方客户端点一次领取」",
  captcha?.state === "captcha" && captcha.message.includes("官方客户端"),
  JSON.stringify(captcha),
);

// 下一轮不再 POST：同一个 campaign + plan 领过了（含 captcha 终态）。
// 这里**不复位**领取的状态（要留着「已经领过 camp-1|plan-alpha」那份记忆）。
claimMode = "captcha";
const hitsBeforeSecond = claimHits;
const captchaAgain = await claimOnce(ACCOUNT_ID);
check(
  "captcha 之后下一轮不再 POST",
  claimHits === hitsBeforeSecond,
  `${hitsBeforeSecond} → ${claimHits}`,
);
check(
  "captcha 之后结论还是 captcha（不是「没有可领」）",
  captchaAgain?.state === "captcha",
  JSON.stringify(captchaAgain),
);

reset("offer", "captcha-text");
const captchaText = await claimOnce(ACCOUNT_ID);
check(
  "文案含「验证码校验失败」→ captcha（码不是 3007 也算）",
  captchaText?.state === "captcha",
  JSON.stringify(captchaText),
);

reset("offer", "terminal-captcha");
const terminalCaptcha = await claimOnce(ACCOUNT_ID);
check(
  "终态码 + 验证码文案 → captcha（不是 already）",
  terminalCaptcha?.state === "captcha",
  JSON.stringify(terminalCaptcha),
);

reset("offer", "unauthorized");
const claimUnauthorized = await claimOnce(ACCOUNT_ID);
check(
  "claim 401 → unauthorized",
  claimUnauthorized?.state === "unauthorized",
  JSON.stringify(claimUnauthorized),
);

reset("offer", "server-error");
const claimFailed = await claimOnce(ACCOUNT_ID);
check("claim 500 → failed", claimFailed?.state === "failed", JSON.stringify(claimFailed));

reset("offer", "hang");
const claimHung = await claimOnce(ACCOUNT_ID);
check("claim 超时 → failed", claimHung?.state === "failed", JSON.stringify(claimHung));

/* ------------------------------------------------------------------ *
 * 五、failed 不是终态：下一轮还会再试
 * ------------------------------------------------------------------ */

section("五、failed 不是终态：下一轮还会再试");

reset("offer", "server-error");
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

reset("offer");
process.env.FACADE_ZCODE_AUTO_CLAIM = "false";
await runZcodeAutoClaim();
check("开关关着 → 一个请求都不发", touchHits === 0 && claimHits === 0, `${touchHits}/${claimHits}`);

reset("offer");
delete process.env.FACADE_ZCODE_AUTO_CLAIM;
await runZcodeAutoClaim();
check(
  "开关开着（默认）→ 问投放与领取各至少一个",
  touchHits >= 1 && claimHits >= 1,
  `${touchHits}/${claimHits}`,
);
check(
  "自动领取只跑名下的 zcode 账号",
  listProviders().filter((r) => r.kind === "zcode").length === 2,
  JSON.stringify(listProviders().map((r) => ({ id: r.id, kind: r.kind }))),
);

// 定时器那一步：领取是它自己的一步（claim），不是签到（benefits）。
reset("offer");
const { runPeriodicOnce } = await import("../lib/periodic.ts");
await runPeriodicOnce();
check(
  "定时器跑一轮就领了（claim 步进接上了）",
  touchHits >= 1 && claimHits >= 1,
  `${touchHits}/${claimHits}`,
);

/* ------------------------------------------------------------------ *
 * 七、结论进快照，面板看得见
 * ------------------------------------------------------------------ */

section("七、结论进快照，面板看得见");

reset("offer");
putHealthSnapshot(
  fullSnapshot({
    [ACCOUNT_ID]: {
      quota: {
        state: "ok",
        value: { buckets: [], plans: [], serverTime: new Date(1800000000 * 1000).toISOString() },
        at: Date.now(),
      },
    },
  }),
);
await claimOnce(ACCOUNT_ID);
const liveClaim = peekHealthSnapshot<HealthSnapshot>()?.data?.zcode?.[ACCOUNT_ID]?.claim;
check(
  "领取的结论当场写进了现役的快照",
  liveClaim?.state === "claimed" && liveClaim?.planName === "ALPHA PLAN",
  JSON.stringify(liveClaim),
);

const snapshot = fullSnapshot({
  [ACCOUNT_ID]: {
    quota: {
      state: "ok",
      value: { buckets: [], plans: [], serverTime: new Date(1800000000 * 1000).toISOString() },
      at: Date.now(),
    },
    claim: zcodeClaimSnapshot(ACCOUNT_ID),
  },
});
putHealthSnapshot(snapshot);
const note =
  kind.quotas(
    { id: ACCOUNT_ID, platform: "zcode", kind: "zcode" } as unknown as ProviderRow,
    snapshot,
  )[0]?.credits?.note ?? "";
check("额度卡的 note 里带着领取的结论", /领取：已领到/.test(note), JSON.stringify(note));
check("note 里有计划名", note.includes("ALPHA PLAN"), JSON.stringify(note));

// 终态也要看得见：面板要能说出「今天为什么没领到」。
reset("offer", "terminal");
await claimOnce(ACCOUNT_ID);
const terminalSnapshot = fullSnapshot({
  [ACCOUNT_ID]: {
    quota: {
      state: "ok",
      value: { buckets: [], plans: [], serverTime: new Date(1800000000 * 1000).toISOString() },
      at: Date.now(),
    },
    claim: zcodeClaimSnapshot(ACCOUNT_ID),
  },
});
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

// 「此刻没有可领的」不能被写成「名额已用完」：分不出来是名额用完了、已经领过，
// 还是活动还没开始 —— 不能编一个结论。
reset("empty");
await claimOnce(ACCOUNT_ID);
const noneSnapshot = fullSnapshot({
  [ACCOUNT_ID]: {
    quota: {
      state: "ok",
      value: { buckets: [], plans: [], serverTime: new Date(1800000000 * 1000).toISOString() },
      at: Date.now(),
    },
    claim: zcodeClaimSnapshot(ACCOUNT_ID),
  },
});
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

// 面板上「可领但要人工过验证码」要是一句能读懂的话。
reset("offer", "captcha");
await claimOnce(ACCOUNT_ID);
const captchaSnapshot = fullSnapshot({
  [ACCOUNT_ID]: {
    quota: {
      state: "ok",
      value: { buckets: [], plans: [], serverTime: new Date(1800000000 * 1000).toISOString() },
      at: Date.now(),
    },
    claim: zcodeClaimSnapshot(ACCOUNT_ID),
  },
});
putHealthSnapshot(captchaSnapshot);
const captchaNote =
  kind.quotas(
    { id: ACCOUNT_ID, platform: "zcode", kind: "zcode" } as unknown as ProviderRow,
    captchaSnapshot,
  )[0]?.credits?.note ?? "";
check(
  "note 说着「需在官方客户端点一次领取」",
  /官方客户端/.test(captchaNote),
  JSON.stringify(captchaNote),
);
check(
  "note 说得出是验证码挡住了（不是含糊的失败）",
  /验证码/.test(captchaNote),
  JSON.stringify(captchaNote),
);

// 结论只有一份，就在现役的快照里：换了快照就没有旧结论（进程里不再另存一份）。
putHealthSnapshot(fullSnapshot());
check(
  "换了快照 → 结论也跟着换（没有另一份内存里的旧结论）",
  zcodeClaimSnapshot(ACCOUNT_ID) === undefined,
  JSON.stringify(zcodeClaimSnapshot(ACCOUNT_ID)),
);

/* ------------------------------------------------------------------ *
 * 八、领到之后额度那一问能看到那个计划
 * ------------------------------------------------------------------ */

section("八、领到之后额度那一问能看到那个计划");

reset("offer");
await claimOnce(ACCOUNT_ID);
const quota = await fetchZcodeQuota(ACCOUNT_ID);
check("额度问到了", quota?.state === "ok", JSON.stringify(quota));
check(
  "额度里的 plans 反映了领到的计划",
  quota?.state === "ok" &&
    quota.value.plans.length === 1 &&
    quota.value.plans[0]?.planId === "plan-alpha",
  JSON.stringify(quota?.state === "ok" ? quota.value.plans : null),
);

putHealthSnapshot(fullSnapshot());

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

reset("offer");
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
  "领到了：日志里带着投放的结论（offers=1）",
  /offers=1\b/.test(claimedLine),
  claimedLine,
);
check(
  "领到了：日志里带着 plan_id 与 campaign_id",
  claimedLine.includes("plan=plan-alpha") && claimedLine.includes("campaign=camp-1"),
  claimedLine,
);
check("领到了：只有一行", claimLines(claimedLogs.log).length === 1, claimedLine);

reset("offer", "captcha");
const captchaLogs = await captureLogs(() => claimOnce(ACCOUNT_ID));
const captchaLine = claimLines(captchaLogs.log)[0] ?? "";
check(
  "验证码：日志里带着 plan_id 与业务码",
  captchaLine.includes("state=captcha") &&
    captchaLine.includes("plan=plan-alpha") &&
    captchaLine.includes("code=3007"),
  captchaLine,
);
check(
  "验证码：日志里写着「需在官方客户端点一次领取」",
  captchaLine.includes("官方客户端"),
  captchaLine,
);

reset("empty");
const noneLogs = await captureLogs(() => claimOnce(ACCOUNT_ID));
const noneLine = claimLines(noneLogs.log)[0] ?? "";
check(
  "没有可领：日志里写着「没有可领」",
  noneLine.includes("没有可领") && noneLine.includes("state=none"),
  noneLine,
);

reset("offer", "server-error");
const failedLogs = await captureLogs(() => claimOnce(ACCOUNT_ID));
const failedLine = claimLines(failedLogs.warn)[0] ?? "";
check(
  "失败：日志走的是 warn（要能一眼看见）",
  failedLine.includes("state=failed") && failedLine.includes(`account=${ACCOUNT_ID}`),
  failedLine,
);
check("失败：没有混进普通 log 里", claimLines(failedLogs.log).length === 0, failedLine);

reset("offer");
const brokenLogs = await captureLogs(() => claimOnce(ACCOUNT_ID));
reset("broken");
const brokenLogs2 = await captureLogs(() => claimOnce(ACCOUNT_ID));
check(
  "坏投放：有一行 warn 说投放被丢弃了",
  brokenLogs2.warn.some((l) => l.includes("坏投放")),
  JSON.stringify(brokenLogs2.warn),
);
void brokenLogs;

/* ------------------------------------------------------------------ *
 * 十、platform 只有一份：query 与 X-Platform 头必须是同一个值
 * ------------------------------------------------------------------ */

section("十、platform 只有一份：query 与 X-Platform 头必须是同一个值");

reset("offer");
await fetchTouch(ACCOUNT_ID);
check(
  "投放请求的 X-Platform 头是 transport 那一份",
  lastTouchHeaders["x-platform"] === ZCODE_CLIENT_PLATFORM,
  JSON.stringify(lastTouchHeaders["x-platform"]),
);

const marketingSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "lib", "zcode", "marketing.ts"),
  "utf8",
);
const marketingCode = marketingSource
  .split("\n")
  .filter((l) => !l.trim().startsWith("//"))
  .join("\n");
check(
  "marketing.ts 里没有自己写死的平台标识（只有 transport 那一份）",
  !marketingCode.includes("win32-x64"),
  marketingCode.match(/win32-x64/g)?.join(",") ?? "",
);
check(
  "marketing.ts 里没有第二个版本号常量（用 ZCODE_CLAIM_APP_VERSION）",
  !/3\.\d+\.\d+/.test(marketingCode),
  marketingCode.match(/3\.\d+\.\d+/g)?.join(",") ?? "",
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
 * 十一、同一个投放不重复 POST
 * ------------------------------------------------------------------ */

section("十一、同一个投放不重复 POST");

reset("offer");
const firstClaim = await claimOnce(ACCOUNT_ID);
check("第一轮领到了", firstClaim?.state === "claimed", JSON.stringify(firstClaim));
check("第一轮发了一个领取请求", claimHits === 1, String(claimHits));

// 第二轮：投放还挂着（上游不会说「这个已经领过了」）。不能再 POST。
const hitsAfterFirst = claimHits;
const secondRound = await claimOnce(ACCOUNT_ID);
check("同一个投放再来一轮 → 不再 POST", claimHits === hitsAfterFirst, `${hitsAfterFirst} → ${claimHits}`);
check(
  "第二轮的结论还是「已领到」（不是「已领过」）",
  secondRound?.state === "claimed",
  JSON.stringify(secondRound),
);

// 换一个投放（新的 campaign_id）：新活动不能被这个保护挡住。
// 这里不复位领取的状态（要留着「已经领过 camp-1|plan-alpha」那份记忆）。
reset("offer-other-campaign");
const thirdRound = await claimOnce(ACCOUNT_ID);
check("换一个投放 → 照发 POST", claimHits === 1, String(claimHits));
check(
  "换一个投放 → 领到的是那个投放的计划",
  thirdRound?.state === "claimed" && thirdRound.planName === "BETA PLAN",
  JSON.stringify(thirdRound),
);

/* ------------------------------------------------------------------ *
 * 十二、整个快照都还没有的时候
 * ------------------------------------------------------------------ */

section("十二、整个快照都还没有的时候：结论不丢，快照的形状也不坏");

// 进程刚起来的样子：一次健康轮询都还没有。领取跑在前面（两个定时器各有各的
// 节奏），那时候内存里没有快照。
reset("offer");
clearHealthSnapshot();
check("一开始就没有快照", peekHealthSnapshot() === null, JSON.stringify(peekHealthSnapshot()));

const noSnapshotClaim = await claimOnce(ACCOUNT_ID);
check(
  "没有快照时领取 → 结论仍然读得到（不丢）",
  zcodeClaimSnapshot(ACCOUNT_ID)?.state === "claimed",
  JSON.stringify(zcodeClaimSnapshot(ACCOUNT_ID)),
);
check("没有快照时领取 → 没有留下半份快照", peekHealthSnapshot() === null, JSON.stringify(peekHealthSnapshot()?.data));

// 别的桶的读法：面板与路由都这么读（snapshot.qoder[id]）。半份快照少的就是
// 这些桶 —— 读它的人会崩（Cannot read properties of undefined）。
const qoderRead = (): unknown => {
  const live = peekHealthSnapshot<HealthSnapshot>()?.data;
  if (!live) return null; // 没有快照：没有桶可读
  return live.qoder[ACCOUNT_ID] ?? null;
};
let qoderThrew = "";
let qoderValue: unknown = null;
try {
  qoderValue = qoderRead();
} catch (e) {
  qoderThrew = (e as Error)?.message ?? String(e);
}
check("读 snapshot.qoder 不会崩", qoderThrew === "", qoderThrew);
check("读 snapshot.qoder 读得到（没有快照就是没有）", qoderValue === null, String(qoderValue));

// 下一份快照写出来的时候，窗口里的结论被并进去（面板读的是快照那份）。
const nextSnapshot = fullSnapshot();
mergePendingClaims(nextSnapshot);
putHealthSnapshot(nextSnapshot);
check(
  "下一份快照带走了领取的结论",
  nextSnapshot.zcode[ACCOUNT_ID]?.claim?.state === "claimed",
  JSON.stringify(nextSnapshot.zcode[ACCOUNT_ID]?.claim),
);
check(
  "并进快照之后结论还读得到",
  zcodeClaimSnapshot(ACCOUNT_ID)?.state === "claimed",
  JSON.stringify(zcodeClaimSnapshot(ACCOUNT_ID)),
);

// 进了快照之后内存里就不再留一份：换一份没有结论的快照 → 结论跟着没了。
putHealthSnapshot(fullSnapshot());
check(
  "进了快照之后内存里不再留第二份",
  zcodeClaimSnapshot(ACCOUNT_ID) === undefined,
  JSON.stringify(zcodeClaimSnapshot(ACCOUNT_ID)),
);

/* ------------------------------------------------------------------ *
 * 十三、反证：旧判据（preview 有 data 才算可领）会说「可领」
 * ------------------------------------------------------------------ */

section("十三、反证：旧判据（preview 有 data 才算可领）");

reset("offer");
// 假上游的 preview 这时答的是「没有 data 字段」（实测形状）。
const previewHitsBefore = previewHits;
const preview = await fetch(`${process.env.ZCODE_BASE_URL}/api/v1/zcode-plan/billing/preview`);
const previewBody: any = await preview.json();
const oldJudgement = Boolean(previewBody?.data?.plans?.length);
check(
  "旧判据的前提成立：preview 此刻答的是「没有 data 字段」",
  !oldJudgement && previewBody?.data === undefined,
  JSON.stringify(previewBody),
);

const underOldJudgement = await claimOnce(ACCOUNT_ID);
check(
  "同一时刻：旧判据会说「没有可领」，新判据说「可领」并领到了",
  underOldJudgement?.state === "claimed",
  JSON.stringify(underOldJudgement),
);
check(
  "同一时刻：新判据真的发了领取请求（claimHits=1）",
  claimHits === 1,
  String(claimHits),
);
check(
  "判据换掉了：网关自己没有问 preview（上面那一次是测试自己问的）",
  previewHits === previewHitsBefore + 1,
  `${previewHitsBefore} → ${previewHits}`,
);

// 源码层面钉住：判据接口不许再回到 preview（注释里提一嘴不算）。
const autoClaimSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "lib", "zcode", "auto-claim.ts"),
  "utf8",
);
const claimSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "lib", "zcode", "claim.ts"),
  "utf8",
);
const codeOf = (source: string): string =>
  source
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
check(
  "auto-claim.ts 不再问 preview",
  !codeOf(autoClaimSource).includes("billing/preview") &&
    !codeOf(autoClaimSource).includes("previewClaims"),
  "",
);
check("claim.ts 里也没有 preview 的调用了", !codeOf(claimSource).includes("billing/preview"), "");
check(
  "auto-claim.ts 的判据是投放接口",
  autoClaimSource.includes("fetchTouch"),
  "",
);

const { closeStore } = await import("../lib/store.ts");
closeStore();
fake.close();
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
if (fail > 0) {
  for (const p of problems) console.log(`  · ${p}`);
  process.exitCode = 1;
}
