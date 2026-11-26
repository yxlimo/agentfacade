// test/zcode-retry-check.ts — an upstream's 4xx is not a 5xx to retry.
//
//   node --experimental-strip-types test/zcode-retry-check.ts
//
// Offline: temp data directory plus an in-process fake upstream. No real
// upstream is contacted, no quota is spent.
//
// What this pins down:
//   1. the zcode transport keeps the real status on a JSON error while the
//      client still sees the gateway's 502;
//   2. classifyUpstreamError says request/false for a JSON 405 and server/true
//      for a JSON 500 — one criterion, two faces;
//   3. underPolicy sends a request-classified failure once, no retry;
//   4. refused and credential also have retrySameAccountNow false;
//   5. 401/402/429 land on their own paths once the real status is kept.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-retry-"));
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

const { startFakeUpstream } = await import("./fake-upstream.ts");

// One status at a time; the body is a JSON error envelope in every mode so the
// gateway-page detector never fires. Explicit return shape keeps the handler
// assignable to FakeHandler.
let status = 405;
const fake = await startFakeUpstream(
  (): { status: number; body: string; headers: Record<string, string> } => ({
    status,
    body: JSON.stringify({ error: { message: "upstream said no" } }),
    headers: { "content-type": "application/json" },
  }),
);

// The transport reads its base URL when the module is loaded, so set it first.
process.env.ZCODE_BASE_URL = fake.url;

const { AuthError } = await import("../lib/credential.ts");
const { upstreamStatusOf } = await import("../lib/upstream-status.ts");
const { addAccount } = await import("../lib/providers.ts");
const { setSecret } = await import("../lib/store.ts");
const { sessionId } = await import("../lib/zcode/auth.ts");
const { zcodeChat } = await import("../lib/zcode/transport.ts");
const { classifyUpstreamError } = await import("../lib/router/provider-selection.ts");
const { GatewayPageError } = await import("../lib/upstream-gateway-page.ts");
const { underPolicy } = await import("../lib/router/upstreams/policy.ts");

const year = Date.now() + 365 * 24 * 3600 * 1000;
const account = addAccount({ platform: "zcode", alias: "retry check" });
if (!account.ok || !account.id) throw new Error(`ZCode account not created: ${JSON.stringify(account)}`);
const accountId = account.id;
setSecret(sessionId(accountId), "session", {
  token: "test-only-jwt-token",
  provider: "zai",
  deviceId: "00000000-0000-4000-8000-000000000000",
  generation: 1,
  expiresAtMs: year,
});

function ask(): Promise<{ response: Response; session: unknown }> {
  return zcodeChat(
    { model: "glm-5.3", messages: [{ role: "user", content: "hi" }], stream: false },
    { providerId: accountId },
  );
}

/* ------------------------------------------------------------------ *
 * 1. A JSON 405: real status kept, request and retrySameAccountNow false
 * ------------------------------------------------------------------ */
section("JSON 405: upstream status 405, request, retrySameAccountNow false, client 502");

let error405: any;
{
  status = 405;
  const before = fake.requests.length;
  error405 = await caught(ask);
  check("the transport threw", error405 instanceof Error, String(error405));
  check("client-facing status stays 502", error405?.status === 502, String(error405?.status));
  check("upstream status is 405", upstreamStatusOf(error405) === 405, String(upstreamStatusOf(error405)));
  const failure = classifyUpstreamError(error405);
  check("kind is request", failure.kind === "request", failure.kind);
  check("retrySameAccountNow is false", failure.retrySameAccountNow === false, String(failure.retrySameAccountNow));
  check("one upstream attempt", fake.requests.length === before + 1, `${fake.requests.length - before}`);
}

/* ------------------------------------------------------------------ *
 * 2. underPolicy: one attempt, no retry
 * ------------------------------------------------------------------ */
section("underPolicy: a request-classified failure is sent once");

{
  let calls = 0;
  let slept = false;
  const thrown = await caught(() =>
    underPolicy(
      "zcode",
      "retry check",
      async () => {
        calls++;
        throw error405;
      },
      undefined,
      undefined,
      {
        budgetMs: 60_000,
        sleep: async () => {
          slept = true;
          throw new Error("the request error was retried");
        },
      },
    ),
  );
  check("the original error reaches the caller", thrown === error405, String(thrown?.name));
  check("one attempt, no retry", calls === 1 && !slept, `calls=${calls} slept=${slept}`);
}

/* ------------------------------------------------------------------ *
 * 3. A JSON 500: the same criterion's other face
 * ------------------------------------------------------------------ */
section("JSON 500: server, retrySameAccountNow true (same criterion, other face)");

{
  status = 500;
  const before = fake.requests.length;
  const error500 = await caught(ask);
  check("the transport threw", error500 instanceof Error, String(error500));
  check("client-facing status stays 502", error500?.status === 502, String(error500?.status));
  check("upstream status is 500", upstreamStatusOf(error500) === 500, String(upstreamStatusOf(error500)));
  const failure = classifyUpstreamError(error500);
  check("kind is server", failure.kind === "server", failure.kind);
  check("retrySameAccountNow is true", failure.retrySameAccountNow === true, String(failure.retrySameAccountNow));
  check("one upstream attempt", fake.requests.length === before + 1, `${fake.requests.length - before}`);
}

/* ------------------------------------------------------------------ *
 * 4. Other kinds have retrySameAccountNow false too
 * ------------------------------------------------------------------ */
section("refused and credential: retrySameAccountNow false, each on its own path");

{
  const refused = classifyUpstreamError(new GatewayPageError(405, "<html>denied</html>"));
  check("refused kind", refused.kind === "refused", refused.kind);
  check("refused retrySameAccountNow false", refused.retrySameAccountNow === false, String(refused.retrySameAccountNow));

  const credential = classifyUpstreamError(new AuthError("rejected", "hint", 401));
  check("credential kind", credential.kind === "credential", credential.kind);
  check("credential retrySameAccountNow false", credential.retrySameAccountNow === false, String(credential.retrySameAccountNow));
}

/* ------------------------------------------------------------------ *
 * 5. The boundary the change is for: 401/402/429 land on their own paths
 * ------------------------------------------------------------------ */
section("401/402/429: real status lands on credential/no-balance/rate-limit");

{
  const cases: { code: number; kind: string }[] = [
    { code: 401, kind: "credential" },
    { code: 402, kind: "no-balance" },
    { code: 429, kind: "rate-limit" },
  ];
  for (const c of cases) {
    status = c.code;
    const error = await caught(ask);
    check(`${c.code}: upstream status kept`, upstreamStatusOf(error) === c.code, String(upstreamStatusOf(error)));
    const failure = classifyUpstreamError(error);
    check(`${c.code}: kind is ${c.kind}`, failure.kind === c.kind, failure.kind);
    check(`${c.code}: retrySameAccountNow false`, failure.retrySameAccountNow === false, String(failure.retrySameAccountNow));
  }
}

await fake.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
