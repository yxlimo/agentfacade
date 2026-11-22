// test/gateway-page-check.ts — an HTML gateway page is not an API answer.
//
//   node --experimental-strip-types test/gateway-page-check.ts
//
// Offline: temp data directory plus an in-process fake upstream. No real
// upstream is contacted, no quota is spent.
//
// What this pins down:
//   1. detection: content type or an HTML opening in the first 200 bytes; a
//      200 answer and a JSON error are not gateway pages;
//   2. ZCode transport: a 405 HTML page throws GatewayPageError with the
//      upstream's real status, and the raw text stays in the scrubbed hint;
//      a JSON 405 keeps the old 502 path;
//   3. classification and retry: refused is degradable, carries status 405,
//      and is not transient — one upstream attempt ends the request;
//   4. accounting: refused cools down for the fixed unavailable window even
//      when there is no alternative account; it can trip the platform breaker;
//   5. end to end: underPolicy records the cooldown and the panel shows the
//      platform as COOLING with reason `refused`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-page-"));
process.env.FACADE_DATA_DIR = tmp;

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

function section(name: string): void {
  console.log("");
  console.log(name);
}

async function caught(run: () => Promise<unknown>): Promise<any> {
  try {
    await run();
    return null;
  } catch (e) {
    return e;
  }
}

// Fabricated HTML from a gateway, with a fabricated contact address to check
// that the client hint goes through the same scrub as every other upstream body.
const HTML_405 =
  '<!doctype html><html><head><title>405</title></head><body>request not allowed; contact ops@example.invalid</body></html>'; // privacy:allow — fabricated sample

const { startFakeUpstream } = await import("./fake-upstream.ts");

let mode: "html" | "json" = "html";
// 显式写出返回形状：两个分支的 headers 字面量各带一组键，靠推断会得到一个
// 带 `undefined` 的联合，与 FakeHandler 的 `Record<string, string>` 对不上。
const fake = await startFakeUpstream(
  (): { status: number; body: string; headers: Record<string, string> } =>
    mode === "html"
      ? {
          status: 405,
          body: HTML_405,
          headers: { "content-type": "text/html; charset=utf-8", server: "ESA" },
        }
      : {
          status: 405,
          body: JSON.stringify({ error: { message: "method not allowed" } }),
          headers: { "content-type": "application/json" },
        },
);

// The transport reads its base URL when the module is loaded, so set it first.
process.env.ZCODE_BASE_URL = fake.url;

const { isGatewayPage, GatewayPageError } = await import("../lib/upstream-gateway-page.ts");
const { AuthError } = await import("../lib/credential.ts");
const { upstreamBodyOf, upstreamStatusOf } = await import("../lib/upstream-status.ts");
const { addAccount } = await import("../lib/providers.ts");
const { setSecret } = await import("../lib/store.ts");
const { sessionId } = await import("../lib/zcode/auth.ts");
const { zcodeChat } = await import("../lib/zcode/transport.ts");
const { classifyUpstreamError, describeUpstreamError, isDegradableUpstreamError } = await import(
  "../lib/router/provider-selection.ts"
);
const { cooldownForFailure } = await import("../lib/router/account-cooldown.ts");
const { unavailableCooldownMs, listCooldowns } = await import("../lib/cooldown.ts");
const { runWithRetries } = await import("../lib/router/upstreams/policy.ts");
const { underPolicy } = await import("../lib/router/upstreams/policy.ts");
const { isBreakableKind } = await import("../lib/upstream-breaker.ts");
const { adminService } = await import("../lib/admin/service.ts");
const { UpstreamState } = await import("../lib/gen/agentfacade/admin/v1/admin_pb.ts");

const year = Date.now() + 365 * 24 * 3600 * 1000;
const account = addAccount({ platform: "zcode", alias: "gateway page test" });
if (!account.ok || !account.id) throw new Error(`ZCode account not created: ${JSON.stringify(account)}`);
const accountId = account.id;
setSecret(sessionId(accountId), "session", {
  token: "test-only-jwt-token",
  provider: "zai",
  deviceId: "00000000-0000-4000-8000-000000000000",
  generation: 1,
  expiresAtMs: year,
});

/* ------------------------------------------------------------------ *
 * 1. The detector
 * ------------------------------------------------------------------ */
section("Detection: a web page is not the upstream's API");

{
  const htmlByHeader = new Response(HTML_405, {
    status: 405,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
  const htmlByBody = new Response("  <HTML lang=\"en\"><body>405</body></html>", { status: 405 });
  const doctypeByBody = new Response("<!DOCTYPE html><html><body>405</body></html>", {
    status: 405,
    headers: { "content-type": "application/octet-stream" },
  });
  const jsonError = new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: { "content-type": "application/json" },
  });
  const pageTooLate = new Response(`${"x".repeat(220)}<html><body>405</body></html>`, { status: 405 });
  const htmlOk = new Response(HTML_405, {
    status: 200,
    headers: { "content-type": "text/html" },
  });

  check("405 + text/html → gateway page", await isGatewayPage(htmlByHeader));
  check("405 + <HTML after spaces, no content type → gateway page", await isGatewayPage(htmlByBody));
  check("405 + doctype under a wrong content type → gateway page", await isGatewayPage(doctypeByBody));
  check("405 + JSON error → not a gateway page", !(await isGatewayPage(jsonError)));
  check("HTML opening after the first 200 bytes → not a gateway page", !(await isGatewayPage(pageTooLate)));
  check("200 + HTML → not a gateway page", !(await isGatewayPage(htmlOk)));
}

/* ------------------------------------------------------------------ *
 * 2. The transport keeps the upstream's truth
 * ------------------------------------------------------------------ */
section("ZCode transport: real status on the error, raw text in the hint");

{
  const before = fake.requests.length;
  const error = await caught(() =>
    zcodeChat(
      { model: "glm-5.3", messages: [{ role: "user", content: "hi" }], stream: false },
      { providerId: accountId },
    ),
  );
  check("the transport threw", error instanceof Error, String(error));
  check("GatewayPageError, not a disguised 502", error instanceof GatewayPageError, String(error?.name));
  check("upstream status is 405", error?.upstreamStatus === 405 && upstreamStatusOf(error) === 405);
  check("message says what happened", error?.message === "upstream answered with an HTML page (HTTP 405)", error?.message);
  // 与上面 HTML_405 里那个假地址是同一个：这里单独取出，断言「抹掉了它」。
  const fabricatedAddress = "ops@example.invalid"; // privacy:allow — 编造的样例
  check(
    "hint carries the scrubbed upstream body",
    error?.hint?.includes("405") && !error.hint.includes(fabricatedAddress),
    error?.hint,
  );
  check("raw body stays on the error for the log", upstreamBodyOf(error) === HTML_405);
  check("one upstream attempt", fake.requests.length === before + 1, `${fake.requests.length - before}`);
}

{
  mode = "json";
  const before = fake.requests.length;
  const error = await caught(() =>
    zcodeChat(
      { model: "glm-5.3", messages: [{ role: "user", content: "hi" }], stream: false },
      { providerId: accountId },
    ),
  );
  check("a JSON 405 keeps the old path", error instanceof AuthError && !(error instanceof GatewayPageError), String(error?.name));
  check("the old path is still a gateway 502", error?.status === 502, String(error?.status));
  check("one upstream attempt on the old path too", fake.requests.length === before + 1, `${fake.requests.length - before}`);
  mode = "html";
}

/* ------------------------------------------------------------------ *
 * 3. Classification and the single attempt
 * ------------------------------------------------------------------ */
section("Classification: refused is degradable, not transient");

{
  const error = new GatewayPageError(405, HTML_405);
  const failure = classifyUpstreamError(error);
  check("kind is refused", failure.kind === "refused", failure.kind);
  check("status is the upstream's 405", failure.status === 405, String(failure.status));
  check("degradable to another target", failure.degradable === true && isDegradableUpstreamError(error));
  check("log line carries the kind and status", describeUpstreamError(error) === "refused HTTP 405", describeUpstreamError(error));

  let calls = 0;
  let slept = false;
  const thrown = await caught(() =>
    runWithRetries(
      { id: "acct-gateway-page" },
      "gateway page",
      async () => {
        calls++;
        throw error;
      },
      {
        budgetMs: 60_000,
        now: () => 0,
        sleep: async () => {
          slept = true;
          throw new Error("the refused error was retried");
        },
      },
    ),
  );
  check("the original error reaches the caller", thrown === error);
  check("no retry on the same account", calls === 1 && !slept, `calls=${calls} slept=${slept}`);
}

/* ------------------------------------------------------------------ *
 * 4. Accounting and the breaker
 * ------------------------------------------------------------------ */
section("Accounting: fixed cooldown even with no alternative, and breakable");

{
  const error = new GatewayPageError(405, HTML_405);
  const now = Date.now();
  const alone = cooldownForFailure("acct-alone", error, now, false);
  check("no alternative still records a cooldown", alone !== null, JSON.stringify(alone));
  check("the reason is refused", alone?.reason === "refused", String(alone?.reason));
  check(
    "the window is the unavailable one",
    alone !== null && Math.abs(alone.untilMs - (now + unavailableCooldownMs())) <= 1_000,
    JSON.stringify(alone),
  );
  check("refused can trip the platform breaker", isBreakableKind("refused"));
}

/* ------------------------------------------------------------------ *
 * 5. End to end: the panel sees the cooldown
 * ------------------------------------------------------------------ */
section("Panel: underPolicy records it and the platform is COOLING");

{
  let calls = 0;
  const error = new GatewayPageError(405, HTML_405);
  const thrown = await caught(() =>
    underPolicy(
      "zcode",
      "gateway page",
      async () => {
        calls++;
        throw error;
      },
      undefined,
      undefined,
      { budgetMs: 5_000, sleep: async () => { throw new Error("the refused error was retried"); } },
    ),
  );
  check("underPolicy throws the original error", thrown === error, String(thrown?.name));
  check("one upstream attempt end to end", calls === 1, `${calls}`);

  const row = listCooldowns().find((c) => c.providerId === accountId);
  check("cooldown is in the store", row !== undefined, JSON.stringify(row));
  check("cooldown says why", row?.reason === "refused", String(row?.reason));

  // service 方法签名带 request 与 context 两参；列表实现两者都不用。
  const upstreams = await adminService.listUpstreams!({} as never, {} as never);
  const upstream = upstreams.upstreams?.find((u) => u.id === "zcode");
  check("panel finds the platform", upstream !== undefined);
  check("platform is COOLING, not READY", upstream?.state === UpstreamState.COOLING, String(upstream?.state));
  check("panel shows the reason", upstream?.cooldownReason === "refused", upstream?.cooldownReason);
}

await fake.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
