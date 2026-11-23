// lib/admin/service/credentials.ts — 凭据的方法分片。
//
// 从 service.ts 原样搬来：listCredentials、testCredential、logoutAccount、
// setProviderKeys、refreshCredential。凭据只给掩码与指纹，完整令牌不进门面。

import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  AdminService,
  ListCredentialsResponseSchema,
  CredentialSchema,
  LogoutAccountResponseSchema,
  RefreshCredentialResponseSchema,
  SetProviderKeysResponseSchema,
  TestCredentialResponseSchema,
} from "../../gen/agentfacade/admin/v1/admin_pb.ts";
import { log } from "../../log.ts";
import { adminError } from "../error-codes.ts";
import { listCredentials, logoutAccount, refreshCredential, testCredential } from "../accounts.ts";
import { credentialStateText, setProviderKeys } from "../credentials.ts";

export const credentialMethods: Partial<ServiceImpl<typeof AdminService>> = {
  async listCredentials(request) {
    const accountId = String(request.accountId ?? "");
    return create(ListCredentialsResponseSchema, {
      credentials: listCredentials(accountId).map((row) =>
        create(CredentialSchema, {
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
        }),
      ),
    });
  },

  async testCredential(request) {
    const id = String(request.credentialId ?? "");
    const result = await testCredential(id);
    return create(TestCredentialResponseSchema, {
      ok: result.ok,
      message: result.message,
      checkedAt: BigInt(Date.now()),
    });
  },

  async logoutAccount(request) {
    const accountId = String(request.accountId ?? "");
    const result = logoutAccount(accountId);
    return create(LogoutAccountResponseSchema, {
      ok: result.ok,
      message: result.message,
      removed: result.removed,
    });
  },

  async setProviderKeys(request) {
    const upstreamId = String(request.upstreamId ?? "");
    // 位置有意义（七牛的凭据是两段：推理 key 与门户 cookie），空串留着占位。
    // 各分支自己决定怎么处理空串。
    const keys = (request.keys ?? []).map((k) => String(k).trim());
    const result = setProviderKeys(upstreamId, keys);
    if (!result.ok) throw adminError(result.code, result.message);
    log.info(`[ADMIN] 账号 ${upstreamId} 的凭据：${result.message}`);
    return create(SetProviderKeysResponseSchema, { count: result.count });
  },

  async refreshCredential(request) {
    const id = String(request.credentialId ?? "");
    const result = await refreshCredential(id);
    return create(RefreshCredentialResponseSchema, {
      ok: result.ok,
      message: result.message,
      generation: result.generation,
    });
  },
};
