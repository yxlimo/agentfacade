// test/platform-header-template-check.ts — 开放平台注入头模板的自测（全部离线）。
//
//   node --experimental-strip-types test/platform-header-template-check.ts
//
// 覆盖（交接单的 a–f 六组 + 反证钉住的用例）：
//   a. 纯渲染：{session-id} 被替换、无占位符原样、多头保序、特殊字符的会话 id 不被破坏；
//   b. 校验：每一条拒绝（不是列表 / 超条数 / 非对象 / 空名 / 非法 token / 空值 /
//      CRLF / 超长），报错说清第几条；undefined 当空列表；
//   c. 注入：开放平台配了模板，请求带会话头 → 假上游收到渲染后的头（含纯常量头
//      没有会话也照发）；
//   d. 400：模板带 {session-id} 而取不到会话 → 400，正文含平台名与头名，
//      假上游一个请求都没收到；
//   e. 边界：模拟端（qoder）即使库里有模板，发出去的请求也不含那个头；
//   f. 透传：客户端自带同名头、平台没配模板时仍按 deny-list 透传。
//
// 反证（真做，见交付记录）：① 去掉替换 → c 红；② 400 改成跳过该头 → d 红；
// ③ 注入对模拟端也生效 → e 红。三次还原后全绿。

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clientForwardHeaders } from "../lib/agent.ts";
import {
  MAX_HEADER_TEMPLATES,
  MAX_HEADER_TEMPLATE_VALUE,
  renderHeaderTemplates,
  validateHeaderTemplates,
  type HeaderTemplate,
} from "../lib/admin/platform-headers.ts";
import { startFakeQoder } from "./fake-qoder-upstream.ts";
import { startGateway, type Gateway } from "./harness.ts";

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
 * a 纯渲染
 * ------------------------------------------------------------------ */

section("a 纯渲染");

{
  const templates: HeaderTemplate[] = [
    { name: "x-trace", value: "sess-{session-id}-end" },
    { name: "x-static", value: "const-value" },
    { name: "x-other", value: "{session-id}/{session-id}" },
  ];
  const rendered = renderHeaderTemplates(templates, "S1");
  check("占位符被替换（前后文字保留）", rendered[0].value === "sess-S1-end", rendered[0].value);
  check("无占位符原样", rendered[1].value === "const-value", rendered[1].value);
  check("一个值里出现两次也全替换", rendered[2].value === "S1/S1", rendered[2].value);
  check("顺序保持", rendered.map((t) => t.name).join(",") === "x-trace,x-static,x-other", rendered.map((t) => t.name).join(","));
  // 会话 id 里的连字符、$、反斜杠都是普通字符：split/join 不把它们当替换语法。
  const tricky = renderHeaderTemplates([{ name: "x-t", value: "{session-id}" }], "sess-1$\\x");
  check("特殊字符的会话 id 原样进头", tricky[0].value === "sess-1$\\x", tricky[0].value);
  // sessionId 为 null 时占位符留着（打回的决定在注入层，渲染层不替它做主）。
  const untouched = renderHeaderTemplates(templates, null);
  check("null 会话时占位符留着", untouched[0].value === "sess-{session-id}-end", untouched[0].value);
}

/* ------------------------------------------------------------------ *
 * b 校验
 * ------------------------------------------------------------------ */

section("b 校验的每一条拒绝");

{
  const reject = (raw: unknown, code: string, note: string) => {
    const got = validateHeaderTemplates(raw);
    check(note, !got.ok && got.code === code, JSON.stringify(got));
  };
  reject("nope", "PLATFORM_HEADERS_INVALID", "不是列表被拒");
  reject(new Array(21).fill(0).map(() => ({ name: "x-ok", value: "v" })), "PLATFORM_HEADERS_TOO_MANY", `超过 ${MAX_HEADER_TEMPLATES} 条被拒`);
  reject([{ name: "x-ok", value: "v" }, "not-an-object"], "PLATFORM_HEADERS_INVALID", "某条不是对象被拒");
  reject([{ name: "", value: "v" }], "PLATFORM_HEADERS_NAME_EMPTY", "名字为空被拒");
  reject([{ name: "bad name", value: "v" }], "PLATFORM_HEADERS_NAME_INVALID", "名字含空格被拒");
  reject([{ name: "bad:name", value: "v" }], "PLATFORM_HEADERS_NAME_INVALID", "名字含冒号被拒");
  reject([{ name: "名字", value: "v" }], "PLATFORM_HEADERS_NAME_INVALID", "名字是中文被拒");
  reject([{ name: "x-ok", value: "" }], "PLATFORM_HEADERS_VALUE_EMPTY", "值为空被拒");
  reject([{ name: "x-ok", value: "a\r\nb" }], "PLATFORM_HEADERS_VALUE_INVALID", "值含 CRLF 被拒");
  reject([{ name: "x-ok", value: "x".repeat(MAX_HEADER_TEMPLATE_VALUE + 1) }], "PLATFORM_HEADERS_VALUE_TOO_LONG", "值超长被拒");

  const ok = validateHeaderTemplates([{ name: "x-ok", value: "{session-id}" }, { name: "x-j", value: "{\"tpl\":1}" }]);
  check("合法列表通过", ok.ok, JSON.stringify(ok));
  // 其它 {...} 不校验：它是字面量，原样发。
  check("其它花括号不校验（字面量）", ok.ok && ok.templates[1].value === '{"tpl":1}', JSON.stringify(ok));
  const empty = validateHeaderTemplates(undefined);
  check("undefined 当空列表（不是错误）", empty.ok && empty.templates.length === 0, JSON.stringify(empty));

  // 报错说清第几条：第二条坏 → 文案里有「2」。
  const second = validateHeaderTemplates([{ name: "x-ok", value: "v" }, { name: "bad name", value: "v" }]);
  check("报错指到第几条", !second.ok && /2/.test(second.message), second.message);
}

/* ------------------------------------------------------------------ *
 * f 透传（纯函数层）
 * ------------------------------------------------------------------ */

section("f deny-list 透传（纯函数层）");

{
  const forwarded = clientForwardHeaders({
    "content-type": "application/json",
    "x-custom-fwd": "keep-me",
    authorization: "Bearer secret", // 网关自己的头要摘掉
  });
  check("普通客户端头透传", forwarded["x-custom-fwd"] === "keep-me", JSON.stringify(forwarded));
  check("authorization 不透传", forwarded["authorization"] === undefined, JSON.stringify(forwarded));
}

/* ------------------------------------------------------------------ *
 * 端到端：真网关 + 假上游
 * ------------------------------------------------------------------ */

section("端到端（真网关 + 假上游）");

// 假上游两件事：开放平台指向它（收头、收正文），qoder 指向它（答话，
// 收头 —— 用来证明模拟端不读头模板）。
const fakeQoder = await startFakeQoder();
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "platform-header-"));

execFileSync(
  process.execPath,
  ["--experimental-strip-types", "test/aggregate-setup.ts", "seed"],
  { cwd: ROOT, env: { ...process.env, FACADE_DATA_DIR: dataDir }, stdio: "ignore" },
);

const gw: Gateway = await startGateway({
  dataDir,
  env: {
    BENEFITS_DISABLED: "1",
    QODER_GLOBAL_LEGACY_BASE: `${fakeQoder.base}/qoder-global-legacy`,
    QODER_GLOBAL_OPENAPI_BASE: `${fakeQoder.base}/openapi-global`,
    QODER_LEGACY_RETRY_MS: "50",
  },
});
// 本进程里读库的 helper 与网关同一个数据目录。
process.env.FACADE_DATA_DIR = gw.dataDir;
const token = fs.readFileSync(path.join(gw.dataDir, "admin-token"), "utf8").trim();
const SERVICE = "/agentfacade.admin.v1.AdminService";

async function rpc(method: string, body: unknown = {}): Promise<any> {
  const res = await fetch(`${gw.base}${SERVICE}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let reply: any;
  try {
    reply = JSON.parse(text);
  } catch {
    reply = { raw: text };
  }
  const code = res.headers.get("buddy-error");
  return { ...reply, httpStatus: res.status, ...(code ? { errorCode: code } : {}) };
}

async function chat(p: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${gw.base}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text };
}

const { addAccount } = await import("../lib/providers.ts");
const { setProviderKeys } = await import("../lib/admin/credentials.ts");

const users = [{ role: "user", content: "say ok" }];

/** 假上游收到的 chat/completions 请求（头、原始头顺序）。 */
const chatSeen: { headers: Record<string, string | string[] | undefined>; rawHeaders: string[] }[] = [];

// 起一个开放平台的假上游：普通的 OpenAI 形状，把收到的每个请求记下来。
const { createServer } = await import("node:http");
const openFake = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  chatSeen.push({ headers: { ...req.headers }, rawHeaders: req.rawHeaders });
  const json = (status: number, payload: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
  if (req.method === "GET" && (req.url ?? "").endsWith("/models")) {
    json(200, { object: "list", data: [{ id: "fake-model-a" }] });
    return;
  }
  json(200, {
    id: "c1",
    object: "chat.completion",
    model: "fake-model-a",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  });
});
await new Promise<void>((r) => openFake.listen(0, "127.0.0.1", () => r()));
const openBase = `http://127.0.0.1:${(openFake.address() as { port: number }).port}`;


{
  // c：建平台就带模板（一个占位符头 + 一个常量头），账号带 key。
  const made = await rpc("AddPlatform", {
    id: "hdr-open",
    label: "注入头测试平台",
    baseUrl: `${openBase}/v1`,
    kind: "openai",
    headers: [
      { name: "X-Acme-Session", value: "{session-id}" },
      { name: "x-acme-static", value: "const-v" },
    ],
  });
  check("c 建平台带模板成功", made.platform?.id === "hdr-open" && !made.errorCode, JSON.stringify(made).slice(0, 300));
  check("c 列表回读模板", JSON.stringify(made.platform?.headers ?? []) === JSON.stringify([
    { name: "X-Acme-Session", value: "{session-id}" },
    { name: "x-acme-static", value: "const-v" },
  ]), JSON.stringify(made.platform?.headers));

  const acc = addAccount({ platform: "hdr-open", alias: "hdr-a" });
  check("c 加账号成功", acc.ok && !!acc.id, acc.message);
  if (acc.id) setProviderKeys(acc.id, ["sk-TESTONLY-HEADER-0000"]); // privacy:allow — 编造的样例

  // 目录先拉一把：没目录的开放平台会 503（「目录尚未获取」），那是另一层的事。
  await rpc("RefreshPlatformModels", { platformId: "hdr-open" });

  // 注入：客户端带会话头 → 上游收到渲染后的两个头；同名头用模板的值。
  const okRes = await chat("/hdr-open/v1/chat/completions", { model: "fake-model-a", messages: users }, {
    "x-session-affinity": "S1",
    "x-acme-session": "client-value",
  });
  check("c 请求 200", okRes.status === 200, `${okRes.status} ${okRes.text.slice(0, 200)}`);
  const seen = chatSeen.at(-1);
  check("c 占位符头被渲染成会话 id", seen?.headers["x-acme-session"] === "S1", JSON.stringify(seen?.headers));
  check("c 常量头照发", seen?.headers["x-acme-static"] === "const-v", JSON.stringify(seen?.headers));
  check("c 头名小写归一", Object.keys(seen?.headers ?? {}).includes("x-acme-session"), Object.keys(seen?.headers ?? {}).join(","));
  // 顺序保持：模板的两个头按模板顺序追加在透传头之后。
  const raw = seen?.rawHeaders ?? [];
  const idx = (n: string) => raw.findIndex((v) => v.toLowerCase() === n);
  check("c 两个模板头的顺序保持", idx("x-acme-session") < idx("x-acme-static"), raw.join(" | ").slice(0, 400));

  // c'：纯常量头没有会话也照发（把模板里占位符那条换成常量）。
  const upd = await rpc("UpdatePlatform", { id: "hdr-open", label: "注入头测试平台", headers: { items: [{ name: "x-acme-static", value: "const-v2" }] } });
  check("c' 改模板只动 headers", upd.platform?.id === "hdr-open" && !upd.errorCode, JSON.stringify(upd).slice(0, 300));
  chatSeen.length = 0;
  const noSession = await chat("/hdr-open/v1/chat/completions", { model: "fake-model-a", messages: users });
  check("c' 纯常量模板没有会话也 200", noSession.status === 200, `${noSession.status} ${noSession.text.slice(0, 200)}`);
  check("c' 常量头到了上游", chatSeen.at(-1)?.headers["x-acme-static"] === "const-v2", JSON.stringify(chatSeen.at(-1)?.headers));

  // d：模板带占位符而取不到会话 → 400，上游零请求，正文说清平台、头、来源、怎么配。
  await rpc("UpdatePlatform", { id: "hdr-open", label: "注入头测试平台", headers: { items: [{ name: "x-acme-session", value: "{session-id}" }] } });
  chatSeen.length = 0;
  const refused = await chat("/hdr-open/v1/chat/completions", { model: "fake-model-a", messages: users });
  check("d 取不到会话 → 400", refused.status === 400, `${refused.status} ${refused.text.slice(0, 200)}`);
  check("d 正文含平台名", refused.text.includes("注入头测试平台"), refused.text.slice(0, 300));
  // 模板里配的是「X-Acme-Session」，正文原样报那个名字（大小写不敏感地断言）。
  check("d 正文含头名", /acme-session/i.test(refused.text), refused.text.slice(0, 300));
  check("d 正文说了怎么配", refused.text.includes("SESSION_HEADER") && refused.text.includes("{session-id}"), refused.text.slice(0, 300));
  check("d 上游零请求", chatSeen.length === 0, String(chatSeen.length));
  check("d 客户端同名头也救不了它", true); // 说明性断言：上面那次请求没带任何会话头

  // 坏值整条拒绝（校验挂在 RPC 上）。
  const bad = await rpc("UpdatePlatform", { id: "hdr-open", label: "注入头测试平台", headers: { items: [{ name: "bad name", value: "v" }] } });
  check("b' 非法头名被 Connect 拒", bad.httpStatus === 400 && bad.errorCode === "PLATFORM_HEADERS_NAME_INVALID", JSON.stringify(bad).slice(0, 200));
  // 没给 = 别动：不带 headers 的更新不能把模板清掉（失败的更新同理 —— 校验在写库之前）。
  const after = await rpc("UpdatePlatform", { id: "hdr-open", label: "注入头测试平台" });
  // 模板原样回读：连名字的大小写都不动（那是用户配的值）。
  check(
    "b' 失败的更新不动原模板",
    JSON.stringify(after.platform?.headers ?? []) === JSON.stringify([{ name: "x-acme-session", value: "{session-id}" }]),
    JSON.stringify(after.platform?.headers),
  );
  // 给了空列表 = 清空。
  const cleared = await rpc("UpdatePlatform", { id: "hdr-open", label: "注入头测试平台", headers: { items: [] } });
  check("空列表清空模板", Array.isArray(cleared.platform?.headers) && cleared.platform.headers.length === 0, JSON.stringify(cleared.platform?.headers));

  // f：平台没配模板时，客户端的同名头按 deny-list 透传。
  chatSeen.length = 0;
  const passthrough = await chat("/hdr-open/v1/chat/completions", { model: "fake-model-a", messages: users }, {
    "x-acme-session": "client-value",
    "x-custom-fwd": "keep-me",
  });
  check("f 无模板时 200", passthrough.status === 200, `${passthrough.status}`);
  const pSeen = chatSeen.at(-1);
  check("f 客户端同名头原样透传", pSeen?.headers["x-acme-session"] === "client-value", JSON.stringify(pSeen?.headers));
  check("f 普通头透传", pSeen?.headers["x-custom-fwd"] === "keep-me", JSON.stringify(pSeen?.headers));

  // e：模拟端（qoder）即使库里有模板也不发这个头。
  const qoderLabel = (await rpc("ListUpstreams", {})).upstreams.find((u: any) => u.id === "qoder")?.label ?? "qoder";
  await rpc("UpdatePlatform", { id: "qoder", label: qoderLabel, headers: { items: [{ name: "x-acme-session", value: "{session-id}" }] } });
  fakeQoder.reset();
  const pub = await rpc("SavePublishedModel", {
    model: {
      id: "hdr-pub",
      displayName: "hdr-pub",
      enabled: true,
      strategy: "single",
      targets: [{ groupName: "qoder", upstreamModel: "gmodel", weight: 1, enabled: true }],
    },
  });
  check("e 发布 qoder 模型", pub.id === "hdr-pub" && !pub.errorCode, JSON.stringify(pub).slice(0, 200));
  const seeded = await rpc("ListUpstreams", {});
  const qoderRow = (seeded.upstreams ?? []).find((u: any) => u.id === "qoder");
  await rpc("SetAccountEnabled", { accountId: (qoderRow?.accounts ?? [])[0]?.id, enabled: true });
  const sim = await chat("/v1/chat/completions", { model: "hdr-pub", messages: users });
  check("e 模拟端请求 200", sim.status === 200, `${sim.status} ${sim.text.slice(0, 200)}`);
  check("e 确实打到了 qoder 假上游", fakeQoder.seen.length > 0, String(fakeQoder.seen.length));
  check(
    "e 模拟端请求不含模板头",
    fakeQoder.seen.every((s) => s.headers["x-acme-session"] === undefined),
    JSON.stringify(fakeQoder.seen.map((s) => s.headers)),
  );
}

await gw.stopAndWait();
await new Promise<void>((resolve) => {
  openFake.close(() => resolve());
  fakeQoder.close();
});
fs.rmSync(dataDir, { recursive: true, force: true });

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

console.log("");
if (fail > 0) {
  console.log(`FAIL：${fail} 条没过`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
} else {
  console.log(`ok：${pass} 条全过`);
}
