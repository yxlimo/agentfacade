// lib/admin/service/account-view.ts — 账号、凭据与登录会话，面板看的形状。
//
// 从 service.ts 上半原样搬来。账号视图的凭据与状态由调用方算好传进来：账号行
// 自己再去读一遍凭据的话，面板打开一次就是 O(N²) 次读库。

import { create } from "@bufbuild/protobuf";
import { AccountSchema, CredentialSchema, CredentialStatusSchema, LoginSessionSchema } from "../../gen/agentfacade/admin/v1/admin_pb.ts";
import { listAccounts, listCredentials, type AccountView } from "../accounts.ts";
import { credentialStateText } from "../credentials.ts";
import { type StoredLogin } from "../login.ts";
import { upstreamQuota } from "../upstreams.ts";
import { coolingOf } from "../upstream-state.ts";
import { provider } from "../../providers.ts";
import { quotaAnswerOf } from "./quota-view.ts";

/** 一次登录会话，面板看的形状。 */
export function loginSessionMessage(session: StoredLogin) {
  return create(LoginSessionSchema, {
    loginId: session.loginId,
    upstreamId: session.upstreamId,
    accountId: session.accountId,
    status: session.status,
    method: session.method,
    authorizationUrl: session.authorizationUrl,
    userCode: session.userCode,
    expiresAt: BigInt(session.expiresAt),
    message: session.message,
    credential: session.credentialId ? credentialStatusMessage(session.credentialId) : undefined,
    username: session.username,
  });
}

/** 一条凭据的状态摘要。 */
export function credentialStatusMessage(credentialId: string) {
  const row = listCredentials().find((c) => c.id === credentialId);
  if (!row) return undefined;
  return create(CredentialStatusSchema, {
    kind: row.kind,
    status: row.status,
    fingerprint: row.fingerprint,
    expiresAt: BigInt(row.expiresAt),
    remainingSec: BigInt(Math.max(0, Math.round((row.expiresAt - Date.now()) / 1000))),
    warning: row.expiresAt > 0 && row.expiresAt - Date.now() < 7 * 24 * 3600 * 1000,
    detail: row.label,
    generation: row.generation,
  });
}

/** 一个账号，面板看的形状。 */
export function accountMessage(accountId: string) {
  if (!accountId) return undefined;
  const row = listAccounts().find((a) => a.id === accountId);
  return row ? accountRowMessage(row) : undefined;
}

/**
 * 一个账号行，面板看的形状。
 *
 * 账号视图（凭据、状态）由调用方算好传进来：账号行自己再去读一遍凭据的话，
 * 一个平台下的每个账号都要把全部账号的凭据重读一遍 —— 面板打开一次就是
 * O(N²) 次读库。
 */
export function accountRowMessage(row: AccountView) {
  // 额度是**这个账号自己的**：平台行上那个是名下账号合起来的，账号行上要
  // 看得见自己那份（两个 MiniMax 账号各有各的套餐）。
  const quota = upstreamQuota(row.id);
  // 冷却也是这个账号自己的：面板要能看出是哪一个账号被绕开了。
  const cooling = coolingOf(row.id);
  return create(AccountSchema, {
    id: row.id,
    // 它属于哪个平台。路径里用平台 id，不用账号 id。
    platform: row.platform,
    alias: row.alias,
    status: credentialStateText(row.status),
    credentialCount: row.credentialCount,
    detail: row.detail,
    enabled: row.enabled,
    // 权重：大的先试。面板上让人调。
    weight: row.weight,
    createdAt: BigInt(row.createdAt),
    quota: quotaAnswerOf(quota, provider(row.id)),
    cooldownUntilMs: BigInt(cooling.untilMs),
    cooldownReason: cooling.reason,
  });
}

/** 一条凭据，面板看的形状。 */
export function credentialMessage(credentialId: string) {
  if (!credentialId) return undefined;
  const row = listCredentials().find((c) => c.id === credentialId);
  if (!row) return undefined;
  return create(CredentialSchema, {
    id: row.id,
    accountId: row.accountId,
    upstreamId: row.platform,
    kind: row.kind,
    label: row.label,
    masked: row.masked,
    fingerprint: row.fingerprint,
    status: credentialStateText(row.status),
    generation: row.generation,
    expiresAt: BigInt(row.expiresAt),
    lastOkAt: BigInt(row.lastOkAt),
    lastError: row.lastError,
    updatedAt: BigInt(row.updatedAt),
  });
}

/** 登录的错误怎么变成面板上的话。 */
export function loginErrorText(e: unknown): string {
  const err = e as { hint?: string; message?: string };
  const hint = err?.hint ?? "";
  const code = err?.message ?? "";
  if (hint && code && !hint.includes(code)) return `${hint}（${code}）`;
  return hint || code || "登录未成功。";
}
