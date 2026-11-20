// test/vendor-quota-conclusion-check.ts — 三家厂商 kind 的额度探测结论。
//
//   node --experimental-strip-types test/vendor-quota-conclusion-check.ts
//
// 离线：三家上游都是本地假服务，不发真请求。
//
// 以前这三个 kind 把探测失败折成 `null`，于是 401 与「没登录」「5xx」一樣
// 变成「额度区空白 + 凭据仍显示已认证」—— 挂了但面板是绿的。现在四态分开：
//
//   ok / unauthorized / failed / missing
//
// 还要验两件事：凭据视图不报 AUTHENTICATED、非 ok 不摆 0 卡；重登后旧的拒绝
// 自动失效（比结论时刻与会话登录时刻）。最后一段是反证：把 unauthorized 改回
// null，本文件对应的断言必须真红。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "vendor-conclusion-"));
process.env.FACADE_DATA_DIR = DATA_DIR;

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

/* ------------------------------------------------------------------ *
 * 假上游：一个服务，按路径区分三家
 * ------------------------------------------------------------------ */

type Mode = "ok" | "unauthorized" | "forbidden" | "server-error";
const modes: Record<string, Mode> = {
  minimax: "ok",
  qoder: "ok",
  workbuddy: "ok",
};

const fake = http.createServer((req, res) => {
  const url = req.url ?? "";
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const kind = url.startsWith("/mm/") || url.includes("minimax")
    ? "minimax"
    : url.startsWith("/qd/")
      ? "qoder"
      : url.startsWith("/wb/") || url.includes("billing")
        ? "workbuddy"
        : "";
  const mode = modes[kind] ?? "ok";
  if (!kind) return send(404, {});
  if (mode === "unauthorized") return send(401, { msg: "token rejected" });
  if (mode === "forbidden") return send(403, { msg: "token rejected" });
  if (mode === "server-error") return send(500, { msg: "boom" });
  if (kind === "minimax") {
    return send(200, {
      base_resp: { status_code: 0 },
      available_amount: 12,
      model_remains: [
        {
          model_name: "general",
          current_interval_total_percent: "100%",
          current_interval_used_percent: "20%",
          current_weekly_total_percent: "100%",
          current_weekly_used_percent: "10%",
        },
      ],
    });
  }
  if (kind === "qoder") {
    return send(200, {
      userQuota: { total: 100, used: 20, remaining: 80 },
      addOnQuota: { total: 0, used: 0, remaining: 0 },
      isQuotaExceeded: false,
    });
  }
  return send(200, {
    data: {
      daily_credit: 10,
      today_credit: 0,
      total_credits: 500,
      streak_days: 3,
      today_checked_in: false,
      CreditGroups: [{ Kind: "plan", Name: "套餐", CycleTotalCapacity: 500, CycleRemainCapacity: 400, CycleUsedCapacity: 100 }],
      TotalCredits: 500,
    },
  });
});

await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
const fakeBase = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
process.env.MINIMAX_API_BASE = `${fakeBase}/mm`;
process.env.QODER_CN_OPENAPI_BASE = `${fakeBase}/qd`;
process.env.QODER_GLOBAL_OPENAPI_BASE = `${fakeBase}/qd`;
process.env.WORKBUDDY_CHAT_BASE = `${fakeBase}/wb`;

/* ------------------------------------------------------------------ *
 * Sessions
 * ------------------------------------------------------------------ */

const { setSecret } = await import("../lib/store.ts");
const { addAccount, provider } = await import("../lib/providers.ts");
const { kindOf } = await import("../lib/provider-kinds.ts");
const { CredentialState } = await import("../lib/gen/agentfacade/admin/v1/admin_pb.ts");

const loginAt = Date.now() - 1000;
const accounts = {
  minimax: String(addAccount({ platform: "minimax" }).id),
  qoder: String(addAccount({ platform: "qoder" }).id),
  workbuddy: String(addAccount({ platform: "workbuddy-cn" }).id),
};

setSecret(`session:provider:${accounts.minimax}`, "session", {
  accessToken: "mm-TESTONLY", // privacy:allow — fabricated sample
  refreshToken: "mm-refresh-TESTONLY", // privacy:allow — fabricated sample
  expiresAtMs: Date.now() + 3_600_000,
  generation: 1,
  loginAtMs: loginAt,
  refreshedAtMs: loginAt,
});
setSecret(`session:provider:${accounts.qoder}`, "session", {
  schemaVersion: 1,
  region: "global",
  clientId: "test-client",
  accessToken: "dt-TESTONLY", // privacy:allow — fabricated sample
  refreshToken: "drt-TESTONLY", // privacy:allow — fabricated sample
  userId: "test-user",
  expiresAtMs: Date.now() + 3_600_000,
  refreshExpiresAtMs: Date.now() + 86_400_000,
  loginAtMs: loginAt,
  refreshedAtMs: loginAt,
  generation: 1,
});
setSecret(`session:provider:${accounts.workbuddy}`, "session", {
  schemaVersion: 1,
  accessToken: "wb-TESTONLY", // privacy:allow — fabricated sample
  refreshToken: "wb-refresh-TESTONLY", // privacy:allow — fabricated sample
  expiresAtMs: Date.now() + 3_600_000,
  loginAtMs: loginAt,
  refreshedAtMs: loginAt,
  domain: "www.workbuddy.cn",
  generation: 1,
});

await import("../lib/kinds/index.ts");
const { refreshOneForTest } = await import("../lib/admin/upstreams.ts");
const { putHealthSnapshot } = await import("../lib/health-cache.ts");

/* ------------------------------------------------------------------ *
 * 每个 kind 的三条：unauthorized / failed / ok
 * ------------------------------------------------------------------ */

async function snapshotOf(kind: string, mode: Mode) {
  modes[kind] = mode;
  const row = provider(accounts[kind as keyof typeof accounts])!;
  return await refreshOneForTest(row);
}

const entries: Record<string, (s: any) => any> = {
  minimax: (s) => s.minimax?.[accounts.minimax],
  qoder: (s) => s.qoder?.[accounts.qoder],
  workbuddy: (s) => s.workbuddy?.[accounts.workbuddy],
};
const probeOf: Record<string, (e: any) => any> = {
  minimax: (e) => e?.tokenPlanProbe,
  qoder: (e) => e?.quota,
  workbuddy: (e) => e?.resources,
};

for (const kind of ["minimax", "qoder", "workbuddy"]) {
  section(`${kind}：401 / 500 / 正常`);
  for (const mode of ["unauthorized", "server-error", "ok"] as Mode[]) {
    const e = entries[kind](await snapshotOf(kind, mode));
    const probe = probeOf[kind](e);
    const expected = mode === "unauthorized" ? "unauthorized" : mode === "server-error" ? "failed" : "ok";
    check(
      `${mode} → ${expected}`,
      probe?.state === expected,
      JSON.stringify(probe),
    );
  }
}

/* ------------------------------------------------------------------ *
 * 视图：unauthorized 时凭据不是 AUTHENTICATED，额度区不摆 0 卡
 * ------------------------------------------------------------------ */

for (const kind of ["minimax", "qoder", "workbuddy"]) {
  section(`${kind}：被拒的凭据视图与额度区`);
  const snapshot = await snapshotOf(kind, "unauthorized");
  putHealthSnapshot(snapshot);
  const k = kindOf(kind)!;
  const row = provider(accounts[kind as keyof typeof accounts])!;
  const view = k.credential!(row);
  check(
    "凭据状态不是 AUTHENTICATED",
    view.status !== CredentialState.AUTHENTICATED,
    String(view.status),
  );
  check(
    "凭据说清被拒、要重登",
    /令牌被上游拒绝/.test(String(view.detail)) && /重新登录/.test(String(view.detail)),
    String(view.detail),
  );
  const views = k.quotas!(row, snapshot);
  check(
    "额度区没有把不知道写成 0",
    views.every((v) => !v.credits || v.credits.remaining !== 0 || v.credits.lots.length > 0),
    JSON.stringify(views),
  );
}

/* ------------------------------------------------------------------ *
 * 重登后旧的拒绝自动失效
 * ------------------------------------------------------------------ */

section("重新登录后旧的拒绝失效");
for (const kind of ["minimax", "qoder", "workbuddy"]) {
  const snapshot = await snapshotOf(kind, "unauthorized");
  putHealthSnapshot(snapshot);
  const k = kindOf(kind)!;
  const id = accounts[kind as keyof typeof accounts];
  const row = provider(id)!;
  check(
    `${kind}：当前令牌被拒 → 凭据报错`,
    k.credential!(row).status !== CredentialState.AUTHENTICATED,
    String(k.credential!(row).status),
  );
  // 新会话（登录时刻晚于结论）：旧的那次拒绝不该再挂在面板上。
  const key = `session:provider:${id}`;
  const raw = (await import("../lib/store.ts")).getSecret<any>(key);
  setSecret(key, "session", { ...raw, loginAtMs: Date.now() + 10_000 });
  check(
    `${kind}：重登之后凭据恢复`,
    k.credential!(row).status === CredentialState.AUTHENTICATED ||
      k.credential!(row).status === CredentialState.USABLE,
    String(k.credential!(row).status),
  );
  setSecret(key, "session", { ...raw, loginAtMs: loginAt });
}

fake.close();
const { closeStore } = await import("../lib/store.ts");
closeStore();
fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (problems.length) {
  console.log("");
  for (const problem of problems) console.log(`  - ${problem}`);
}
if (fail > 0) process.exitCode = 1;
