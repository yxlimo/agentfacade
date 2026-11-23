// lib/admin/service/accounts.ts — 账号的增删改与列表的方法分片。
//
// 从 service.ts 原样搬来：addAccount、updateProvider、deleteAccount、
// setAccountEnabled、listAccounts。校验在下层（lib/providers.ts、lib/admin/accounts.ts），
// 这里只摆形状、记日志。

import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  AccountSchema,
  AddAccountResponseSchema,
  AdminService,
  DeleteAccountResponseSchema,
  ListAccountsResponseSchema,
  SetAccountEnabledResponseSchema,
  UpdateProviderResponseSchema,
} from "../../gen/agentfacade/admin/v1/admin_pb.ts";
import { log } from "../../log.ts";
import { adminError } from "../error-codes.ts";
import { addAccount, updateProvider } from "../../providers.ts";
import { deleteAccount, listAccounts } from "../accounts.ts";
import { credentialStateText } from "../credentials.ts";
import { pendingRestart } from "../config.ts";
import { setAccountEnabled, upstreamQuotas, type QuotaView, type UpstreamId } from "../upstreams.ts";
import { listProviders, type ProviderRow } from "../../providers.ts";
import { quotaAnswerOf } from "./quota-view.ts";

export const accountMethods: Partial<ServiceImpl<typeof AdminService>> = {
  async addAccount(request) {
    const result = addAccount({
      platform: String(request.platform ?? ""),
      alias: String(request.alias ?? ""),
    });
    if (!result.ok) throw adminError(result.code, result.message);
    log.info(`[ADMIN] 在 ${request.platform} 下加了账号 ${result.id}`);
    return create(AddAccountResponseSchema, { id: result.id ?? "" });
  },

  async updateProvider(request) {
    // 别名与开关。策略不在这里：契约里的 alias 是普通 proto3 string，没有
    // presence 位，混在一起的话「只改策略」会把别名顺手抹掉。
    const patch: { alias?: string; enabled?: boolean; weight?: number } = {};
    if (request.alias !== undefined) patch.alias = String(request.alias);
    if (request.enabled !== undefined && request.enabled !== null) patch.enabled = request.enabled === true;
    if (request.weight !== undefined && request.weight !== null) patch.weight = Number(request.weight);
    const result = updateProvider(String(request.id ?? ""), patch);
    if (result.ok) log.info(`[ADMIN] 账号 ${request.id} 改了`);
    return create(UpdateProviderResponseSchema, { ok: result.ok, message: result.message });
  },

  async deleteAccount(request) {
    const id = String(request.id ?? "");
    const result = deleteAccount(id);
    if (result.ok) {
      log.info(`[ADMIN] 删了账号 ${id}（连它的凭据一起）`);
    }
    return create(DeleteAccountResponseSchema, { ok: result.ok, message: result.message });
  },

  async setAccountEnabled(request) {
    const id = String(request.accountId ?? "") as UpstreamId;
    const result = setAccountEnabled(id, request.enabled === true);
    log.info(`[ADMIN] 账号 ${id} 改成 ${request.enabled ? "true" : "false"}（立刻生效）`);
    return create(SetAccountEnabledResponseSchema, {
      ok: result.ok,
      pendingRestart: pendingRestart(),
      message: result.message,
    });
  },

  async listAccounts() {
    const accounts = listAccounts();
    // 每个账号的额度。额度在快照里，这里不现问上游（那是 GetBalance 的事）。
    const quotas = new Map<string, QuotaView>();
    // 额度结论要的是账号行（插件从平台那一行读），顺手把它们存下来。
    const rows = new Map<string, ProviderRow>();
    for (const row of listProviders()) {
      const id = row.id;
      rows.set(id, row);
      for (const quota of await upstreamQuotas(id)) {
        quotas.set(quota.accountId, quota);
      }
    }
    return create(ListAccountsResponseSchema, {
      accounts: accounts.map((account) => {
        const quota = quotas.get(account.id);
        return create(AccountSchema, {
          id: account.id,
          // 账号属于哪个平台。路径里用平台 id，不用账号 id。
          platform: account.platform,
          alias: account.alias,
          status: credentialStateText(account.status),
          credentialCount: account.credentialCount,
          detail: account.detail,
          enabled: account.enabled,
          createdAt: BigInt(account.createdAt),
          quota: quotaAnswerOf(quota ?? null, rows.get(account.id) ?? null),
        });
      }),
    });
  },
};
