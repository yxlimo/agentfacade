// lib/admin/service.ts — 管理接口的 33 个方法。
//
// 数据都从已有的地方取：配置在 lib/config.ts，公布的模型在 lib/aggregate.ts，
// 权益在 lib/benefits.ts，凭据与余额在 lib/admin/accounts.ts 与
// lib/admin/upstreams.ts，用量在 lib/admin/usage.ts。这里只做一件事：把它们
// 摆成契约里的形状。
//
// 契约在 proto/agentfacade/admin/v1/admin.proto，生成物在 lib/gen/。改契约之后跑
// `mise run proto` 重新生成，这里跟着改。

import { log } from "../log.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  AccountSchema,
  AdminService,
  BalanceLotSchema,
  AddAccountResponseSchema,
  AddPlatformResponseSchema,
  BalanceSummarySchema,
  BeginLoginResponseSchema,
  BenefitStatusSchema,
  CancelLoginResponseSchema,
  CatalogModelSchema,
  CheckinState,
  ConfigItemSchema,
  CredentialSchema,
  CredentialStatusSchema,
  CreditLotSchema,
  CreditSummarySchema,
  DeleteAccountResponseSchema,
  DeletePlatformResponseSchema,
  DeletePublishedModelResponseSchema,
  ExchangeLoginCodeResponseSchema,
  GetBalanceResponseSchema,
  GetBenefitStatusResponseSchema,
  GetLoginStatusResponseSchema,
  GetSystemStatusResponseSchema,
  GetUsageSummaryResponseSchema,
  ImportLoginTokenResponseSchema,
  ListAccountsResponseSchema,
  ListConfigResponseSchema,
  CredentialFieldSchema,
  ListProviderKindsResponseSchema,
  ProviderKindSchema,
  ListCredentialsResponseSchema,
  ListModelsResponseSchema,
  ListPublishedModelsResponseSchema,
  ListQuotaPluginsResponseSchema,
  QuotaPluginPlatformSchema,
  ListPlatformKindsResponseSchema,
  ListModelOverridesResponseSchema,
  EffortListSchema,
  SetModelOverridesResponseSchema,
  DeleteModelOverrideResponseSchema,
  ModelOverrideSchema,
  ModelBillingSchema,
  PlatformKindSchema,
  ListUpstreamsResponseSchema,
  ListUsageEventsResponseSchema,  LoginSessionSchema,
  LoginWithPasswordResponseSchema,
  PublishedModelSchema,
  ModelMetadataSchema,
  OpenPlatformSchema,
  PublishedTargetSchema,
  QuotaPluginFieldSchema,
  QuotaPluginSchema,
  RefreshCredentialResponseSchema,
  RefreshPlatformModelsResponseSchema,
  SetProviderKeysResponseSchema,
  RestartSystemResponseSchema,
  RunBenefitNowResponseSchema,
  SavePublishedModelResponseSchema,
  SetConfigResponseSchema,
  SetPlatformPolicyResponseSchema,
  SetAccountEnabledResponseSchema,
  TailLogResponseSchema,
  TestCredentialResponseSchema,
  LogoutAccountResponseSchema,
  UpdatePlatformResponseSchema,
  UpdateProviderResponseSchema,
  TokenPlanSchema,
  TokenPlanWindowSchema,
  UpstreamQuotaSchema,
  UpstreamSchema,
  type UpstreamQuota,
  type ModelOverride,
  UsageBucketSchema,
  UsageEventSchema,
  UsageSummarySchema,
} from "../gen/agentfacade/admin/v1/admin_pb.ts";
import { adminTokenSet } from "./token.ts";
// 计费的形状在 lib/catalog-billing.ts 一处定：这一层只把它摆成契约里的样子。
import type { ModelBilling } from "../catalog-billing.ts";
import { configItems, knownConfigKeys, pendingRestart, setConfigValue } from "./config.ts";
import {
  freshHealthSnapshot,
  healthSnapshot,
  setAccountEnabled,
  upstreamQuota,
  upstreamQuotas,
  upstreamAccountCount,
  upstreamBaseUrl,
  upstreamCredential,
  upstreamCredentialOf,
  upstreamModelCount,
  upstreamPolicy,
  upstreamRegion,
  upstreamState,
  upstreamStateOf,
  upstreamCooling,
  claimableAccounts,
  claimableLabel,
  type HealthSnapshot,
  type QuotaView,
  type UpstreamId,
} from "./upstreams.ts";
import { platformAvailabilities, type PlatformAvailability } from "./platform-state.ts";
import { adminError } from "./error-codes.ts";
import { coolingOf } from "./upstream-state.ts";
import {
  deleteAccount,
  listAccounts,
  listCredentials,
  logoutAccount,
  refreshCredential,
  testCredential,
  type AccountView,
} from "./accounts.ts";
import { credentialStateText, setProviderKeys } from "./credentials.ts";
import {
  beginLogin,
  cancelLogin,
  exchangeLoginCode,
  getLoginStatus,
  importLoginToken,
  loginWithPassword,
  type StoredLogin,
} from "./login.ts";
import { catalogModels, deletePublishedModel, publishedModels, savePublishedModel } from "./models.ts";
import {
  deleteModelOverride,
  forgetPlatformModelOverrides,
  listModelOverrides,
  upsertModelOverrides,
  type ModelOverrideRow,
} from "../model-overrides.ts";
import {
  accountsOfPlatform,
  addAccount,
  listProviders,
  provider,
  updateProvider,
  type ProviderRow,
} from "../providers.ts";
import {
  createOpenPlatform,
  deleteOpenPlatform,
  listOpenPlatforms,
  openPlatformOf,
  updateOpenPlatform,
  type OpenPlatformRow,
} from "../open-platforms.ts";
import { refreshOpenPlatformCatalog } from "../open-platform-catalog.ts";
import { forgetUpstreamSessions } from "../upstream-session.ts";
import { breakerPanelState } from "../upstream-breaker.ts";
import { isSimulatedClientKind, platformKindChoices } from "../platform-catalog.ts";
import { allQuotaPlugins } from "../quota-plugin-registry.ts";
import { quotaConclusionOf, quotaPluginIdOf, quotaPluginOfAccount, type QuotaConclusion } from "../quota-state.ts";
import { peekHealthSnapshot } from "../health-cache.ts";
import { listAggregateModels } from "../aggregate.ts";
import {
  allPlatforms,
  forgetPlatformPolicy,
  isPlatform,
  platformOfAny,
  platformPolicies,
  setPlatformPolicy as writePlatformPolicy,
  type Platform,
} from "../platforms.ts";
import { kindOf, selectableKinds } from "../provider-kinds.ts";
import { policyEnum, policyErrorText, policyFromEnum } from "./policy.ts";
import { usageEvents, usageSummary, type UsageTotals } from "./usage.ts";
import { tailLog } from "./log.ts";
import { benefits, platformHasBenefits } from "./benefits.ts";
import { claimZcodePlan, getZcodeClaimStatus } from "./zcode-claim.ts";

// 视图函数分在 lib/admin/service/ 下：shared（小工具）、quota-view、account-view、
// platform-view、model-view。这里只把它们摆进契约的方法里。
import { givenBool, givenText, serviceVersion, usageBucketMessage, usageSummaryMessage } from "./service/shared.ts";
import { modelBillingMessage, modelOverrideMessage, modelOverrideRow } from "./service/model-view.ts";
import { balanceScope, conclusionOfRow, quotaAnswerOf, quotaMessage } from "./service/quota-view.ts";
import { accountMessage, credentialMessage, loginErrorText, loginSessionMessage } from "./service/account-view.ts";
import { platformMethods } from "./service/platforms.ts";
import { platformKindMethods } from "./service/platform-kinds.ts";
import { systemMethods } from "./service/system.ts";
import { accountMethods } from "./service/accounts.ts";
import { credentialMethods } from "./service/credentials.ts";
import { loginMethods } from "./service/login.ts";
import { modelMethods } from "./service/models.ts";
import { usageMethods } from "./service/usage.ts";
import { balanceMethods } from "./service/balance.ts";

export { quotaMessage };
/** 管理接口的实现。 */
/** 管理接口的实现。分片按域组合：system / platforms / platform-kinds 在这里，
 * 其余方法仍在下面的字面量里，随拆分提交逐步搬出。 */
export const adminService: Partial<ServiceImpl<typeof AdminService>> = {
  ...systemMethods,
  ...platformMethods,
  ...platformKindMethods,
  ...accountMethods,
  ...credentialMethods,
  ...loginMethods,
  ...modelMethods,
  ...usageMethods,
  ...balanceMethods,









  /* ---------------- 每日权益 ---------------- */

  async getBenefitStatus() {
    const state = benefits.lastRun;
    // 只有「签得到」的账号才进答复：平台那一种类没登记签到的（第三方开放
    // 平台那一族），在签到页上不占位置。判据在 lib/admin/benefits.ts 的
    // platformHasBenefits —— 前端不自己判种类。
    const accounts = listProviders().filter((row) => platformHasBenefits(row.platform));
    const benefitsOut = accounts.map((row) => {
      const accountId = row.id;
      // 签到是账号的事，但面板按平台分组展示：upstreamId 填账号所属的平台，
      // accountId 填账号本身，两者不能混（面板拿 upstreamId 去 join 平台行）。
      const platform = row.platform;
      const outcome = state.lastOutcome?.find((o) => o.upstream === accountId);
      if (!outcome) {
        // 没问过：今天签没签是「不知道」，不是「还没签」。
        return create(BenefitStatusSchema, {
          upstreamId: platform,
          accountId,
          summary: "今日签到状态未知",
          lines: [],
          checkedAt: 0n,
          credits: 0,
          ok: false,
          checkinState: CheckinState.UNKNOWN,
        });
      }
      // The summary is what the panel shows on the line: what happened, in
      // one line. Six answers, in this order: it did not work; the platform
      // does not tell us the check-in's state; the platform has no daily
      // check-in at all; it worked and brought credits; it worked (the
      // credits came earlier today); today it is not signed in.
      //
      // "Already claimed" is not one of them: that is an internal wording
      // and it belongs in the details (lines), not in the summary.
      //
      // The state is separate from the wording: the panel decides what to
      // show from the state, never by parsing this sentence.
      const summary = !outcome.ok
        ? "签到未成功"
        : outcome.statusUnavailable
          ? "今日签到状态未知"
          : outcome.noDailyCheckin
            ? "今日无签到"
            : outcome.signedIn && outcome.credits > 0
              ? `今日已签到 +${outcome.credits}`
              : outcome.signedIn
                ? "今日已签到"
                : "今日尚未签到";
      // The check-in itself decides the state, not the credits: a sign-in
      // that hands out nothing is still a sign-in. A run that did not get an
      // answer (network error, upstream blew up) leaves today's state unknown:
      // "we could not ask" is not "not signed yet".
      const checkinState = !outcome.ok
        ? CheckinState.UNKNOWN
        : outcome.statusUnavailable
          ? CheckinState.UNKNOWN
          : outcome.noDailyCheckin
            ? CheckinState.NOT_SIGNED
            : outcome.signedIn
              ? CheckinState.SIGNED
              : CheckinState.NOT_SIGNED;
      return create(BenefitStatusSchema, {
        upstreamId: platform,
        accountId,
        summary,
        lines: outcome.report,
        checkedAt: BigInt(Date.parse(outcome.at) || 0),
        credits: outcome.credits,
        ok: outcome.ok,
        checkinState,
      });
    });
    return create(GetBenefitStatusResponseSchema, { benefits: benefitsOut });
  },

  async runBenefitNow() {
    await benefits.runOnce();
    const outcomes = benefits.lastRun.lastOutcome ?? [];
    return create(RunBenefitNowResponseSchema, {
      ok: outcomes.length > 0 && outcomes.every((o) => o.ok),
      lines: outcomes.flatMap((o) => [`[${o.upstream}] ${o.report.join("；")}`]),
    });
  },

  /* ---------------- ZCode 的活动额度领取 ---------------- */

  async getZcodeClaimStatus(request) {
    return getZcodeClaimStatus(String(request.providerId ?? ""));
  },

  async claimZcodePlan(request) {
    return claimZcodePlan({
      accountId: String(request.providerId ?? ""),
      planId: String(request.planId ?? ""),
      campaignId: String(request.campaignId ?? ""),
      captchaVerifyParam: String(request.captchaVerifyParam ?? ""),
      captchaRegion: String(request.captchaRegion ?? ""),
    });
  },



};
