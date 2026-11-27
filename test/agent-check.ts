// test/agent-check.ts — 从请求头认出是谁发来的。
//
//   node --experimental-strip-types test/agent-check.ts
//
// 头是从真的客户端抓的：pi 发 user-agent: pi/1.4.0 (linux; node/…)，
// opencode 发 user-agent: opencode/latest/2.1.3/cli 外加 x-opencode-client。

import { detectAgent, detectSession, clientForwardHeaders } from "../lib/agent.ts";

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("");
console.log("认得出来的");

// pi 抓包：user-agent: pi/1.4.0 (linux; node/v24.21.0; x64)
const pi = detectAgent({
  "user-agent": "pi/1.4.0 (linux; node/v24.21.0; x64)",
  "x-stainless-package-version": "0.129.0",
  "anthropic-version": "2023-06-01",
});
check("pi 认得出来", pi.name === "pi", pi.name);
check("pi 的版本在头里", pi.version === "1.4.0", pi.version);
check("原始的 user-agent 留着", pi.userAgent.startsWith("pi/1.4.0"));

// opencode 抓包：user-agent: opencode/latest/2.1.3/cli + x-opencode-client: cli
const opencode = detectAgent({
  "user-agent": "opencode/latest/2.1.3/cli",
  "x-opencode-client": "cli",
  "x-opencode-session": "ses_abc",
});
check("opencode 认得出来", opencode.name === "opencode", opencode.name);
check("opencode 的版本在头里", opencode.version === "2.1.3", opencode.version);

// 键名的大小写不该有影响。
const upper = detectAgent({ "User-Agent": "pi/1.4.0 (linux)" });
check("键名大写也认", upper.name === "pi", upper.name);

// 头是数组的时候取第一个。
const array = detectAgent({ "user-agent": ["curl/8.5.0", "curl/8.4.0"] });
check("数组的头取第一个", array.name === "curl", array.name);

console.log("");
console.log("认不出来的");

const curl = detectAgent({ "user-agent": "curl/8.5.0" });
check("curl 报 curl", curl.name === "curl", curl.name);

const node = detectAgent({ "user-agent": "node" });
check("没版本也能报", node.name === "node", node.name);

const empty = detectAgent({});
check("没有头是 unknown", empty.name === "unknown", empty.name);

const browser = detectAgent({ "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/140" });
check("浏览器报第一个词", browser.name === "Mozilla", browser.name);

console.log("");
console.log("会话头");

// 1. 只有 OpenAI 风格的裸名三个头：三个字段都读到。
const bare = detectSession({
  "session_id": "sess-bare",
  "parent_session_id": "par-bare",
  "session_name": "bare-name",
});
check(
  "裸名三个头都读到",
  bare.sessionId === "sess-bare" && bare.parentSessionId === "par-bare" && bare.sessionName === "bare-name",
  `${bare.sessionId}|${bare.parentSessionId}|${bare.sessionName}`,
);

// 2. 只有网关前缀那三个：值取自前缀头，证明兜底链接上了。
const prefixed = detectSession({
  "agentfacade_session_id": "sess-prefix",
  "agentfacade_parent_session_id": "par-prefix",
  "agentfacade_session_name": "prefix-name",
});
check(
  "前缀头兜底：三个字段都读到，值取自前缀头",
  prefixed.sessionId === "sess-prefix" && prefixed.parentSessionId === "par-prefix" && prefixed.sessionName === "prefix-name",
  `${prefixed.sessionId}|${prefixed.parentSessionId}|${prefixed.sessionName}`,
);

// 3. 两套都有：裸名优先，前缀只做兜底。
const both = detectSession({
  "session_id": "sess-bare",
  "parent_session_id": "par-bare",
  "session_name": "bare-name",
  "agentfacade_session_id": "sess-prefix",
  "agentfacade_parent_session_id": "par-prefix",
  "agentfacade_session_name": "prefix-name",
});
check(
  "两套都有时裸名优先",
  both.sessionId === "sess-bare" && both.parentSessionId === "par-bare" && both.sessionName === "bare-name",
  `${both.sessionId}|${both.parentSessionId}|${both.sessionName}`,
);

// 5. 新补的 session_id 不许插队到既有链（x-session-id）前面。
const priority = detectSession({
  "x-session-id": "from-x-session-id",
  "session_id": "from-session-id",
});
check("并存时按既有优先级取 x-session-id", priority.sessionId === "from-x-session-id", priority.sessionId);

// 会话名是名字字段，截断线与 agentName 一致（64）。
const longName = detectSession({ "session_name": "n".repeat(100) });
check("会话名按 64 截断", longName.sessionName === "n".repeat(64), `len=${longName.sessionName.length}`);

console.log("");
console.log("转发头过滤");

// 4. agentfacade_ 前缀的头一个都不外发，裸名三个照旧透传。
const forwarded = clientForwardHeaders({
  "agentfacade_session_id": "sess-prefix",
  "agentfacade_parent_session_id": "par-prefix",
  "agentfacade_session_name": "prefix-name",
  "session_id": "sess-bare",
  "parent_session_id": "par-bare",
  "session_name": "bare-name",
});
check(
  "agentfacade_ 前缀的三个头都不转发",
  !("agentfacade_session_id" in forwarded) && !("agentfacade_parent_session_id" in forwarded) && !("agentfacade_session_name" in forwarded),
  JSON.stringify(Object.keys(forwarded)),
);
check(
  "裸名三个头照旧透传",
  forwarded["session_id"] === "sess-bare" && forwarded["parent_session_id"] === "par-bare" && forwarded["session_name"] === "bare-name",
  JSON.stringify(forwarded),
);

// 精确名单照旧生效，前缀规则与它并存（键名大小写不敏感）。
const mixed = clientForwardHeaders({
  "authorization": "Bearer gateway-key",
  "AgentFacade_Session_Id": "sess-mixed",
  "session_id": "sess-bare",
});
check(
  "精确名单照旧：authorization 与前缀头都摘掉",
  !("authorization" in mixed) && !("agentfacade_session_id" in mixed) && mixed["session_id"] === "sess-bare",
  JSON.stringify(mixed),
);

console.log("");
console.log(`${pass} 项过了，${fail} 项没过`);
process.exit(fail === 0 ? 0 : 1);
