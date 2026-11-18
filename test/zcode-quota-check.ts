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
// 断言分三块：
//
//   1. 读快照的规则：四种结论各自得到什么（额度卡、用尽、恢复时刻）
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

const okProbe = (buckets: unknown[]): any => ({
  state: "ok",
  value: { buckets, serverTime: "2026-11-01T00:00:00.000Z" },
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
 * 二、假上游：每一种答复得到哪个结论
 * ------------------------------------------------------------------ */

section("假上游：答复 → 结论");

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

// 没有会话：压根没问。
setSecret(providerSecretId("acc-zcode-none"), "session", { token: "" });
const noSession = await fetchZcodeQuota("acc-zcode-none");
check("没有会话 → missing", noSession?.state === "missing", JSON.stringify(noSession));

/* ------------------------------------------------------------------ *
 * 三、凭据那一头
 * ------------------------------------------------------------------ */

section("凭据：上游拒了就是过期，重新登录就清掉");

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

section("旧的数据形状（quota 是 null）：折成一种之后剩下一片空白");

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
