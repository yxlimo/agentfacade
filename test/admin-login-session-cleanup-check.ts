// test/admin-login-session-cleanup-check.ts — 删账号要把它的登录会话一起清掉。
//
//   node --experimental-strip-types test/admin-login-session-cleanup-check.ts
//
// 离线：只写临时库，不发真请求，只往 cache 表里写编造的登录会话。
//
// 现场：账号 id 会复用（全删光后下一个又从 1 开始）。删账号时若留下一条
// pending 会话，下一个顶着同一 id 的新账号就显示「正在登录」，面板
// 该说的是「没有可用凭据」。这里把那条链钉住。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "admin-login-cleanup-"));
// 测试只能用临时目录：默认回落会撞到生产数据目录。
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

/* ------------------------------------------------------------------ *
 * 登录会话：形状与 login.ts 的 saveLogin 写进 cache 的那一行一样。
 * 半凭据是编造的，不指向任何真东西。
 * ------------------------------------------------------------------ */

const { setCached, listCached, peekCached, closeStore } = await import("../lib/store.ts");
const { addAccount } = await import("../lib/providers.ts");
// 删账号走 admin 层那条（providers 层只删行，不清会话）。
const { deleteAccount } = await import("../lib/admin/accounts.ts");
const { loginActivity } = await import("../lib/admin/login.ts");
const { upstreamState } = await import("../lib/admin/upstreams.ts");
const { UpstreamState } = await import("../lib/gen/agentfacade/admin/v1/admin_pb.ts");

interface FakeLogin {
  loginId: string;
  upstreamId: string;
  accountId: string;
  status: string;
  method: string;
  authorizationUrl: string;
  userCode: string;
  expiresAt: number;
  message: string;
  username: string;
  poll: Record<string, unknown> | null;
  credentialId: string;
}

/** 按 login.ts 的键与形状写一条 pending 会话。 */
function writePendingLogin(accountId: string, loginId: string): void {
  const session: FakeLogin = {
    loginId,
    upstreamId: "minimax",
    accountId,
    status: "pending",
    method: "device",
    authorizationUrl: "https://example.invalid/authorize", // 编造的样例
    userCode: "TEST-CODE",
    expiresAt: Date.now() + 10 * 60 * 1000,
    message: "等你点授权",
    username: "",
    poll: { kind: "minimax", auth: {} },
    credentialId: "",
  };
  // login.ts 的 saveLogin 就是 setCached(`login:${loginId}`, session)。
  setCached(`login:${loginId}`, session);
}

/** 这个账号名下还剩几条 login: 缓存行。 */
function loginRowsOf(accountId: string): string[] {
  const ids: string[] = [];
  for (const row of listCached("login:")) {
    const session = peekCached<FakeLogin>(row.id)?.data;
    if (session?.accountId === accountId) ids.push(row.id);
  }
  return ids;
}

console.log("");
console.log("删账号清掉登录会话");

// 一、建两个账号，各起一条 pending 会话。
const first = addAccount({ platform: "minimax", alias: "第一个" });
const firstId = String(first.id ?? "");
check("建出了账号", Boolean(firstId) && first.ok === true, JSON.stringify(first));
writePendingLogin(firstId, "login-for-first-account");
check("会话写进了 cache 表", loginRowsOf(firstId).length === 1, JSON.stringify(loginRowsOf(firstId)));
check("这个账号正在登录", loginActivity(firstId).loggingIn === true, JSON.stringify(loginActivity(firstId)));
check(
  "平台状态是正在登录",
  upstreamState(firstId) === UpstreamState.LOGGING_IN,
  String(upstreamState(firstId)),
);

const other = addAccount({ platform: "minimax", alias: "另一个" });
const otherId = String(other.id ?? "");
writePendingLogin(otherId, "login-for-other-account");
check("另一个账号也在登录", loginActivity(otherId).loggingIn === true, JSON.stringify(loginActivity(otherId)));

// 二、删第一个账号：它的会话清掉，另一个账号的会话不误伤。
const removed = deleteAccount(firstId);
check("删掉了账号", removed.ok === true, JSON.stringify(removed));
check("新状态下这个账号名下没有 login 缓存行", loginRowsOf(firstId).length === 0, JSON.stringify(loginRowsOf(firstId)));
check("另一个账号的会话还在（清理按 accountId 认人）", loginRowsOf(otherId).length === 1, JSON.stringify(loginRowsOf(otherId)));
check("另一个账号还在登录", loginActivity(otherId).loggingIn === true, JSON.stringify(loginActivity(otherId)));

// 三、把账号全删光 → 再建一个新账号（复用第一个的 id）→ 不再「正在登录」。
// nextAccountId 取现存最大号加一：留着别的账号，新账号就不会复用 1。
deleteAccount(otherId);
const second = addAccount({ platform: "minimax", alias: "第二个" });
const secondId = String(second.id ?? "");
check("新账号复用了第一个账号的 id", secondId === firstId, `${firstId} -> ${secondId}`);
check("新账号名下没有 login 缓存行", loginRowsOf(secondId).length === 0, JSON.stringify(loginRowsOf(secondId)));
check("新账号不在登录", loginActivity(secondId).loggingIn === false, JSON.stringify(loginActivity(secondId)));
check(
  "新账号状态是没有可用凭据，不是正在登录",
  upstreamState(secondId) === UpstreamState.NO_CREDENTIAL,
  String(upstreamState(secondId)),
);

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (problems.length) {
  console.log("");
  for (const problem of problems) console.log(`  - ${problem}`);
}
closeStore();
fs.rmSync(DATA_DIR, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
