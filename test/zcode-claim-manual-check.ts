// test/zcode-claim-manual-check.ts — 面板点一次「领取」的那条路（后端那一半）。
//
//   node --experimental-strip-types test/zcode-claim-manual-check.ts
//
// 离线：上游是本地起的一个假 HTTP 服务，一个真请求都不发出去（账号 14 那边
// 一律不碰）。
//
// 这一族钉住的是几件必须分开的事：
//
//   请求的形状
//     带了浏览器跑出来的验证码（X-Aliyun-Captcha-Verify-Param）
//     **不带**模型请求的那些头（x-api-key、anthropic-version、x-zcode-agent、
//     x-zcode-session-type、x-zcode-trace-id、x-query-id、x-zcode-query-source）
//     body 只有 plan_id
//
//   结论的五种（合成一个 bool 就分不出来了）
//     claimed          上游 code 0 且给了计划
//     already          同一个 campaign|plan 领过了（**不发**第二个 POST）
//     captcha_rejected 上游 3007：浏览器那一把不被认
//     no_offer         plan_id 不在当前的投放里（**一个领取请求都不发**）
//     failed           其余（5xx、超时、其它业务码）
//
//   留痕
//     每次手动领取都有一行：provider、campaign、plan、业务码、耗时
//     **验证码参数的原值不进日志**（只留长度）
//
//   面板要的那些配置
//     configs.captcha 缺失 / enabled:false → 明确的「这一路领不了」，不是
//     安静地当成可领（面板据此不显示按钮）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startFakeUpstream, type CapturedRequest } from "./fake-upstream.ts";
import { captureLog } from "./log-capture.ts";

// 会话层在模块求值时读配置，所以数据目录与假上游的地址要设好才能 import
// （与 test/zcode-claim-check.ts 同一套做法）。
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-claim-manual-"));
process.env.FACADE_DATA_DIR = DATA_DIR;

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

/** 客户端配置接口这一轮怎么答。 */
type ConfigsMode = "ok" | "missing" | "disabled";
/** 投放这一轮怎么答。 */
type TouchMode = "offer" | "empty";
/** 领取这一轮怎么答。 */
type ClaimMode = "ok" | "captcha" | "terminal" | "server-error";

let configsMode: ConfigsMode = "ok";
let touchMode: TouchMode = "offer";
let claimMode: ClaimMode = "ok";
/**
 * 这一轮投放的 campaign_id。
 *
 * 每一节换一个：幂等的记忆是「这个 campaign|plan 领过了」，所以要验「同一个
 * 投放领两次」时得让别的节用别的 campaign（否则第一节领过的那一个会让后面
 * 每节都落在「已经领过了」上，测不到东西）。
 */
let offerCampaignId = "camp-1";

/** 收到过几个请求（按路径分）。 */
let configsHits = 0;
let touchHits = 0;
let claimHits = 0;
/** 最近一次领取请求。 */
let lastClaim: CapturedRequest | null = null;

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
            { show_name: "GLM-5.3-Flash", grant_units: 300000000, effective_at: 1795100400 },
          ],
        },
      },
    },
  },
};

const fake = await startFakeUpstream((req) => {
  const url = req.url ?? "";
  const send = (body: unknown, status = 200): { status: number; body: unknown } => ({
    status,
    body,
  });
  if (url.startsWith("/api/v1/client/configs")) {
    configsHits++;
    if (configsMode === "missing") {
      // 上游没下发 captcha 那一段（不是「不要」，是「没有这一段」）。
      return send({ code: 0, msg: "", data: { configs: {} } });
    }
    return send({
      code: 0,
      msg: "",
      data: {
        configs: {
          captcha:
            configsMode === "disabled"
              ? { enabled: false, prefix: "no8xfe", region: "cn", sceneId: "11xygtvd" }
              : {
                  enabled: true,
                  prefix: "no8xfe",
                  region: "cn",
                  sceneId: "11xygtvd",
                  skip_model_request: true,
                },
        },
      },
    });
  }
  if (url.startsWith("/api/v1/marketing/touch")) {
    touchHits++;
    if (touchMode === "empty") {
      return send({ code: 0, msg: "", data: { server_time: 1795092086, deliveries: [] } });
    }
    return send({
      code: 0,
      msg: "",
      data: {
        server_time: 1795092086,
        deliveries: [{ ...OFFER_DELIVERY, campaign_id: offerCampaignId }],
      },
    });
  }
  if (url.startsWith("/api/v1/zcode-plan/billing/claim")) {
    claimHits++;
    lastClaim = req;
    if (claimMode === "captcha") {
      return send({ code: 3007, msg: "captcha verify failed", data: { message: "" } });
    }
    if (claimMode === "terminal") {
      return send({ code: 1001, msg: "", data: { message: "今日领取名额已用完" } });
    }
    if (claimMode === "server-error") {
      return send({ code: 500, msg: "internal error" }, 500);
    }
    return send({
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
  if (url.startsWith("/api/v1/zcode-plan/billing/balance")) {
    return send({
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
  return send({ code: 404, msg: "not found" }, 404);
});

process.env.ZCODE_BASE_URL = fake.url;
process.env.ZCODE_QUOTA_TIMEOUT_MS = "400";
process.env.ZCODE_CLAIM_TIMEOUT_MS = "400";
process.env.ZCODE_MARKETING_TIMEOUT_MS = "400";
process.env.ZCODE_MANUAL_CLAIM_TIMEOUT_MS = "400";

const { addAccount } = await import("../lib/providers.ts");
const { providerSecretId } = await import("../lib/credential-ids.ts");
const { setSecret } = await import("../lib/store.ts");
const { claimZcodePlanManually, fetchCaptchaConfig } = await import(
  "../lib/zcode/claim-manual.ts"
);
const { getZcodeClaimStatus } = await import("../lib/admin/zcode-claim.ts");
const { peekHealthSnapshot, putHealthSnapshot } = await import("../lib/health-cache.ts");
import type { HealthSnapshot } from "../lib/provider-kinds.ts";

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
function reset(
  configs: ConfigsMode = "ok",
  touch: TouchMode = "offer",
  claim: ClaimMode = "ok",
  campaign = "camp-1",
): void {
  configsMode = configs;
  touchMode = touch;
  claimMode = claim;
  offerCampaignId = campaign;
  configsHits = 0;
  touchHits = 0;
  claimHits = 0;
  lastClaim = null;
  // 领取的结论也复位（它存在现役的快照里）：否则上一节领过的投放会让这一节
  // 不再 POST，下面的断言就测不到东西了。
  putHealthSnapshot({ qoder: {}, minimax: {}, zcode: {}, workbuddy: {}, plugins: {} });
}

/* ------------------------------------------------------------------ *
 * 账号
 * ------------------------------------------------------------------ */

const account = addAccount({ platform: "zcode", alias: "手动领取测试" });
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

/** 浏览器跑出来的那一次性参数（形状像，但不写真值）。 */
const CAPTCHA_PARAM = "captcha-param-from-browser";

/* ------------------------------------------------------------------ *
 * 一、请求的形状
 * ------------------------------------------------------------------ */

section("一、请求的形状：带验证码头，不带模型头，body 只有 plan_id");

reset();
const claimed = await claimZcodePlanManually(ACCOUNT_ID, {
  planId: "plan-alpha",
  campaignId: "camp-1",
  captchaVerifyParam: CAPTCHA_PARAM,
  captchaRegion: "cn",
});
check("领到了", claimed.outcome === "claimed", JSON.stringify(claimed));
check("领取请求发了一个", claimHits === 1, String(claimHits));
check(
  "带了 X-Aliyun-Captcha-Verify-Param",
  lastClaim?.headers["x-aliyun-captcha-verify-param"] === CAPTCHA_PARAM,
  JSON.stringify(lastClaim?.headers["x-aliyun-captcha-verify-param"]),
);
check(
  "带了 X-Aliyun-Captcha-Verify-Region",
  lastClaim?.headers["x-aliyun-captcha-verify-region"] === "cn",
  JSON.stringify(lastClaim?.headers["x-aliyun-captcha-verify-region"]),
);
const MODEL_HEADERS = [
  "x-api-key",
  "anthropic-version",
  "x-zcode-agent",
  "x-zcode-session-type",
  "x-zcode-trace-id",
  "x-query-id",
  "x-zcode-query-source",
];
const leaked = MODEL_HEADERS.filter((h) => lastClaim?.headers[h] !== undefined);
check("一个模型头都没带", leaked.length === 0, leaked.join(","));
check(
  "Authorization 只有一份（叠了上游回 401 空正文）",
  typeof lastClaim?.headers["authorization"] === "string" &&
    lastClaim.headers["authorization"].startsWith("Bearer "),
  JSON.stringify(lastClaim?.headers["authorization"]),
);
check(
  "body 只有 plan_id",
  lastClaim?.body === JSON.stringify({ plan_id: "plan-alpha" }),
  lastClaim?.body,
);
check(
  "结论带着领到的计划名与生效时刻",
  claimed.planName === "ALPHA PLAN" && typeof claimed.effectiveAt === "string",
  JSON.stringify(claimed),
);
check(
  "快照更新了（面板从那儿读）",
  peekHealthSnapshot<HealthSnapshot>()?.data?.zcode?.[ACCOUNT_ID]?.claim?.state === "claimed",
  JSON.stringify(peekHealthSnapshot<HealthSnapshot>()?.data?.zcode?.[ACCOUNT_ID]?.claim),
);

/* ------------------------------------------------------------------ *
 * 二、上游拒了验证码
 * ------------------------------------------------------------------ */

section("二、上游拒了验证码（3007）");

reset("ok", "offer", "captcha", "camp-captcha");
const captured = captureLog({ methods: ["info", "warn"] });
const logs = captured.all;
let rejected: Awaited<ReturnType<typeof claimZcodePlanManually>>;
try {
  rejected = await claimZcodePlanManually(ACCOUNT_ID, {
    planId: "plan-alpha",
    campaignId: "camp-1",
    captchaVerifyParam: CAPTCHA_PARAM,
    captchaRegion: "cn",
  });
} finally {
  captured.restore();
}
check("3007 → captcha_rejected", rejected.outcome === "captcha_rejected", JSON.stringify(rejected));
check("结论带着业务码 3007", rejected.code === 3007, JSON.stringify(rejected.code));
const manualLine = logs.find((l) => l.includes("manual claim")) ?? "";
check("日志有一行手动领取", manualLine !== "", JSON.stringify(logs));
check(
  "日志带着 provider、campaign、plan、业务码与耗时",
  manualLine.includes(`account=${ACCOUNT_ID}`) &&
    manualLine.includes("campaign=camp-captcha") &&
    manualLine.includes("plan=plan-alpha") &&
    manualLine.includes("code=3007") &&
    /took=\d+ms/.test(manualLine),
  manualLine,
);
check(
  "日志里没有验证码参数的原值",
  !manualLine.includes(CAPTCHA_PARAM),
  manualLine,
);
check(
  "日志里只留了验证码参数的长度",
  manualLine.includes(`captcha=len:${CAPTCHA_PARAM.length}`),
  manualLine,
);

/* ------------------------------------------------------------------ *
 * 三、没有可领的投放：一个领取请求都不发
 * ------------------------------------------------------------------ */

section("三、没有可领的投放：一个领取请求都不发");

reset("ok", "empty", "ok", "camp-no-offer");
const noOffer = await claimZcodePlanManually(ACCOUNT_ID, {
  planId: "plan-alpha",
  campaignId: "camp-1",
  captchaVerifyParam: CAPTCHA_PARAM,
  captchaRegion: "cn",
});
check("plan_id 不在当前的投放里 → no_offer", noOffer.outcome === "no_offer", JSON.stringify(noOffer));
check("一个领取请求都没发", claimHits === 0, String(claimHits));
check("问了一次投放（判据是它）", touchHits === 1, String(touchHits));

/* ------------------------------------------------------------------ *
 * 四、同一个投放领过了：不重复 POST
 * ------------------------------------------------------------------ */

section("四、同一个投放领过了：不重复 POST");

reset("ok", "offer", "ok", "camp-already");
const first = await claimZcodePlanManually(ACCOUNT_ID, {
  planId: "plan-alpha",
  campaignId: "camp-1",
  captchaVerifyParam: CAPTCHA_PARAM,
  captchaRegion: "cn",
});
check("第一轮领到了", first.outcome === "claimed", JSON.stringify(first));
check("第一轮发了一个领取请求", claimHits === 1, String(claimHits));
const hitsAfterFirst = claimHits;
const second = await claimZcodePlanManually(ACCOUNT_ID, {
  planId: "plan-alpha",
  campaignId: "camp-1",
  captchaVerifyParam: CAPTCHA_PARAM,
  captchaRegion: "cn",
});
check("第二轮 → already", second.outcome === "already", JSON.stringify(second));
check("第二轮没有再 POST", claimHits === hitsAfterFirst, `${hitsAfterFirst} → ${claimHits}`);

/* ------------------------------------------------------------------ *
 * 五、上游说不能再领（终态码）
 * ------------------------------------------------------------------ */

section("五、上游说不能再领（终态码 1001–1005）");

reset("ok", "offer", "terminal", "camp-terminal");
const terminal = await claimZcodePlanManually(ACCOUNT_ID, {
  planId: "plan-alpha",
  campaignId: "camp-1",
  captchaVerifyParam: CAPTCHA_PARAM,
  captchaRegion: "cn",
});
check("1001 → already", terminal.outcome === "already", JSON.stringify(terminal));
check("结论带着上游的原话", terminal.upstreamMessage.includes("名额"), JSON.stringify(terminal));

/* ------------------------------------------------------------------ *
 * 六、上游 5xx
 * ------------------------------------------------------------------ */

section("六、上游 5xx");

reset("ok", "offer", "server-error", "camp-5xx");
const failed = await claimZcodePlanManually(ACCOUNT_ID, {
  planId: "plan-alpha",
  campaignId: "camp-1",
  captchaVerifyParam: CAPTCHA_PARAM,
  captchaRegion: "cn",
});
check("5xx → failed", failed.outcome === "failed", JSON.stringify(failed));

/* ------------------------------------------------------------------ *
 * 七、面板要的那些配置
 * ------------------------------------------------------------------ */

section("七、面板要的那些配置");

reset("ok");
const status = await getZcodeClaimStatus(ACCOUNT_ID);
check("状态问得到", status.ok, JSON.stringify(status));
check(
  "验证码配置原样给了面板（sceneId / prefix / region / enabled）",
  status.captcha?.present === true &&
    status.captcha?.enabled === true &&
    status.captcha?.sceneId === "11xygtvd" &&
    status.captcha?.prefix === "no8xfe" &&
    status.captcha?.region === "cn",
  JSON.stringify(status.captcha),
);
check("配置齐了 → captchaAvailable", status.captchaAvailable === true, JSON.stringify(status));
check(
  "可领的投放带上了 campaign 与 plan",
  status.offers.length === 1 &&
    status.offers[0]?.campaignId === "camp-1" &&
    status.offers[0]?.planId === "plan-alpha",
  JSON.stringify(status.offers),
);

reset("missing");
const noConfig = await getZcodeClaimStatus(ACCOUNT_ID);
check(
  "配置缺失 → 明确的「领不了」，不是当成可领",
  noConfig.captchaAvailable === false &&
    noConfig.captcha?.present === false &&
    noConfig.message !== "",
  JSON.stringify(noConfig),
);

reset("disabled");
const disabled = await getZcodeClaimStatus(ACCOUNT_ID);
check(
  "enabled:false → 明确的「领不了」，不是当成可领",
  disabled.captchaAvailable === false &&
    disabled.captcha?.present === true &&
    disabled.captcha?.enabled === false &&
    disabled.message !== "",
  JSON.stringify(disabled),
);

reset();
const configProbe = await fetchCaptchaConfig(ACCOUNT_ID);
check(
  "配置读得到时给的是 ok",
  configProbe.state === "ok" && configProbe.config.sceneId === "11xygtvd",
  JSON.stringify(configProbe),
);

/* ------------------------------------------------------------------ *
 * 八、没有验证码参数时不发请求
 * ------------------------------------------------------------------ */

section("八、没有验证码参数：一个请求都不发");

reset();
const noParam = await claimZcodePlanManually(ACCOUNT_ID, {
  planId: "plan-alpha",
  campaignId: "camp-1",
  captchaVerifyParam: "",
  captchaRegion: "cn",
});
check("没有参数 → failed", noParam.outcome === "failed", JSON.stringify(noParam));
check("没有参数 → 一个领取请求都不发", claimHits === 0, String(claimHits));

/* ------------------------------------------------------------------ *
 * 九、别的种类的账号
 * ------------------------------------------------------------------ */

section("九、别的种类的账号");

const otherAccount = addAccount({ platform: "qoder", alias: "不是 zcode" });
if (otherAccount.ok && otherAccount.id) {
  const otherStatus = await getZcodeClaimStatus(otherAccount.id);
  check(
    "不是 zcode 的账号 → 明确说没有可领",
    otherStatus.ok === false && otherStatus.message !== "",
    JSON.stringify(otherStatus),
  );
}

const { closeStore } = await import("../lib/store.ts");
closeStore();
await fake.close();
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
if (fail > 0) {
  for (const p of problems) console.log(`  · ${p}`);
  process.exitCode = 1;
}
