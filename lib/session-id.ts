// lib/session-id.ts — which session a request belongs to.
//
// A leaf module on purpose: it is used from two directions — the router keeps
// every `balance` session on one upstream target, and the forwarding layer
// (lib/agent.ts's open-platform path) uses it to fill the session header an
// upstream demands. Neither of those may be imported here, or the forwarding
// layer drags the router in. Only lib/config.ts and node:crypto.
//
// The clients spell the session differently — Claude Code, pi, OpenAI SDKs
// each have their own header — so the lookup is a fixed chain: headers first,
// then the body. A custom header (the SESSION_HEADER setting) is appended at
// the end of the header part, never a replacement: a built-in header that is
// present always wins.
//
// The full session id belongs to the client; logs only see the source and a
// short hash, never the id itself.

import { createHash } from "node:crypto";
import { configString } from "./config.ts";
import type { Json } from "./json.ts";

/** A session id found in a request, and where it was found. */
export interface SessionKey {
  /** The id itself. Never logged in full. */
  id: string;
  /** Where it came from, e.g. `header:x-claude-code-session-id` or `body:prompt_cache_key`. */
  source: string;
}

/** The built-in headers, most specific first. */
export const SESSION_HEADERS: readonly string[] = [
  "x-claude-code-session-id",
  "session-id",
  "session_id",
  "x-session-id",
  "x-session-affinity",
  "x-client-request-id",
];

/**
 * Pure lookup: the headers, the body, and the custom header names to try
 * after the built-ins (the parsed SESSION_HEADER setting; empty array means
 * none). Callers that want the process setting use extractSessionKey below.
 */
export function sessionIdFrom(
  headers: Record<string, unknown>,
  body: Json,
  customHeaders: readonly string[] = [],
): SessionKey | null {
  for (const name of headerChain(customHeaders)) {
    const id = clean(headerOf(headers, name));
    if (id) return { id, source: `header:${name}` };
  }
  const cacheKey = clean(body.prompt_cache_key);
  if (cacheKey) return { id: cacheKey, source: "body:prompt_cache_key" };
  const fromMetadata = userIdSession(body.metadata);
  if (fromMetadata) return { id: fromMetadata, source: "body:metadata.user_id" };
  return null;
}

/** The wrapper the router uses: the custom headers come from the setting. */
export function extractSessionKey(headers: Record<string, unknown>, body: Json): SessionKey | null {
  return sessionIdFrom(headers, body, customHeaderNames());
}

/** Every header this request is searched in — the 400 body lists them. */
export function sessionHeaderNames(customHeaders: readonly string[] = customHeaderNames()): string[] {
  return headerChain(customHeaders);
}

/**
 * The header chain: the built-ins first, then the custom ones (appended, not
 * replacing), a name the request can actually use only once.
 */
function headerChain(customHeaders: readonly string[]): string[] {
  const names = [...SESSION_HEADERS];
  for (const name of customHeaders) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The SESSION_HEADER setting: one header name, or several comma-separated.
 * Empty means "no custom header". A name that fails the hygiene rules below
 * is ignored — a broken setting must not turn into a broken request.
 */
function customHeaderNames(): string[] {
  return configString("SESSION_HEADER", "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => clean(name) !== null);
}

/** Headers of the request, lowercase for a case-insensitive lookup. */
function headerOf(headers: Record<string, unknown>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return value.find((part) => typeof part === "string");
    return undefined;
  }
  return undefined;
}

/**
 * A usable id, or nothing. An empty one, a blank one, one over 256 characters
 * or one with control characters is not an id — it is treated as "this source
 * had nothing", so the chain goes on instead of the request being rejected or
 * silently cut.
 */
function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > 256) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(id)) return null;
  return id;
}

/** The session id inside metadata.user_id, when it carries one. */
function userIdSession(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) return null;
  const userId = (metadata as Record<string, unknown>).user_id;
  if (typeof userId !== "string") return null;
  const trimmed = userId.trim();
  if (!trimmed) return null;
  // Shape 1: a JSON document with a session_id field inside.
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        return clean((parsed as Record<string, unknown>).session_id);
      }
      return null;
    } catch {
      return null;
    }
  }
  // Shape 2: the older `..._session_<uuid>` suffix. The last segment wins.
  const marker = trimmed.lastIndexOf("_session_");
  if (marker === -1) return null;
  return clean(trimmed.slice(marker + "_session_".length));
}

/**
 * What the log says about a session: the source and a 8-character hash —
 * enough to tell two sessions apart, never the id itself.
 */
export function sessionKeyFingerprint(key: SessionKey): string {
  const hash = createHash("sha256").update(key.id).digest("hex").slice(0, 8);
  return `${key.source} len=${key.id.length} hash=${hash}`;
}
