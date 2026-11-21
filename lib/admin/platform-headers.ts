// lib/admin/platform-headers.ts — 开放平台转发时注入的头模板：存储形状、写入校验、纯渲染。
//
// 这一层不碰请求、不碰会话提取，只有数据规则：存进库之前拦住坏值，转发之前把模板
// 渲染成一行头。会话标识从哪来是 lib/session-id.ts 的事，注入路径在
// lib/admin/platform-header-injection.ts 把两者接起来。
//
// 机器码归 error-codes 一处登记：面板按码查文案，这里只报码。
import {
  PLATFORM_HEADERS_INVALID,
  PLATFORM_HEADERS_NAME_EMPTY,
  PLATFORM_HEADERS_NAME_INVALID,
  PLATFORM_HEADERS_TOO_MANY,
  PLATFORM_HEADERS_VALUE_EMPTY,
  PLATFORM_HEADERS_VALUE_INVALID,
  PLATFORM_HEADERS_VALUE_TOO_LONG,
  type AdminErrorCode,
} from "./error-codes.ts";
// 只有 {session-id} 是占位符。其它 {anything} 都不认，原样发到上游 —— 上游自己
// 认得的花括号（模板变量、JSON 片段）不是我们的会话标识，替它展开就改了语义。

/** 唯一认得的占位符。别的花括号组合都是字面量。 */
export const SESSION_PLACEHOLDER = "{session-id}";

/** 条数上限：一个平台不会有二十个自定义头，多了就是配错了。 */
export const MAX_HEADER_TEMPLATES = 20;

/** 单个值的长度上限：与 clientForwardHeaders 的截断线一致，够放 trace id。 */
export const MAX_HEADER_TEMPLATE_VALUE = 200;

/**
 * 一条头模板。name 是 RFC 7230 token，value 是可以带 {session-id} 的字面值。
 */
export interface HeaderTemplate {
  name: string;
  value: string;
}

/** 校验结果。失败时 code 是机器码，message 说清是哪一条、为什么不行。 */
export type HeaderTemplateCheck =
  | { ok: true; templates: HeaderTemplate[] }
  | { ok: false; code: AdminErrorCode; message: string };

/**
 * RFC 7230 token：!#$%&'*+-.^_`|~ 加数字字母。不含空格、冒号、CR/LF 与中文。
 * 头名里出现这些字符时，Node 的 http 客户端会直接抛错 —— 拦在写库之前。
 */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * 面板写进来的头模板先过这一关。
 *
 * 空列表是合法的：清掉所有模板。undefined 也是「没有这一格」，按空列表处理 ——
 * 调用方（createOpenPlatform / updateOpenPlatform）自己用 undefined 表示「别动」。
 *
 * 报错说清第几条（从 1 起）和哪一格，面板能把它直接指到那一行的输入框。
 */
export function validateHeaderTemplates(raw: unknown): HeaderTemplateCheck {
  if (raw === undefined || raw === null) return { ok: true, templates: [] };
  if (!Array.isArray(raw)) {
    return { ok: false, code: PLATFORM_HEADERS_INVALID, message: "头模板必须是一个列表" };
  }
  if (raw.length > MAX_HEADER_TEMPLATES) {
    return {
      ok: false,
      code: "PLATFORM_HEADERS_TOO_MANY",
      message: `头模板最多 ${MAX_HEADER_TEMPLATES} 条，当前 ${raw.length} 条`,
    };
  }
  const templates: HeaderTemplate[] = [];
  for (let i = 0; i < raw.length; i++) {
    const at = i + 1;
    const item = raw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, code: "PLATFORM_HEADERS_INVALID", message: `第 ${at} 条头模板不是对象` };
    }
    const name = (item as { name?: unknown }).name;
    const value = (item as { value?: unknown }).value;
    if (typeof name !== "string" || !name) {
      return { ok: false, code: "PLATFORM_HEADERS_NAME_EMPTY", message: `第 ${at} 条头模板的名字为空` };
    }
    if (!TOKEN.test(name)) {
      return {
        ok: false,
        code: "PLATFORM_HEADERS_NAME_INVALID",
        message: `第 ${at} 条头模板的名字「${name}」不是合法的 RFC 7230 token（不能有空格、冒号或中文）`,
      };
    }
    if (typeof value !== "string" || !value) {
      return { ok: false, code: "PLATFORM_HEADERS_VALUE_EMPTY", message: `第 ${at} 条头模板（${name}）的值为空` };
    }
    if (/[\r\n]/.test(value)) {
      return {
        ok: false,
        code: "PLATFORM_HEADERS_VALUE_INVALID",
        message: `第 ${at} 条头模板（${name}）的值含换行符`,
      };
    }
    if (value.length > MAX_HEADER_TEMPLATE_VALUE) {
      return {
        ok: false,
        code: "PLATFORM_HEADERS_VALUE_TOO_LONG",
        message: `第 ${at} 条头模板（${name}）的值超过 ${MAX_HEADER_TEMPLATE_VALUE} 字符`,
      };
    }
    // 其它 {...} 不校验：它是字面量，原样发。
    templates.push({ name, value });
  }
  return { ok: true, templates };
}

/** 这一条的值里有没有会话占位符。 */
export function usesSession(template: HeaderTemplate): boolean {
  return template.value.includes(SESSION_PLACEHOLDER);
}

/**
 * 渲染一整份模板，顺序不变。
 *
 * sessionId 为 null 时占位符原样留着 —— 注入路径在渲染之前已经拦下了「取不到会话」
 * 的情况，这里不替它做决定。用 split/join 而不是 replace：会话 id 里的连字符、
 * 反斜杠、$ 都是普通字符，不能被当成替换语法。
 */
export function renderHeaderTemplates(
  templates: readonly HeaderTemplate[],
  sessionId: string | null,
): HeaderTemplate[] {
  return templates.map((template) => ({
    name: template.name,
    value: sessionId === null
      ? template.value
      : template.value.split(SESSION_PLACEHOLDER).join(sessionId),
  }));
}

/** 库里那一列（JSON）读成模板列表。坏数据当空，不让一行写坏拖垮整个平台。 */
export function parseStoredHeaders(raw: unknown): HeaderTemplate[] {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const out: HeaderTemplate[] = [];
  for (const item of parsed) {
    const name = (item as { name?: unknown } | null)?.name;
    const value = (item as { value?: unknown } | null)?.value;
    if (typeof name === "string" && typeof value === "string") out.push({ name, value });
  }
  return out;
}

/** 模板列表写成库里那一列的 JSON。 */
export function serializeHeaders(templates: readonly HeaderTemplate[]): string {
  return JSON.stringify(templates.map((t) => ({ name: t.name, value: t.value })));
}

/**
 * 取不到会话时的 400 正文：说清是哪个平台、哪个头、试过哪些来源、怎么配。
 *
 * 来源只列类别，不编具体头名 —— 内置头清单与 body 字段归 lib/session-id.ts 定，
 * 在这里抄一份就会随那一边改而失真。全局设置的名字 SESSION_HEADER 是派单钉死的。
 */
export function missingSessionMessage(label: string, headerName: string): string {
  return (
    `平台「${label}」的头 ${headerName} 需要会话标识，但这次请求里取不到。` +
    `已试过：内置会话头、全局设置 SESSION_HEADER 指定的头、请求体里的会话字段。` +
    `请在客户端带上会话头，或配置 SESSION_HEADER；` +
    `也可以把这个头模板里的 ${SESSION_PLACEHOLDER} 去掉，改成固定值。`
  );
}
