// test/zcode-quota-check.ts — ZCode 的额度：一次探测的四种结论。
//
//   node --experimental-strip-types test/zcode-quota-check.ts
//
// 离线：上游是本地起的一个假 HTTP 服务，一个真请求都不发出去。
//
// 这一族平台（zcode / minimax / qoder / workbuddy）问上游，回来的东西要先落成
// 一个**结论**，再往面板上写。四种结论，四件不同的事：
//
//   ok             问到了，答复里有额度桶（桶为空是「额度用完了」，那是 ok）
//   unauthorized   上游明说这把令牌不行（401/403）—— 要人重新登录
//   failed         问到了，没拿到答案：5xx、超时、业务码非 0、看不懂的答复
//   missing        本地就没有会话，压根没问
//
// 以前这四种折成一种（`ZcodeQuota | null`），于是「上游拒了这把令牌」在面板上
// 变成「凭据可用 + 额度区空白」—— 等于告诉用户这个账号正常，而下一次请求就会
// 吃 401。插件那一族（lib/quota-state.ts）早就把这条规矩写清楚了，厂商 kind
// 这一族没照做；这一节把它补上。
//
// 断言分四块：
//
//   1. 读快照的规则：四种结论各自得到什么（额度卡、用尽、恢复时刻）
//   1之二. plans：领到了但还没生效（空桶 + active 计划 + 生效时刻未到）
//   2. 假上游：401 / 403 / 5xx / 超时 / 业务码 / 空桶 / 有桶 → 各自的结论
//   3. 凭据那一头：被拒 → 过期；重新登录 → 旧的那次拒绝自动作废
//
// 最后一节是反证：把四种失败都折成 null（旧行为）时，第三块的断言必须红。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { HealthSnapshot, ProviderRow, QuotaView } from "../lib/provider-kinds.ts";

// The ZCode session layer reads config while the module is evaluated, so the
// data directory and the fake upstream's address have to be set before the
// import (same as test/zcode-system-check.ts).
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-quota-"));
process.env.FACADE_DATA_DIR = DATA_DIR;

/* ------------------------------------------------------------------ *
 * 假上游
 * ------------------------------------------------------------------ */

/** 假上游这一轮怎么答。 */
type Mode =
  | "ok"
  | "ok-empty"
  | "ok-plans"
  | "unauthorized"
  | "forbidden"
  | "server-error"
  | "business-error"
  | "reset"
  | "hang";

let mode: Mode = "ok";

const fake = http.createServer((req, res) => {
  const url = req.url ?? "";
  if (!url.startsWith("/api/v1/zcode-plan/billing/balance")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 404, msg: "not found" }));
    return;
  }
  const send = (code: number, body: unknown): void => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  switch (mode) {
    case "unauthorized":
      return send(401, { code: 401, msg: "unauthorized" });
    case "forbidden":
      return send(403, { code: 403, msg: "forbidden" });
    case "server-error":
      return send(500, { code: 500, msg: "internal error" });
    case "business-error":
      // 业务码非 0：HTTP 是 200，答复里说不行。这不是「没额度」，是「看不懂」。
      return send(200, { code: 1005, msg: "token expired" });
    case "ok-empty":
      return send(200, { code: 0, msg: "", data: { server_time: 1792923642, balances: [] } });
    case "ok-plans":
      // 领到了活动额度，但还没生效：上游只给 plans，balances 是空的。
      return send(200, {
        code: 0,
        msg: "",
        data: {
          server_time: 1795008620,
          balances: [],
          plans: [
            {
              user_plan_id: "upl-test",
              plan_id: "zcode-v3-start-plan-test",
              name: "ZCODE GLOBAL BUILD",
              status: "active",
              starts_at: 1795003404,
              ends_at: 1795050000,
              entitlements: [
                {
                  entitlement_id: "ent-test",
                  show_name: "GLM-5.3-Flash",
                  capabilities: ["model:glm-5.3-flash"],
                  grant_units: 300000000,
                  period: "one_time",
                  effective_at: 1795014000,
                },
              ],
            },
          ],
        },
      });
    case "reset":
      // 连接被掐断：fetch 抛错，走的是超时那条路。
      req.socket.destroy();
      return;
    case "hang":
      // 什么都不回：等的是超时。
      return;
    default:
      return send(200, {
        code: 0,
        msg: "",
        data: {
          server_time: 1792923642,
          balances: [
            {
              bucket_id: "bucket_1",
              show_name: "GLM-5.3",
              meter: "model_usage",
              unit_type: "token",
              capabilities: ["model:glm-5.3"],
              total_units: 3000000,
              used_units: 120000,
              remaining_units: 2880000,
              period_start: 1792857600,
              period_end: 1792943999,
              expires_at: 1792943999,
            },
          ],
        },
      });
  }
});

await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakePort = (fake.address() as { port: number }).port;

// 平台地址与超时都在模块加载时读环境变量，所以要在 import 之前设好。
process.env.ZCODE_BASE_URL = `http://127.0.0.1:${fakePort}`;
// 超时那一段要能测：20 秒的等待不适合放进测试里。
process.env.ZCODE_QUOTA_TIMEOUT_MS = "400";

await import("../lib/kinds/zcode.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const { fetchZcodeQuota } = await import("../lib/zcode/credits.ts");
const { putHealthSnapshot } = await import("../lib/health-cache.ts");
const { setSecret } = await import("../lib/store.ts");
const { providerSecretId } = await import("../lib/credential-ids.ts");
const { CredentialState } = await import("../lib/gen/agentfacade/admin/v1/admin_pb.ts");

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

const ACCOUNT = {
  id: "acc-zcode-1",
  platform: "zcode",
  kind: "zcode",
  region: "",
  alias: "",
  enabled: true,
  weight: 0,
  policy: "single",
  createdAt: 0,
  updatedAt: 0,
} as ProviderRow;

const kind = kindOf("zcode");
if (!kind) {
  console.log("  FAIL 注册表里没有 zcode —— lib/kinds/zcode.ts 没有登记");
  process.exit(1);
}

/* ------------------------------------------------------------------ *
 * 会话
 * ------------------------------------------------------------------ */

/**
 * 造一份会话。
 *
 * expiresAtMs 是 0：官方客户端的 zcode JWT 没有 exp，到期由平台说了算 ——
 * 真实情况就是这样，网关只能凭「会话在不在」答 authenticated。
 */
function writeSession(loginAtMs: number): void {
  setSecret(providerSecretId(ACCOUNT.id), "session", {
    token: "zcode-test-token",
    accessToken: "zcode-test-token",
    userId: "u-1",
    provider: "zai",
    deviceId: "device-1234",
    generation: 1,
    loginAtMs,
    expiresAtMs: 0,
  });
}

const LOGIN_AT = Date.now() - 60_000;
writeSession(LOGIN_AT);

/* ------------------------------------------------------------------ *
 * 一、读快照的规则
 * ------------------------------------------------------------------ */

/** 快照里这个账号那一份。 */
const snapshotOf = (quota: unknown, loginAtMs = LOGIN_AT): HealthSnapshot =>
  ({ zcode: { [ACCOUNT.id]: { quota, loginAtMs } } }) as unknown as HealthSnapshot;

const okProbe = (buckets: unknown[], plans: unknown[] = [], serverTime = "2026-11-01T00:00:00.000Z"): any => ({
  state: "ok",
  value: { buckets, plans, serverTime },
  at: Date.now(),
});
const unauthorizedProbe = (at = Date.now()): any => ({
  state: "unauthorized",
  message: "上游拒绝了这把令牌（HTTP 401）",
  at,
});
const failedProbe = (at = Date.now()): any => ({
  state: "failed",
  message: "上游答了 HTTP 500",
  at,
});
const missingProbe = (at = Date.now()): any => ({ state: "missing", at });

const BUCKET = {
  showName: "GLM-5.3",
  total: 3_000_000,
  used: 120_000,
  remaining: 2_880_000,
  expiresAt: "2026-12-01T00:00:00.000Z",
  periodEnd: "2026-12-01T00:00:00.000Z",
};

section("四种结论：面板上得到什么");

// 1. 没问过（快照里没有这一份）：没有额度卡 —— 摆一张全 0 的卡等于说「额度是 0」。
check(
  "没问过 → 没有额度卡",
  kind.quotas(ACCOUNT, { zcode: {} } as unknown as HealthSnapshot).length === 0,
  JSON.stringify(kind.quotas(ACCOUNT, { zcode: {} } as unknown as HealthSnapshot)),
);
check(
  "没问过 → 不算用尽",
  kind.outOfCredits(ACCOUNT, { zcode: {} } as unknown as HealthSnapshot) === false,
);
check(
  "没问过 → 没有恢复时刻",
  kind.recoverAt?.(ACCOUNT, { zcode: {} } as unknown as HealthSnapshot) === null,
);

// 2. unauthorized：不摆额度卡 —— 「剩余 0 点」读起来是「额度用完了」，而真相是
// 「不知道，因为凭据被拒」。不算用尽，也没有恢复时刻。
const unauthorizedViews = kind.quotas(ACCOUNT, snapshotOf(unauthorizedProbe()));
check("凭据被拒 → 没有额度卡", unauthorizedViews.length === 0, JSON.stringify(unauthorizedViews));
check("凭据被拒 → 不算用尽", kind.outOfCredits(ACCOUNT, snapshotOf(unauthorizedProbe())) === false);
check(
  "凭据被拒 → 没有恢复时刻",
  kind.recoverAt?.(ACCOUNT, snapshotOf(unauthorizedProbe())) === null,
);

// 3. failed：与「被拒」一样是「不知道」，同样不摆卡。
const failedViews = kind.quotas(ACCOUNT, snapshotOf(failedProbe()));
check("问不到 → 没有额度卡", failedViews.length === 0, JSON.stringify(failedViews));
check("问不到 → 不算用尽", kind.outOfCredits(ACCOUNT, snapshotOf(failedProbe())) === false);
check(
  "问不到 → 没有恢复时刻",
  kind.recoverAt?.(ACCOUNT, snapshotOf(failedProbe())) === null,
);

// 4. missing：也是「不知道」，同样不摆卡。
const missingViews = kind.quotas(ACCOUNT, snapshotOf(missingProbe()));
check("没有会话 → 没有额度卡", missingViews.length === 0, JSON.stringify(missingViews));
check("没有会话 → 不算用尽", kind.outOfCredits(ACCOUNT, snapshotOf(missingProbe())) === false);

// 5. ok + 空桶：额度用完了（不是「不知道」）—— 照旧摆一张 0 的卡。
const emptyViews = kind.quotas(ACCOUNT, snapshotOf(okProbe([])));
check("空桶 → 一张额度卡", emptyViews.length === 1, JSON.stringify(emptyViews));
check(
  "空桶 → 卡上写明用完了",
  /用完/.test(emptyViews[0]?.credits?.note ?? ""),
  JSON.stringify(emptyViews[0]?.credits?.note),
);
check("空桶 → 剩余是 0", emptyViews[0]?.credits?.remaining === 0, String(emptyViews[0]?.credits?.remaining));
check("空桶 → 算用尽", kind.outOfCredits(ACCOUNT, snapshotOf(okProbe([]))) === true);

// 6. ok + 有桶：现状不变。
const bucketViews = kind.quotas(ACCOUNT, snapshotOf(okProbe([BUCKET])));
check("有桶 → 一张额度卡", bucketViews.length === 1, JSON.stringify(bucketViews));
check("有桶 → 剩余 2880000", bucketViews[0]?.credits?.remaining === 2_880_000, String(bucketViews[0]?.credits?.remaining));
check("有桶 → 不算用尽", kind.outOfCredits(ACCOUNT, snapshotOf(okProbe([BUCKET]))) === false);
check(
  "有桶 → 恢复时刻是桶的到期时间",
  kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([BUCKET]))) === Date.parse(BUCKET.expiresAt),
  String(kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([BUCKET])))),
);
check(
  "有桶但剩余是 0 → 算用尽",
  kind.outOfCredits(ACCOUNT, snapshotOf(okProbe([{ ...BUCKET, remaining: 0 }]))) === true,
);

/* ------------------------------------------------------------------ *
 * 一之二、plans：领到了但还没生效
 *
 * 上一单栽在这里：上游说「额度领到了，23:00 才生效」，答复里 balances 是空的，
 * 于是旧实现把空桶读成「套餐额度已用完」。真相在 data.plans 里。
 *
 * 判据按「有没有桶」×「有没有生效中的计划」分，时间用上游的 server_time。
 * ------------------------------------------------------------------ */

const HOUR = 3_600_000;
const NOW = Date.now();
const EFFECTIVE_AT = NOW + HOUR;
const EFFECTIVE_ISO = new Date(EFFECTIVE_AT).toISOString();

/** 一个领到了、还没生效的计划（快照里的形状）。 */
const PENDING_PLAN = {
  userPlanId: "upl-test",
  planId: "zcode-v3-start-plan-test",
  name: "ZCODE GLOBAL BUILD",
  status: "active",
  startsAt: new Date(NOW - HOUR).toISOString(),
  endsAt: new Date(NOW + 12 * HOUR).toISOString(),
  entitlements: [
    {
      entitlementId: "ent-test",
      showName: "GLM-5.3-Flash",
      capabilities: ["model:glm-5.3-flash"],
      grantUnits: 300_000_000,
      period: "one_time",
      effectiveAt: EFFECTIVE_ISO,
    },
  ],
};

const SERVER_BEFORE = new Date(NOW - HOUR).toISOString();
const SERVER_AFTER = new Date(EFFECTIVE_AT + HOUR).toISOString();

section("plans：领到了但还没生效");

// 1. 空桶 + 领到了还没生效 → 现在用不了（真的用不了），但额度会回来。
const pendingViews = kind.quotas(ACCOUNT, snapshotOf(okProbe([], [PENDING_PLAN], SERVER_BEFORE)));
check(
  "还没生效 → 一张额度卡",
  pendingViews.length === 1,
  JSON.stringify(pendingViews),
);
check("还没生效 → 剩余是 0", pendingViews[0]?.credits?.remaining === 0, String(pendingViews[0]?.credits?.remaining));
check(
  "还没生效 → 卡上写明已领到与生效时刻",
  /ZCODE GLOBAL BUILD/.test(pendingViews[0]?.credits?.note ?? "") &&
    pendingViews[0]?.credits?.note?.includes(EFFECTIVE_ISO) === true,
  JSON.stringify(pendingViews[0]?.credits?.note),
);
check(
  "还没生效 → 卡上写明额度量",
  /300000000/.test(pendingViews[0]?.credits?.note ?? ""),
  JSON.stringify(pendingViews[0]?.credits?.note),
);
check(
  "还没生效 → 算用尽（现在确实一个字节都用不了）",
  kind.outOfCredits(ACCOUNT, snapshotOf(okProbe([], [PENDING_PLAN], SERVER_BEFORE))) === true,
);
check(
  "还没生效 → 恢复时刻是生效时刻",
  kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([], [PENDING_PLAN], SERVER_BEFORE))) === EFFECTIVE_AT,
  String(kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([], [PENDING_PLAN], SERVER_BEFORE)))),
);

// 2. 空桶 + 计划已生效 → 就是「用完」，不拿生效时刻冒充恢复时刻。
const usedUpViews = kind.quotas(ACCOUNT, snapshotOf(okProbe([], [PENDING_PLAN], SERVER_AFTER)));
check(
  "已生效 → 卡上写的是用完",
  /用完/.test(usedUpViews[0]?.credits?.note ?? ""),
  JSON.stringify(usedUpViews[0]?.credits?.note),
);
check(
  "已生效 → 不拿生效时刻当恢复时刻",
  kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([], [PENDING_PLAN], SERVER_AFTER))) !== EFFECTIVE_AT,
  String(kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([], [PENDING_PLAN], SERVER_AFTER)))),
);
check(
  "已生效 → 没有恢复时刻（用完就是用完）",
  kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([], [PENDING_PLAN], SERVER_AFTER))) === null,
  String(kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([], [PENDING_PLAN], SERVER_AFTER)))),
);

// 3. 空桶 + 没有计划 → 现状：用完。
const noPlanViews = kind.quotas(ACCOUNT, snapshotOf(okProbe([], [], SERVER_BEFORE)));
check(
  "没有计划 → 卡上写的是用完",
  /用完/.test(noPlanViews[0]?.credits?.note ?? ""),
  JSON.stringify(noPlanViews[0]?.credits?.note),
);
check(
  "没有计划 → 算用尽",
  kind.outOfCredits(ACCOUNT, snapshotOf(okProbe([], [], SERVER_BEFORE))) === true,
);
check(
  "没有计划 → 没有恢复时刻",
  kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([], [], SERVER_BEFORE))) === null,
);

// 4. 有桶 + 有计划 → 数值照现状（计划不搅局）。
const bothViews = kind.quotas(ACCOUNT, snapshotOf(okProbe([BUCKET], [PENDING_PLAN], SERVER_BEFORE)));
check("有桶 + 有计划 → 剩余照旧", bothViews[0]?.credits?.remaining === 2_880_000, String(bothViews[0]?.credits?.remaining));
check(
  "有桶 + 有计划 → 不算用尽",
  kind.outOfCredits(ACCOUNT, snapshotOf(okProbe([BUCKET], [PENDING_PLAN], SERVER_BEFORE))) === false,
);
check(
  "有桶 + 有计划 → 恢复时刻是桶的到期时间",
  kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([BUCKET], [PENDING_PLAN], SERVER_BEFORE))) ===
    Date.parse(BUCKET.expiresAt),
  String(kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([BUCKET], [PENDING_PLAN], SERVER_BEFORE)))),
);

// 5. 不是 active 的计划不算「还没生效」。
const expiredPlan = { ...PENDING_PLAN, status: "expired" };
check(
  "计划不是 active → 不算还没生效",
  kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([], [expiredPlan], SERVER_BEFORE))) === null,
  String(kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([], [expiredPlan], SERVER_BEFORE)))),
);
check(
  "计划不是 active → 卡上写的是用完",
  /用完/.test(
    kind.quotas(ACCOUNT, snapshotOf(okProbe([], [expiredPlan], SERVER_BEFORE)))[0]?.credits?.note ?? "",
  ),
);

// 6. 生效时刻缺失 → 不编恢复时刻。
const noEffectivePlan = {
  ...PENDING_PLAN,
  entitlements: [{ ...PENDING_PLAN.entitlements[0], effectiveAt: null }],
};
check(
  "生效时刻缺失 → 不编恢复时刻",
  kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([], [noEffectivePlan], SERVER_BEFORE))) === null,
  String(kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([], [noEffectivePlan], SERVER_BEFORE)))),
);

// 7. 尺子是上游的 server_time，不是本机时钟。
//    生效时刻在本机时钟里已经过了，但上游的尺子还没走到 → 仍然算「还没生效」。
const staleLocalPlan = {
  ...PENDING_PLAN,
  entitlements: [
    { ...PENDING_PLAN.entitlements[0], effectiveAt: new Date(NOW - HOUR).toISOString() },
  ],
};
const staleServerTime = new Date(NOW - 2 * HOUR).toISOString();
check(
  "server_time 是尺子 → 本机时钟过了生效时刻仍然算还没生效",
  kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([], [staleLocalPlan], staleServerTime))) ===
    Date.parse(new Date(NOW - HOUR).toISOString()),
  String(kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([], [staleLocalPlan], staleServerTime)))),
);
//    反过来：本机时钟还没到，上游的尺子已经过了 → 算「生效中」，不编恢复时刻。
const futureLocalPlan = {
  ...PENDING_PLAN,
  entitlements: [
    { ...PENDING_PLAN.entitlements[0], effectiveAt: new Date(NOW + 2 * HOUR).toISOString() },
  ],
};
const aheadServerTime = new Date(NOW + 3 * HOUR).toISOString();
check(
  "server_time 是尺子 → 上游说生效了就不算还没生效",
  kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([], [futureLocalPlan], aheadServerTime))) === null,
  String(kind.recoverAt?.(ACCOUNT, snapshotOf(okProbe([], [futureLocalPlan], aheadServerTime)))),
);

/* ------------------------------------------------------------------ *
 * 二、假上游：每一种答复得到哪个结论
 * ------------------------------------------------------------------ */

section("三、假上游：答复 → 结论");

const probeFor = async (m: Mode): Promise<any> => {
  mode = m;
  return await fetchZcodeQuota(ACCOUNT.id);
};

const unauthorized = await probeFor("unauthorized");
check("401 → unauthorized", unauthorized?.state === "unauthorized", JSON.stringify(unauthorized));
check(
  "401 → 带着上游拒了的话",
  /401/.test(String(unauthorized?.message ?? "")),
  JSON.stringify(unauthorized?.message),
);

const forbidden = await probeFor("forbidden");
check("403 → unauthorized", forbidden?.state === "unauthorized", JSON.stringify(forbidden));

const serverError = await probeFor("server-error");
check("500 → failed", serverError?.state === "failed", JSON.stringify(serverError));
check(
  "500 → 不是 unauthorized",
  serverError?.state !== "unauthorized",
  JSON.stringify(serverError?.state),
);

const business = await probeFor("business-error");
check("业务码非 0 → failed", business?.state === "failed", JSON.stringify(business));
check(
  "业务码非 0 → 带着服务端的话",
  /token expired/.test(String(business?.message ?? "")),
  JSON.stringify(business?.message),
);

const reset = await probeFor("reset");
check("连接被掐断 → failed", reset?.state === "failed", JSON.stringify(reset));

const hung = await probeFor("hang");
check("超时 → failed", hung?.state === "failed", JSON.stringify(hung));

const empty = await probeFor("ok-empty");
check("200 + 空桶 → ok", empty?.state === "ok", JSON.stringify(empty));
check("200 + 空桶 → 桶是空的", (empty?.value?.buckets ?? []).length === 0, JSON.stringify(empty?.value));

const filled = await probeFor("ok");
check("200 + 有桶 → ok", filled?.state === "ok", JSON.stringify(filled));
check("200 + 有桶 → 一个桶", (filled?.value?.buckets ?? []).length === 1, JSON.stringify(filled?.value));
check(
  "200 + 有桶 → 桶的剩余是 2880000",
  filled?.value?.buckets?.[0]?.remaining === 2_880_000,
  String(filled?.value?.buckets?.[0]?.remaining),
);

// 上游把计划也给了：plans 与 buckets 各读各的，空桶不代表没有计划。
const withPlans = await probeFor("ok-plans");
check("200 + 只有计划 → ok", withPlans?.state === "ok", JSON.stringify(withPlans));
check(
  "200 + 只有计划 → 桶是空的",
  (withPlans?.value?.buckets ?? []).length === 0,
  JSON.stringify(withPlans?.value?.buckets),
);
check(
  "200 + 只有计划 → 计划读出来了",
  (withPlans?.value?.plans ?? []).length === 1,
  JSON.stringify(withPlans?.value?.plans),
);
check(
  "200 + 只有计划 → 计划的名字与状态",
  withPlans?.value?.plans?.[0]?.name === "ZCODE GLOBAL BUILD" &&
    withPlans?.value?.plans?.[0]?.status === "active",
  JSON.stringify(withPlans?.value?.plans?.[0]),
);
check(
  "200 + 只有计划 → 权益的生效时刻",
  withPlans?.value?.plans?.[0]?.entitlements?.[0]?.effectiveAt === "2026-11-18T15:00:00.000Z",
  JSON.stringify(withPlans?.value?.plans?.[0]?.entitlements?.[0]),
);
check(
  "200 + 只有计划 → 权益的额度量",
  withPlans?.value?.plans?.[0]?.entitlements?.[0]?.grantUnits === 300_000_000,
  String(withPlans?.value?.plans?.[0]?.entitlements?.[0]?.grantUnits),
);
check(
  "200 + 只有计划 → 服务器时间是 ISO",
  typeof withPlans?.value?.serverTime === "string",
  String(withPlans?.value?.serverTime),
);

// 没有会话：压根没问。
setSecret(providerSecretId("acc-zcode-none"), "session", { token: "" });
const noSession = await fetchZcodeQuota("acc-zcode-none");
check("没有会话 → missing", noSession?.state === "missing", JSON.stringify(noSession));

/* ------------------------------------------------------------------ *
 * 三、凭据那一头
 * ------------------------------------------------------------------ */

section("四、凭据那一头");

// 这一节的结论是**从假上游拿的**（不是手写的）：上游真的拒了，这把令牌就是
// 过期了。旧实现里这一段拿不到结论（只有一个 null），于是凭据照旧答「可用」。
const refusedByUpstream = await probeFor("unauthorized");
const failedByUpstream = await probeFor("server-error");

const credentialState = (probe: unknown, loginAtMs = LOGIN_AT): number => {
  putHealthSnapshot(snapshotOf(probe, loginAtMs));
  return Number(kind.credential(ACCOUNT)?.status ?? 0);
};

check(
  "被拒 → 凭据不是「可用」",
  credentialState(refusedByUpstream) !== CredentialState.AUTHENTICATED,
  String(credentialState(refusedByUpstream)),
);
check(
  "被拒 → 凭据是过期",
  credentialState(refusedByUpstream) === CredentialState.EXPIRED,
  String(credentialState(refusedByUpstream)),
);
check(
  "被拒 → 详情写明要重新登录",
  /重新登录/.test(String(kind.credential(ACCOUNT)?.detail ?? "")),
  String(kind.credential(ACCOUNT)?.detail),
);
check(
  "问不到 → 凭据不变（不知道不等于被拒）",
  credentialState(failedByUpstream) === CredentialState.AUTHENTICATED,
  String(credentialState(failedByUpstream)),
);
check(
  "没有会话 → 凭据不变",
  credentialState(missingProbe()) === CredentialState.AUTHENTICATED,
  String(credentialState(missingProbe())),
);
check(
  "拒绝的时刻早于登录时刻 → 凭据仍是「可用」（那是上一次登录的令牌）",
  credentialState(unauthorizedProbe(LOGIN_AT - 60_000)) === CredentialState.AUTHENTICATED,
  String(credentialState(unauthorizedProbe(LOGIN_AT - 60_000))),
);

// 重新登录：登录时刻比那次拒绝新 → 旧的红自动没了。
const rejectedAt = Date.now();
writeSession(rejectedAt + 1000);
check(
  "重新登录 → 旧的那次拒绝自动作废",
  credentialState(unauthorizedProbe(rejectedAt), rejectedAt + 1000) === CredentialState.AUTHENTICATED,
  String(credentialState(unauthorizedProbe(rejectedAt), rejectedAt + 1000)),
);
writeSession(LOGIN_AT);

section("账号那一行：被拒的会话在凭据行上也是过期");

/** 凭据行读出来的那一份（面板上每个账号下面那一行）。 */
const slotReading = (probe: unknown): any => {
  putHealthSnapshot(snapshotOf(probe));
  const slots = kind.credentials.slots(ACCOUNT);
  return slots[0]?.read(ACCOUNT);
};

check(
  "凭据行：被拒 → 会话被标记为作废（面板上那一行是过期）",
  slotReading(unauthorizedProbe())?.session?.refused === true,
  JSON.stringify(slotReading(unauthorizedProbe())?.session),
);
check(
  "凭据行：问不到 → 不算作废（不知道不等于被拒）",
  slotReading(failedProbe())?.session?.refused === false,
  JSON.stringify(slotReading(failedProbe())?.session),
);
check(
  "凭据行：旧的那次拒绝（早于登录时刻）不算作废",
  slotReading(unauthorizedProbe(LOGIN_AT - 60_000))?.session?.refused === false,
  JSON.stringify(slotReading(unauthorizedProbe(LOGIN_AT - 60_000))?.session),
);

/* ------------------------------------------------------------------ *
 * 四、旧的数据形状：折成 null 之后面板上剩下什么
 * ------------------------------------------------------------------ */

section("五、旧的数据形状：折成 null 之后面板上剩下什么");

// 旧实现写进快照的就是这么一份：答不上来就是 null。它把「上游拒了令牌」
// 「问不到」「没问」折成一种，于是面板上没有额度卡，凭据那一边照旧答「可用」。
putHealthSnapshot(snapshotOf(null));
check(
  "quota 是 null → 面板上没有额度卡",
  kind.quotas(ACCOUNT, snapshotOf(null)).length === 0,
  JSON.stringify(kind.quotas(ACCOUNT, snapshotOf(null))),
);
check(
  "quota 是 null → 凭据照旧答「可用」（被拒与问不到分不出来）",
  Number(kind.credential(ACCOUNT)?.status ?? 0) === CredentialState.AUTHENTICATED,
  String(kind.credential(ACCOUNT)?.status ?? ""),
);

// 收尾：把快照清掉，别留给别的用例。
putHealthSnapshot({ zcode: {} } as unknown as HealthSnapshot);

// Close the database before removing its directory: on Windows an open file
// cannot be deleted (EPERM), so the handle has to go first.
const { closeStore } = await import("../lib/store.ts");
closeStore();
fake.close();
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
if (fail > 0) process.exitCode = 1;
