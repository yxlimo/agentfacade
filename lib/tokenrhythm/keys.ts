// lib/tokenrhythm/keys.ts — the inference keys of an account.
//
// The platform keeps two things apart: the session, which reads the wallet,
// and the key, which calls the models. A key is only shown in full once, in
// the answer that creates it, so the list is all masked.
//
// The inference key an account uses is the user's to fill in from the panel
// (the open-platform write path): the gateway does not build one. A key it
// built would be one the user never sees and can never replace.
//
// Creating a key is a write, and a write is checked: the session cookie, the
// CSRF token sent twice, and the browser's fetch metadata. The headers for
// that are in lib/tokenrhythm/accounts.ts.

import { platformApi } from "./platform.ts";
import type { TokenRhythmSession } from "./accounts.ts";

export interface TokenRhythmApiKey {
  id: string;
  name: string;
  /** The key with its middle hidden — this is all the list ever shows. */
  maskedKey: string;
  keyPrefix: string;
  status: string;
  lastUsedAt: string | null;
  createdAt: string | null;
  /** Only in the answer that creates the key. */
  key?: string;
}

const toKey = (row: any): TokenRhythmApiKey => ({
  id: String(row?.id ?? ""),
  name: String(row?.name ?? ""),
  maskedKey: String(row?.maskedKey ?? ""),
  keyPrefix: String(row?.keyPrefix ?? ""),
  status: String(row?.status ?? ""),
  lastUsedAt: row?.lastUsedAt ?? null,
  createdAt: row?.createdAt ?? null,
  key: row?.key ? String(row.key) : undefined,
});

/** Every key of the account, masked. */
export async function listApiKeys(session: TokenRhythmSession): Promise<TokenRhythmApiKey[]> {
  const data = await platformApi<any>("/api/api-keys", session);
  return (Array.isArray(data) ? data : []).map(toKey);
}

/**
 * Make a key.
 *
 * The full key is in the answer and nowhere else — the list only shows it
 * masked — so the caller has to keep it.
 */
export async function createApiKey(
  session: TokenRhythmSession,
  name: string,
): Promise<TokenRhythmApiKey> {
  const data = await platformApi<any>("/api/api-keys", session, { method: "POST", body: { name } });
  return toKey(data);
}

/** Remove a key. */
export async function deleteApiKey(session: TokenRhythmSession, id: string): Promise<void> {
  await platformApi<any>(`/api/api-keys/${encodeURIComponent(id)}/delete`, session, {
    method: "POST",
    body: {},
  });
}

/**
 * Stop a key from being used, without throwing it away.
 *
 * 面板还没做 key 管理：这一族接口是前瞻代码，现在只有网关自己与探针在用。
 */
export async function disableApiKey(session: TokenRhythmSession, id: string): Promise<void> {
  await platformApi<any>(`/api/api-keys/${encodeURIComponent(id)}/disable`, session, {
    method: "POST",
    body: {},
  });
}

/** Make a disabled key usable again. */
export async function enableApiKey(session: TokenRhythmSession, id: string): Promise<void> {
  await platformApi<any>(`/api/api-keys/${encodeURIComponent(id)}/enable`, session, {
    method: "POST",
    body: {},
  });
}
