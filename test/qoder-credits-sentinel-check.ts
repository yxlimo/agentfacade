// test/qoder-credits-sentinel-check.ts — Qoder 的「永不过期」哨兵不再冒充恢复时刻
//
//   node --experimental-strip-types test/qoder-credits-sentinel-check.ts
//
// 离线：上游是本机的假服务，凭据是编的，数据库在临时目录。不发真请求、不花额度。
//
// 哨兵来自线上响应：body.expiresAt=253402214400000（9999-12-31）。它表示批次不过期，
// 不是一个真的到期时刻。旧行为把它一路透到面板，拼成「窗口 9999年12月31日 结束」。
//
// 覆盖：
//   1. 哨兵判据本身：认得观察到的值，也认得同类远期值；正常值与过去值不受影响
//   2. 端到端：假上游给哨兵 + 见底 → resetsAt null、批次不带 9999 时刻、recoverAt null、
//      creditsRecoverAtMs 0；而账号仍判见底、仍接不了（路由语义不变）
//   3. 正常未来时刻照旧透出；已经过去的时刻照旧原样解析（不新增行为）
//   4. 控制组：就算快照里硬塞一个 9999 时刻，「能不能接」也不跟着变 —— 证明改动只碰展示时间

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import type { HealthSnapshot, VendorProbe } from "../lib/provider-kinds.ts";
import type { QoderCredits } from "../lib/qoder/credits.ts";

// 环境要在任何库模块被 import 之前定下来：store 与 ENDPOINTS 都在加载时读它们
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "qoder-credits-sentinel-"));
process.env.FACADE_DATA_DIR = tmp;

const DAY = 86_400_000;
const SENTINEL = 253402214400000; // 线上观察到的哨兵：9999-12-31T00:00:00Z

/** 假上游这一轮该答的额度正文。 */
interface QuotaAnswer {
  userQuota?: { total: number; used: number; remaining: number };
  addOnQuota?: { total: number; used: number; remaining: number };
  isQuotaExceeded?: boolean;
  expiresAt?: number;
}
let quotaAnswer: QuotaAnswer = {};

const fake = http.createServer((req, res) => {
  const url = req.url ?? "";
  if (url.startsWith("/api/v2/quota/usage")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(quotaAnswer));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end("{}");
});
await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const port = (fake.address() as { port: number }).port;
process.env.QODER_GLOBAL_OPENAPI_BASE = `http://127.0.0.1:${port}`;

const { fetchQoderCredits, qoderResetsAt } = await import("../lib/qoder/credits.ts");
const { setSecret, closeStore } = await import("../lib/store.ts");
const { addAccount, provider } = await import("../lib/providers.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const { platformCooling } = await import("../lib/admin/upstream-state.ts");
const { platformAvailability } = await import("../lib/admin/platform-state.ts");
const { putHealthSnapshot, clearHealthSnapshot } = await import("../lib/health-cache.ts");

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = ""): void {
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

// 一个 Qoder 账号：会话就是推理凭据
const added = addAccount({ platform: "qoder", alias: "哨兵测试" });
if (!added.ok || !added.id) throw new Error(`账号建不出来：${added.message}`);
const accountId = String(added.id);
const row = provider(accountId);
if (!row) throw new Error(`账号读不出来：${accountId}`);

const now = Date.now();
const year = now + 365 * DAY;
setSecret(`session:provider:${accountId}`, "session", {
  schemaVersion: 1,
  region: "global",
  clientId: "test-client",
  accessToken: "dt-TESTONLY-access-token", // privacy:allow — 编造的样例
  refreshToken: "drt-TESTONLY-refresh-token", // privacy:allow — 编造的样例
  userId: "00000000-0000-0000-0000-000000000000",
  expiresAtMs: year,
  refreshExpiresAtMs: year,
  machineId: "00000000-0000-4000-8000-000000000000",
  machineToken: "TESTONLY-machine-token", // privacy:allow — 编造的样例
  machineType: "test-machine-type",
  generation: 1,
  loginAtMs: now,
  refreshedAtMs: now,
});

const qoder = kindOf("qoder");
if (!qoder) throw new Error("qoder kind 没登记");

function okValue(probe: VendorProbe<QoderCredits>): QoderCredits {
  if (probe.state !== "ok") throw new Error(`额度没问到：${JSON.stringify(probe)}`);
  return probe.value;
}

/** 让假上游答一份「套餐见底」的额度，expiresAt 由用例给。 */
async function fetchWith(expiresAt: number | undefined, remaining = 0): Promise<QoderCredits> {
  quotaAnswer = {
    userQuota: { total: 100, used: 100 - remaining, remaining },
    addOnQuota: { total: 0, used: 0, remaining: 0 },
    isQuotaExceeded: true,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
  return okValue(await fetchQoderCredits(accountId));
}

/** 把问到的额度装成健康快照，供 kind 与 admin 判定读。 */
function snapshotOf(credits: QoderCredits): HealthSnapshot {
  return {
    qoder: {
      [accountId]: { account: {}, credits, quota: { state: "ok", value: credits, at: Date.now() } },
    },
    minimax: {},
    zcode: {},
    workbuddy: {},
    plugins: {},
  };
}

/* ------------------------------------------------------------------ *
 * 1. 哨兵判据本身
 * ------------------------------------------------------------------ */
section("1. 哨兵判据：认得观察到的值，也认得同类远期值");

check("线上观察到的 9999 哨兵 → null", qoderResetsAt(SENTINEL) === null, String(qoderResetsAt(SENTINEL)));
const anotherFarFuture = Date.now() + 150 * 365.25 * DAY;
check("另一个远期值（150 年后）也 → null（不是只认那一个数）", qoderResetsAt(anotherFarFuture) === null, String(qoderResetsAt(anotherFarFuture)));
const withinHorizon = Date.now() + 99 * 365.25 * DAY;
check("100 年以内（99 年后）不误伤，仍当真时刻", qoderResetsAt(withinHorizon) !== null, String(qoderResetsAt(withinHorizon)));
const future = Date.now() + 3 * DAY;
check("正常未来（3 天后）照旧解析", qoderResetsAt(future) === new Date(future).toISOString(), String(qoderResetsAt(future)));
const past = Date.now() - 3 * DAY;
check("过去的时刻照旧解析（既有语义）", qoderResetsAt(past) === new Date(past).toISOString(), String(qoderResetsAt(past)));
check("没有 expiresAt → null", qoderResetsAt(undefined) === null);
check("非数字 expiresAt → null", qoderResetsAt("9999-12-31") === null);

/* ------------------------------------------------------------------ *
 * 2. 端到端：哨兵 + 见底
 * ------------------------------------------------------------------ */
section("2. 哨兵 + 见底：展示时间被抹掉，但账号仍接不了");

const sentinelCredits = await fetchWith(SENTINEL);
check("a. 解析结果不带 9999（resetsAt null）", sentinelCredits.resetsAt === null, String(sentinelCredits.resetsAt));
check("a. 见底标记仍在", sentinelCredits.quotaExceeded === true, String(sentinelCredits.quotaExceeded));

const sentinelSnap = snapshotOf(sentinelCredits);
const lots = qoder.quotas(row, sentinelSnap)[0]?.credits?.lots ?? [];
check("a. 批次视图存在", lots.length === 1, String(lots.length));
check("a. 批次不再摆 9999 到期时刻（expiresAt=0）", lots[0]?.expiresAt === 0, String(lots[0]?.expiresAt));
check("a. 批次仍报『已用尽』", lots[0]?.status === "已用尽", String(lots[0]?.status));
const recovered = qoder.recoverAt?.(row, sentinelSnap) ?? null;
check("a. recoverAt 为 null（不知道什么时候恢复）", recovered === null, String(recovered));
check("a. outOfCredits 仍为 true（账号仍判额度见底）", qoder.outOfCredits(row, sentinelSnap) === true, String(qoder.outOfCredits(row, sentinelSnap)));

putHealthSnapshot(sentinelSnap);
const cooling = platformCooling({ rows: [row], snapshot: sentinelSnap, now });
check("a. 平台 creditsRecoverAtMs 为 0", cooling.creditsRecoverAtMs === 0, String(cooling.creditsRecoverAtMs));
check("a. 平台仍报一个账号见底", cooling.exhaustedAccounts === 1, String(cooling.exhaustedAccounts));
const avail = platformAvailability("qoder", now);
check("a. 平台状态仍是 out_of_credits", avail.state === "out_of_credits", avail.state);
check("a. 平台没有能接的账号", avail.usable.length === 0, String(avail.usable.length));
check("a. 账号仍在见底表里（恢复时刻 null=不知道）", avail.spent.has(accountId) && avail.spent.get(accountId) === null, String(avail.spent.get(accountId)));

/* ------------------------------------------------------------------ *
 * 3. 正常未来与过去
 * ------------------------------------------------------------------ */
section("3. 正常值与过去值：既有语义不变");

const futureCredits = await fetchWith(future);
const futureSnap = snapshotOf(futureCredits);
check("b. 正常未来时间仍透出 ISO", futureCredits.resetsAt === new Date(future).toISOString(), String(futureCredits.resetsAt));
const futureLots = qoder.quotas(row, futureSnap)[0]?.credits?.lots ?? [];
check("b. 批次仍带那个未来到期时刻", futureLots[0]?.expiresAt === future, String(futureLots[0]?.expiresAt));
check("b. recoverAt 仍是那个未来时刻", qoder.recoverAt?.(row, futureSnap) === future, String(qoder.recoverAt?.(row, futureSnap)));

const pastCredits = await fetchWith(past);
const pastSnap = snapshotOf(pastCredits);
check("c. 过去的时间仍原样解析（不新增行为）", pastCredits.resetsAt === new Date(past).toISOString(), String(pastCredits.resetsAt));
const pastLots = qoder.quotas(row, pastSnap)[0]?.credits?.lots ?? [];
check("c. 批次仍带那个过去的到期时刻", pastLots[0]?.expiresAt === past, String(pastLots[0]?.expiresAt));
check("c. recoverAt 对过去时刻仍是 null（既有语义）", qoder.recoverAt?.(row, pastSnap) === null, String(qoder.recoverAt?.(row, pastSnap)));

/* ------------------------------------------------------------------ *
 * 4. 控制组：展示时间不影响能不能接
 * ------------------------------------------------------------------ */
section("4. 控制组：快照里硬塞 9999 时刻，『能不能接』也不变");

// 旧行为下快照里装的就是那个 9999 ISO。把它与原样快照对比：变的只有恢复时刻那一格。
const oldCredits: QoderCredits = { ...sentinelCredits, resetsAt: new Date(SENTINEL).toISOString() };
const oldSnap = snapshotOf(oldCredits);
check("控制. 旧快照的 creditsRecoverAtMs 确实曾是 9999（复现老问题）", platformCooling({ rows: [row], snapshot: oldSnap, now }).creditsRecoverAtMs === SENTINEL, String(platformCooling({ rows: [row], snapshot: oldSnap, now }).creditsRecoverAtMs));
check("控制. 但 outOfCredits 与修后一样（都是见底）", qoder.outOfCredits(row, oldSnap) === qoder.outOfCredits(row, sentinelSnap));
putHealthSnapshot(oldSnap);
const oldAvail = platformAvailability("qoder", now);
check("控制. 平台状态仍是 out_of_credits（与修后一致）", oldAvail.state === avail.state, `${oldAvail.state} vs ${avail.state}`);
check("控制. 仍然没有能接的账号（与修后一致）", oldAvail.usable.length === avail.usable.length, `${oldAvail.usable.length} vs ${avail.usable.length}`);

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */
clearHealthSnapshot();
closeStore();
fake.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log("");
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
