// test/minimax-checkin-check.ts — the MiniMax Code daily sign-in.
//
//   node --experimental-strip-types test/minimax-checkin-check.ts
//
// The network is not touched: what is checked here is how the panel is read
// (which day can be claimed, whether today is done, how long the streak is)
// and how the request is built. The protocol comes from the official client
// (MiniMax-AI/minimax-code, packages/tui/src/checkin/http-gateway.ts).

// 数据目录必须先于任何触及 store() 的模块被求值：checkin.ts 的导入链在模块加载时
// 就会走到 store()，而 store() 读 BUDDY_DATA_DIR。ESM 静态 import 在任意顶层语句
// 之前求值，所以本文件第一个 import 这个小模块，让它在 checkin.ts 之前把目录设好。
import "./data-dir-setup.ts";

import {
  CLAIM_ALREADY_CLAIMED,
  CLAIM_CLAIMED,
  SIGNIN_CLAIMABLE,
  SIGNIN_CLAIMED,
  SIGNIN_UPCOMING,
  claimableDay,
  claimedToday,
  streak,
  type SigninPanel,
} from "../lib/minimax/checkin.ts";

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

function panel(days: Partial<SigninPanel["days"][number]>[]): SigninPanel {
  return {
    scene: 2,
    days: days.map((d, i) => ({
      day_no: i + 1,
      points: 400,
      bonus_points: 0,
      status: SIGNIN_UPCOMING,
      is_today: false,
      ...d,
    })) as SigninPanel["days"],
  };
}

console.log("面板");

const fresh = panel([
  { status: SIGNIN_CLAIMABLE, is_today: true, points: 1424, bonus_points: 1024 },
  { status: SIGNIN_UPCOMING, points: 400 },
  { status: SIGNIN_UPCOMING, points: 400 },
]);
check("看得出今天能领", claimableDay(fresh)?.day_no === 1, JSON.stringify(claimableDay(fresh)));
check("还没领", claimedToday(fresh) === false);
check("连签还没开始", streak(fresh) === 0, String(streak(fresh)));
check("奖励分是单独的一个数", claimableDay(fresh)?.bonus_points === 1024);

// 面板是七天一轮，从今天开始：所以「今天」之前的那些天才是已经领过的。
const done = panel([
  { status: SIGNIN_CLAIMED, points: 400 },
  { status: SIGNIN_CLAIMED, points: 400 },
  { status: SIGNIN_CLAIMED, is_today: true, points: 1424 },
  { status: SIGNIN_UPCOMING, points: 400 },
]);
check("领过了就没有可领的", claimableDay(done) === null);
check("领过了就是领过了", claimedToday(done) === true);
check("连签的天数算得对", streak(done) === 3, String(streak(done)));

const broken = panel([
  { status: SIGNIN_CLAIMED, points: 400 },
  { status: SIGNIN_UPCOMING, points: 400 },
  { status: SIGNIN_CLAIMED, is_today: true, points: 400 },
]);
const firstDay = panel([
  { status: SIGNIN_CLAIMED, is_today: true, points: 1424 },
  { status: SIGNIN_UPCOMING, points: 400 },
]);
check("第一天连签是 1", streak(firstDay) === 1, String(streak(firstDay)));
check("中间断了连签就断", streak(broken) === 1, String(streak(broken)));

check("空面板没有可领的", claimableDay(null) === null);
check("空面板没领过", claimedToday(null) === false);
check("空面板连签是 0", streak(null) === 0);

console.log("");
console.log("领奖结果");

check("领到了是 1", CLAIM_CLAIMED === 1);
check("已经领过是 2", CLAIM_ALREADY_CLAIMED === 2);
check("状态 1/2/3 的意思没变", SIGNIN_UPCOMING === 1 && SIGNIN_CLAIMABLE === 2 && SIGNIN_CLAIMED === 3);

console.log("");
console.log("runMiniMaxBenefits 会说今天签没签（假上游，不碰真平台）");

// 修复前：面板说「今日已签到」和「今日已领过」的两条路都不带 signedIn，
// 面板只能拿「今日尚未签到」顶上去 —— 上游明明说了签过。
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const http = await import("node:http");
  // 先定数据目录再引入 store：store 在模块加载时读 BUDDY_DATA_DIR。
  process.env.BUDDY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "test-minimax-checkin-"));
  const { setSecret } = await import("../lib/store.ts");
  const { addAccount } = await import("../lib/providers.ts");
  const accountId = String(addAccount({ platform: "minimax" }).id);
  setSecret(`session:provider:${accountId}`, "session", {
    accessToken: "access_test",
    refreshToken: "refresh_test",
    expiresAtMs: Date.now() + 24 * 3600 * 1000,
    generation: 1,
    uid: "u1",
    nickname: "n",
    domain: "127.0.0.1",
    region: "cn",
  });

  let statusHttp = 200;
  let statusPanel: SigninPanel | null = null;
  let claimReply: Record<string, unknown> = {};
  const upstream = http.createServer((req, res) => {
    const p = (req.url ?? "").split("?")[0];
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (p === "/v1/api/user/info") return send(200, { data: { userInfo: { realUserID: "42" } } });
    if (p.endsWith("/signin/status")) return send(statusHttp, { code: 0, data: statusPanel });
    if (p.endsWith("/signin/claim")) return send(200, { code: 0, data: claimReply });
    send(200, {});
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const port = (upstream.address() as { port: number }).port;
  // 签到的宿主有自己单独的旋钮，就是为了这类测试能单独对准假上游。
  process.env.MINIMAX_PUBLIC_GATEWAY = `http://127.0.0.1:${port}`;

  const { runMiniMaxBenefits } = await import("../lib/minimax/checkin.ts");

  // 面板说今天签了：is_today 那天 status 3。
  statusPanel = done;
  claimReply = {};
  let outcome = await runMiniMaxBenefits(accountId);
  check("面板说今天签了 → signedIn", outcome.signedIn === true, JSON.stringify(outcome));

  // 今天能领，领取成功。
  statusPanel = fresh;
  claimReply = { claim_result: CLAIM_CLAIMED, points: 1424, day_no: 1 };
  outcome = await runMiniMaxBenefits(accountId);
  check(
    "领取成功 → signedIn",
    outcome.signedIn === true && outcome.credits === 1424,
    JSON.stringify(outcome),
  );

  // 领取接口答「已领过」（claim_result 2）：签已经落了，只是不是这一轮。
  claimReply = { claim_result: CLAIM_ALREADY_CLAIMED, points: 0 };
  outcome = await runMiniMaxBenefits(accountId);
  check("「已领过」→ signedIn", outcome.signedIn === true, JSON.stringify(outcome));

  // 状态接口答不上来：ok false，面板最终说「不知道」。
  statusHttp = 500;
  outcome = await runMiniMaxBenefits(accountId);
  check("状态接口答不上来 → ok false", outcome.ok === false, JSON.stringify(outcome));

  upstream.close();
}

console.log("");
console.log(`pass=${pass} fail=${fail}`);
if (fail) {
  console.log(problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
