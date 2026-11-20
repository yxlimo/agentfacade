// test/admin-claimable-check.ts — 平台那一层读到「名下有几个账号有可领额度」。
//
//   node --experimental-strip-types test/admin-claimable-check.ts
//
// 离线：临时数据目录、假账号、手写的健康快照。面板打开时不能因此多问上游，
// 这里也只走快照（lib/admin/upstreams.ts 的 claimableAccounts）。
//
// 反证：把 claimableAccounts 恒返回 0 → 第一组红；把 service.ts 里的赋值
// 改成 0 → 最后一组红。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "admin-claimable-"));
process.env.FACADE_DATA_DIR = DATA_DIR;

const { claimableAccounts, claimableLabel } = await import("../lib/admin/upstreams.ts");
const { putHealthSnapshot, clearHealthSnapshot } = await import("../lib/health-cache.ts");
const { addAccount, listProviders } = await import("../lib/providers.ts");

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

type Claim = {
  state: string;
  message: string;
  at: number;
  offers?: number;
  offerName?: string;
  offerPriority?: number;
};

function snapshotOf(claims: Record<string, Claim>) {
  const zcode: Record<string, { quota: null; claim: Claim }> = {};
  for (const [id, claim] of Object.entries(claims)) zcode[id] = { quota: null, claim };
  return { qoder: {}, minimax: {}, zcode, workbuddy: {}, plugins: {} };
}

const first = addAccount({ platform: "zcode", alias: "可领" });
const second = addAccount({ platform: "zcode", alias: "已领" });
if (!first.ok || !first.id || !second.ok || !second.id) {
  console.log("  FAIL 造不出两个 zcode 账号");
  process.exitCode = 1;
} else {
  const rows = listProviders().filter((row) => row.kind === "zcode");
  check("两个 zcode 账号", rows.length === 2, JSON.stringify(rows.map((row) => row.id)));

  // 一个 offers=1 未领；另一个 offers=1 但已经领到了 —— 后者不该再提醒。
  putHealthSnapshot(
    snapshotOf({
      [first.id]: {
        at: 1,
        state: "none",
        message: "",
        offers: 1,
        offerName: "WEEKEND BUILD",
        offerPriority: 50,
      },
      [second.id]: {
        at: 1,
        state: "claimed",
        message: "",
        offers: 1,
        offerName: "SHOULD NOT SHOW",
        offerPriority: 10,
      },
    }),
  );
  check(
    "未领的算一个，claimed 的不算 → 1",
    claimableAccounts(rows) === 1,
    String(claimableAccounts(rows)),
  );
  check(
    "活动名取未领那一格的上游原话",
    claimableLabel(rows) === "WEEKEND BUILD",
    claimableLabel(rows),
  );

  // 两个账号都可领：活动名按 offer priority 最小的那个挑。
  putHealthSnapshot(
    snapshotOf({
      [first.id]: {
        at: 1,
        state: "none",
        message: "",
        offers: 2,
        offerName: "LATER OFFER",
        offerPriority: 70,
      },
      [second.id]: {
        at: 1,
        state: "captcha",
        message: "",
        offers: 1,
        offerName: "EARLIER OFFER",
        offerPriority: 10,
      },
    }),
  );
  check(
    "两个账号都可领 → 2 个，名字取 priority 最小的",
    claimableAccounts(rows) === 2 && claimableLabel(rows) === "EARLIER OFFER",
    `${claimableAccounts(rows)}/${claimableLabel(rows)}`,
  );

  // 都不行 → 0。
  putHealthSnapshot(
    snapshotOf({
      [first.id]: { at: 2, state: "none", message: "", offers: 0 },
      [second.id]: { at: 2, state: "already", message: "", offers: 3 },
    }),
  );
  check(
    "一个 0、一个 already → 0，活动名也是空串",
    claimableAccounts(rows) === 0 && claimableLabel(rows) === "",
    `${claimableAccounts(rows)}/${claimableLabel(rows)}`,
  );

  // 问不到（没有 offers 这一格）也不能当成有。
  putHealthSnapshot(
    snapshotOf({
      [first.id]: { at: 3, state: "missing_device", message: "" },
      [second.id]: { at: 3, state: "failed", message: "" },
    }),
  );
  check(
    "问不到（offers 没写）→ 0，不是「有」",
    claimableAccounts(rows) === 0 && claimableLabel(rows) === "",
    String(claimableAccounts(rows)),
  );

  // 没有快照 → 0。
  clearHealthSnapshot();
  check(
    "没有快照 → 0，名字空串",
    claimableAccounts(rows) === 0 && claimableLabel(rows) === "",
    String(claimableAccounts(rows)),
  );
}

// 面板那一条必须真的把这一格填进去（helper 自己对了但没人调也会白做）。
const serviceSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "lib", "admin", "service.ts"),
  "utf8",
);
check(
  "面板 Upstream.claimableAccounts 用的是快照判据",
  /claimableAccounts:\s*claimableAccounts\(rows\)/.test(serviceSource),
  "",
);
check(
  "面板 Upstream.claimableLabel 用的是快照判据",
  /claimableLabel:\s*claimableLabel\(rows\)/.test(serviceSource),
  "",
);
const protoSource = fs.readFileSync(
  path.join(import.meta.dirname, "..", "proto", "agentfacade", "admin", "v1", "admin.proto"),
  "utf8",
);
check(
  "契约里两格分别是 35 / 36 号",
  /int32 claimable_accounts = 35;/.test(protoSource) &&
    /string claimable_label = 36;/.test(protoSource),
  "",
);

fs.rmSync(DATA_DIR, { recursive: true, force: true });

console.log("");
console.log(fail === 0 ? `全部通过（${pass} 项）` : `FAIL: ${fail} 项没过，${pass} 项过了`);
if (fail > 0) process.exitCode = 1;
