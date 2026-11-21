// lib/router/session-key.ts — which session a request belongs to.
//
// The `balance` strategy keeps every session on one upstream target so the
// upstream's prompt cache keeps hitting. That only works when each request
// carries something that names its session. The clients spell that differently
// — Claude Code, pi, OpenAI SDKs each have their own header — so the lookup is
// a fixed chain: headers first, then the body. A custom header (the
// SESSION_HEADER setting) is appended at the end of the header part, never a
// replacement: a built-in header that is present always wins.
//
// The full session id belongs to the client; logs only see the source and a
// short hash, never the id itself.

import { createHash } from "node:crypto";
import { configString } from "../config.ts";
import type { Json } from "../json.ts";

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

/** The headers this request was actually searched in — the 400 body lists them. */
export function sessionHeaderNames(): string[] {
  const names = [...SESSION_HEADERS];
  for (const name of customHeaderNames()) {
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

/**
 * The session this request belongs to, or null when nothing in it names one.
 *
 * Headers first (the chain above, the custom one last), then the body:
 * `prompt_cache_key`, then `metadata.user_id` — which is either a JSON string
 * with a `session_id` inside or the older `..._session_<uuid>` shape.
 */
export function extractSessionKey(headers: Record<string, unknown>, body: Json): SessionKey | null {
  for (const name of sessionHeaderNames()) {
    const id = clean(headerOf(headers, name));
    if (id) return { id, source: `header:${name}` };
  }
  const cacheKey = clean(body.prompt_cache_key);
  if (cacheKey) return { id: cacheKey, source: "body:prompt_cache_key" };
  const fromMetadata = userIdSession(body.metadata);
  if (fromMetadata) return { id: fromMetadata, source: "body:metadata.user_id" };
  return null;
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
