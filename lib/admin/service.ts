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


  /* ---------------- 模型的人工元数据 ---------------- */

  async listModelOverrides(request) {
    // 平台不存在就是空列表，不报错：面板刚删完一个平台时还会问一下。
    return create(ListModelOverridesResponseSchema, {
      overrides: listModelOverrides(String(request.platformId ?? "")).map(modelOverrideMessage),
    });
  },

  async setModelOverrides(request) {
    // 走契约解码时这一格一定是列表；别处（脚本、手写的请求）不一定 —— 不是列表
    // 就说到这里，别让 `.map` 的 TypeError 冒成 500。
    const sent: unknown = request.overrides;
    if (!Array.isArray(sent)) {
      throw adminError("MODEL_OVERRIDE_LIST_INVALID", `overrides is ${typeof sent}, not an array`);
    }
    // 发来的每一条按 id 覆盖，没发来的原封不动：删走 DeleteModelOverride。
    const result = upsertModelOverrides(
      String(request.platformId ?? ""),
      sent.map((one) => modelOverrideRow(one as ModelOverride)),
    );
    if (!result.ok) throw adminError(result.code, result.message);
    log.info(`[ADMIN] ${request.platformId} 的人工模型元数据：${result.message}`);
    return create(SetModelOverridesResponseSchema, {});
  },

  async deleteModelOverride(request) {
    const result = deleteModelOverride(
      String(request.platformId ?? ""),
      String(request.modelId ?? ""),
    );
    if (!result.ok) throw adminError(result.code, result.message);
    log.info(`[ADMIN] ${request.platformId} 的人工模型元数据：${result.message}`);
    return create(DeleteModelOverrideResponseSchema, {});
  },

  /* ---------------- 配置 ---------------- */

  async listConfig() {
    return create(ListConfigResponseSchema, {
      items: configItems().map((item) =>
        create(ConfigItemSchema, {
          key: item.key,
          // 给人看的名字：「Qoder 中国区」。不是 env 的键名。
          label: item.label,
          value: item.value,
          source: item.source,
          fallback: item.fallback,
          group: item.group,
          description: item.description,
          secret: item.secret,
          hasValue: item.hasValue,
        }),
      ),
      pendingRestart: pendingRestart(),
    });
  },

  async setConfig(request) {
    const key = String(request.key ?? "").trim();
    if (!key) {
      return create(SetConfigResponseSchema, { ok: false, pendingRestart: pendingRestart(), message: "需要提供键名" });
    }
    if (!knownConfigKeys().has(key)) {
      return create(SetConfigResponseSchema, {
        ok: false,
        pendingRestart: pendingRestart(),
        message: `无法识别的配置项：${key}`,
      });
    }
    const result = setConfigValue(key, String(request.value ?? ""), request.clear === true);
    log.info(`[ADMIN] 配置 ${key}：${result.message}`);
    return create(SetConfigResponseSchema, {
      ok: result.ok,
      pendingRestart: pendingRestart(),
      message: result.ok ? `${result.message}，已生效` : result.message,
    });
  },

  /* ---------------- 账号与凭据 ---------------- */


  /* ---------------- 额度 ---------------- */

  async getBalance(request) {
    const wanted = String(request.upstreamId ?? "");
    const rows = balanceScope(wanted);
    const quotas: UpstreamQuota[] = [];
    // 已经有数字的账号：下面只给没有数字的那些补一条原因。
    const withNumbers = new Set<string>();
    if (wanted) {
      // 问一个平台：只刷这个平台名下的账号，不碰别人。
      for (const quota of await upstreamQuotas(wanted, true, Boolean(request.force))) {
        const row = rows.find((r) => r.id === quota.accountId) ?? null;
        quotas.push(quotaMessage(quota, conclusionOfRow(row)));
        withNumbers.add(quota.accountId);
      }
    } else {
      // 没指定平台：整轮刷新一次（一次就够），然后从快照里读。
      await freshHealthSnapshot(Boolean(request.force));
      for (const row of rows) {
        for (const quota of await upstreamQuotas(row.id)) {
          quotas.push(quotaMessage(quota, conclusionOfRow(row)));
          withNumbers.add(quota.accountId);
        }
      }
    }
    // 没有数字但有结论的账号也报一条：见底、不能用、凭据被拒、被限流、没填
    // 凭据、问不到 —— 六种都不是 0，面板要看得见状态与那句话，而不是一行零。
    for (const row of rows) {
      if (withNumbers.has(row.id)) continue;
      const answer = quotaAnswerOf(null, row);
      if (answer) quotas.push(answer);
    }
    return create(GetBalanceResponseSchema, { quotas });
  },

  /* ---------------- 用量 ---------------- */

  async getUsageSummary(request) {
    const summary = usageSummary(String(request.upstreamId ?? ""), String(request.window ?? ""));
    return create(GetUsageSummaryResponseSchema, {
      total: usageSummaryMessage(summary.total),
      byUpstream: summary.byUpstream.map((bucket) => usageBucketMessage(bucket)),
      byModel: summary.byModel.map((bucket) => usageBucketMessage(bucket)),
      byDay: summary.byDay.map((bucket) => usageBucketMessage(bucket)),
      byAgent: summary.byAgent.map((bucket) => usageBucketMessage(bucket)),
      bySession: summary.bySession.map((bucket) => usageBucketMessage(bucket)),
      byParentSession: summary.byParentSession.map((bucket) => usageBucketMessage(bucket)),
      byAgentName: summary.byAgentName.map((bucket) => usageBucketMessage(bucket)),
      bySubagent: summary.bySubagent.map((bucket) => usageBucketMessage(bucket)),
    });
  },

  async listUsageEvents(request) {
    const events = usageEvents(
      String(request.upstreamId ?? ""),
      String(request.model ?? ""),
      Number(request.limit ?? 0),
      Number(request.beforeId ?? 0),
      String(request.window ?? ""),
    );
    return create(ListUsageEventsResponseSchema, {
      events: events.map((event) =>
        create(UsageEventSchema, {
          id: BigInt(event.id),
          ts: BigInt(event.ts),
          upstreamId: event.upstreamId,
          model: event.upstreamModel,
          agentModel: event.agentModel,
          agent: event.agent,
          sessionId: event.sessionId,
          parentSessionId: event.parentSessionId,
          agentName: event.agentName,
          client: event.client,
          promptTokens: BigInt(event.promptTokens),
          completionTokens: BigInt(event.completionTokens),
          reasoningTokens: BigInt(event.reasoningTokens),
          latencyMs: BigInt(event.latencyMs),
          // The status is the HTTP code the agent got: 200 for a good answer,
          // the upstream's own code for a failure.
          status: String(event.status),
          error: event.error,
        }),
      ),
    });
  },

  /* ---------------- 公布的模型 ---------------- */

  async listPublishedModels() {
    return create(ListPublishedModelsResponseSchema, {
      models: publishedModels().map((model) =>
        create(PublishedModelSchema, {
          id: model.id,
          displayName: model.displayName,
          enabled: model.enabled,
          // 根路由现在真的公布它吗？判据跟根路由一样。
          published: model.published,
          // 没公布的原因。公布了就是 UNSPECIFIED。
          unpublishedReason: model.unpublishedReason,
          strategy: model.strategy,
          // 继承的字段就是没有（契约里 optional）：客户端原样存回去还是继承。
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          reasoning: model.reasoning,
          toolCall: model.toolCall,
          effortOptions: model.effortOptions,
          // 现算出来的值：面板上显示用，与「库里存的那个」分开。
          effective: create(ModelMetadataSchema, {
            contextWindow: model.effective.contextWindow,
            maxOutputTokens: model.effective.maxOutputTokens,
            reasoning: model.effective.reasoning,
            toolCall: model.effective.toolCall,
            effortOptions: model.effective.effortOptions,
          }),
          updatedAt: BigInt(model.updatedAt),
          targets: model.targets.map((target) =>
            create(PublishedTargetSchema, {
              groupName: target.groupName,
              upstreamModel: target.upstreamModel,
              weight: target.weight,
              enabled: target.enabled,
              requests: BigInt(target.requests),
              failed: BigInt(target.failed),
              // The target the route points at right now: at most one per model.
              current: target.current === true,
              // 为什么接不了，以及什么时候能再接。只读：每次查询现算。
              blocked: target.blocked === true,
              blocker: target.blocker,
              blockerReason: target.blockerReason ?? "",
              recoversAtMs: BigInt(target.recoversAtMs ?? 0),
            }),
          ),
        }),
      ),
    });
  },

  async savePublishedModel(request) {
    const model = request.model;
    if (!model) throw adminError("MODEL_NOT_GIVEN", "request has no model");
    const result = savePublishedModel({
      id: model.id,
      displayName: model.displayName || model.id,
      enabled: model.enabled,
      strategy: model.strategy,
      // 不给就是继承：存 NULL，别把它填死。
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      reasoning: model.reasoning,
      toolCall: model.toolCall,
      effortOptions: [...model.effortOptions],
      targets: model.targets.map((target) => ({
        groupName: target.groupName,
        upstreamModel: target.upstreamModel,
        weight: target.weight,
        enabled: target.enabled,
      })),
    });
    if (!result.ok) {
      log.info(`[MODEL] 保存 ${result.id} 失败：${result.message}`);
      throw adminError(result.code, result.message);
    }
    log.info(`[MODEL] 保存 ${result.id}：${result.message}`);
    return create(SavePublishedModelResponseSchema, { id: result.id });
  },

  async deletePublishedModel(request) {
    const id = String(request.id ?? "");
    const result = deletePublishedModel(id);
    log.info(`[MODEL] 删除 ${id}：${result.message}`);
    return create(DeletePublishedModelResponseSchema, { ok: result.ok, message: result.message });
  },

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

  /* ---------------- 目录与日志 ---------------- */

  async listModels(request) {
    const models = catalogModels(String(request.upstreamId ?? ""));
    return create(ListModelsResponseSchema, {
      models: models.map((model) =>
        create(CatalogModelSchema, {
          id: model.id,
          displayName: model.displayName,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          reasoning: model.reasoning,
          toolCall: model.toolCall,
          effortOptions: model.effortOptions,
          // 没人报价就不写这一格：契约里它是 optional，缺键是「不知道」，0 是
          // 「免费」—— 两件事不能在答复里糊成一个。
          ...(model.credits === undefined ? {} : { credits: model.credits }),
          // 上游没报计费就不写这一格（面板据此不显示价格）。它与上面那个 credits
          // 不是一回事，所以不合并、不互相覆盖。
          ...(model.billing === undefined ? {} : { billing: modelBillingMessage(model.billing) }),
        }),
      ),
    });
  },


};
