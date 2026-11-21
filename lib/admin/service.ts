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
import { openPlatformMessage, platformMessages } from "./service/platform-view.ts";

export { quotaMessage };
/** 管理接口的实现。 */
export const adminService: Partial<ServiceImpl<typeof AdminService>> = {
  /* ---------------- 系统 ---------------- */

  async getSystemStatus() {
    // 先看一眼快照：旧了就起一个后台刷新，面板这次拿旧答案、下次拿新的。
    healthSnapshot();
    return create(GetSystemStatusResponseSchema, {
      version: serviceVersion(),
      upstreams: platformMessages(),
      pendingRestart: pendingRestart(),
      uptimeSec: BigInt(Math.round(process.uptime())),
      publishedModelCount: publishedModels().filter((m) => m.published).length,
      adminTokenSet: adminTokenSet(),
    });
  },

  async restartSystem() {
    // 容器是 restart: unless-stopped 起的，进程退出去它就会把新配置带起来。
    // 先把答复送出去，再退。
    setTimeout(() => {
      log.info("[ADMIN] 面板要求重启：进程退出，容器会把它拉起来");
      process.exit(0);
    }, 500);
    return create(RestartSystemResponseSchema, {
      accepted: true,
      message: "进程正在退出，容器会自动重启。前端稍后重连。",
    });
  },

  /* ---------------- 平台与账号 ---------------- */

  async listUpstreams() {
    // 列表是平台的数据源（代码里的模板 + 表里的开放平台），不是账号的：
    // 一个平台下没有账号也照样列出来，面板要在它下面「新增账号」。
    return create(ListUpstreamsResponseSchema, { upstreams: platformMessages() });
  },

  async listProviderKinds() {
    return create(ListProviderKindsResponseSchema, {
      kinds: selectableKinds().map((k) =>
        create(ProviderKindSchema, {
          kind: k.kind,
          label: k.label,
          login: k.login,
          needsRegion: k.needsRegion,
          regions: k.regions,
          // 这一类上游支持哪几个策略：面板的选项从这里来。
          // 兜底在 platformPolicies 里（没登记的种类只给「单一」）。
          policies: k.policies.map(policyEnum),
          // 填凭据那几格也由种类说：面板不自己留一张按 kind 查的表
          // （那样一份知识就有两处会走样）。
          credentialTitle: k.credentialTitle,
          credentialFields: k.credentialFields.map((f) =>
            create(CredentialFieldSchema, {
              name: f.name,
              label: f.label,
              hint: f.hint ?? "",
              placeholder: f.placeholder ?? "",
            }),
          ),
        }),
      ),
    });
  },

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

  async setPlatformPolicy(request) {
    const platform = String(request.platform ?? "");
    // 契约里的枚举 → 库里存的策略。不认识的（UNSPECIFIED 或别的数字）就是
    // 「给错了」，不写库。
    const policy = policyFromEnum(Number(request.policy));
    if (!policy) {
      return create(SetPlatformPolicyResponseSchema, {
        ok: false,
        message: policyErrorText(request.policy),
      });
    }
    // 平台支不支持这个策略：只有一个账号的平台选了也没用，所以那边只给「单一」。
    // 校验在 lib/platforms.ts 里，这里只把结果转成一句面板能看的话。
    const result = writePlatformPolicy(platform, policy);
    if (result.ok) log.info(`[ADMIN] 平台 ${platform} 的策略改成 ${policy}`);
    return create(SetPlatformPolicyResponseSchema, { ok: result.ok, message: result.message });
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

  /* ---------------- 开放平台 ---------------- */

  async addPlatform(request) {
    const id = String(request.id ?? "");
    // 校验与归一都在那一层（id 的规矩、地址的归一、模板与账号的重名，还有
    // kind 在不在能建的那张表里）。失败带机器码，细节只说事实。
    const result = createOpenPlatform({
      id,
      label: String(request.label ?? ""),
      baseUrl: String(request.baseUrl ?? ""),
      kind: String(request.kind ?? ""),
    });
    if (!result.ok) throw adminError(result.code, result.message);
    log.info(`[ADMIN] 加了开放平台 ${id}`);
    const row = openPlatformOf(id.trim());
    return create(AddPlatformResponseSchema, { platform: row ? openPlatformMessage(row) : undefined });
  },

  async updatePlatform(request) {
    const id = String(request.id ?? "").trim();
    // base_url 带 presence：没给 = 别动那一格。
    // 名字也照这条走（没给 = 别动；显式空串 = 错，平台得有名字）。
    // 目录不在这里改：目录归上游（方言族）还是归代码（模拟客户端）由平台的族
    // 决定，不是面板说了算。面板要换目录，去点「刷新模型目录」。
    const patch: {
      label?: string;
      baseUrl?: string;
      traitsFromCommon?: boolean;
    } = {
      label: givenText(request.label),
      baseUrl: givenText(request.baseUrl),
      // 带 presence 的开关：没给 = 别动（只改名字的单子不能把它清零）。
      traitsFromCommon: givenBool(request.traitsFromCommon),
    };
    const result = updateOpenPlatform(id, patch);
    if (!result.ok) throw adminError(result.code, result.message);
    log.info(`[ADMIN] 开放平台 ${id} 改了`);
    const row = openPlatformOf(id.trim());
    return create(UpdatePlatformResponseSchema, {
      platform: row ? openPlatformMessage(row) : undefined,
    });
  },

  async deletePlatform(request) {
    const id = String(request.id ?? "").trim();
    const row = openPlatformOf(id);
    if (!row) throw adminError("PLATFORM_NOT_FOUND", `no platform ${id}`);
    // 名下的账号：连凭据、冷却、健康快照里它的那一段一起删（走删账号那条路，
    // 它知道每个平台的凭据放在哪）。
    const accounts = accountsOfPlatform(id);
    for (const account of accounts) deleteAccount(account.id);
    // 指向这个平台的已发布模型：目标留着，面板上它显示「平台已停用」——
    // 这与平台停用、账号被删时的做法一样（lib/admin/models.ts 的 targetBlocker：
    // 不认识的分组当作关着）。删掉目标就是发明新规则了。
    const affected = listAggregateModels().filter((model) =>
      model.targets.some((target) => target.group === id),
    );
    const deleted = deleteOpenPlatform(id);
    if (!deleted.ok) throw adminError(deleted.code, deleted.message);
    // 平台自己的策略也清掉：平台没了，那一行就是一根没人认的指针（下次用
    // 同一个 id 建回来，它会凭空继承旧策略）。
    forgetPlatformPolicy(id);
    // 人工写的那份模型元数据同理：平台没了，那些行就是没人认的指针（下次用
    // 同一个 id 建回来，它会凭空继承旧档位、旧计费、旧显示名 —— 用户从没为
    // 这个新平台填过任何东西）。
    const overrides = forgetPlatformModelOverrides(id);
    // 上游会话映射也是「旧位置的记录」：上游那一侧已经没了，那张表里的映射
    // 指向的是一个不存在的上游会话。
    const sessions = forgetUpstreamSessions(id);
    // 连带删掉的东西写进日志：答复里没有 message 了，出过什么事就只剩这一处。
    log.info(
      `[ADMIN] 删了开放平台 ${id}（${row.label}）：连 ${accounts.length} 个账号一起，` +
        `${affected.length} 个已发布模型指向它（现在显示平台已停用），` +
        `${overrides} 条人工元数据、${sessions} 条会话映射一起`,
    );
    return create(DeletePlatformResponseSchema, {});
  },

  async refreshPlatformModels(request) {
    const id = String(request.platformId ?? "").trim();
    // 拉不到不是错误：原来那份目录留着（答复里说的就是现在这份）。
    //
    // force：这是人手动点的刷新，要穿透失败退避（退避只该拦后台与请求路径上
    // 那些没人看着的调用）。
    const outcome = await refreshOpenPlatformCatalog(id, { force: true }).catch((e) => ({
      ok: false,
      message: `无法获取模型目录：${(e as Error)?.message ?? String(e)}`,
    }));
    const row = openPlatformOf(id);
    return create(RefreshPlatformModelsResponseSchema, {
      ok: outcome.ok,
      message: outcome.message,
      models: row?.models.items ?? [],
    });
  },

  async listQuotaPlugins() {
    // 现在用到每个插件的平台：从开放平台行里筛出地址匹配到它的那些。判据还是
    // quotaPluginOfAccount —— 与 Upstream.quota_plugin_id 同一个答案，不在
    // admin 层另写一套比较。模拟客户端那些行不是开放平台，滤掉。
    //
    // 判据按平台算一次再看：每家插件都重算一遍就是白读库 N 倍。
    const platformRows = listOpenPlatforms().filter(
      (row) => !isSimulatedClientKind(row.kind)
    );
    const pluginOfRow = new Map(
      platformRows.map((row) => [row.id, quotaPluginOfAccount({ platform: row.id })]),
    );
    return create(ListQuotaPluginsResponseSchema, {
      plugins: allQuotaPlugins().map((plugin) =>
        create(QuotaPluginSchema, {
          id: plugin.id,
          label: plugin.label,
          // 声明的地址原样带上去：面板只拿它展示插件声明，不做匹配 ——
          // 匹配结果在 platforms 里，服务端已经算好。
          baseUrls: [...plugin.baseUrls],
          platforms: platformRows
            .filter((row) => pluginOfRow.get(row.id)?.id === plugin.id)
            .map((row) =>
              create(QuotaPluginPlatformSchema, {
                platformId: row.id,
                label: row.label,
                baseUrl: row.baseUrl,
              })
            ),
          fields: plugin.fields.map((field) =>
            create(QuotaPluginFieldSchema, {
              name: field.name,
              label: field.label,
              secret: field.secret,
            }),
          ),
        }),
      ),
    });
  },

  async listPlatformKinds() {
    // 两族：先是「用户自己加的一类」（两种方言，选的是这一类怎么跟上游说话），
    // 再是预置的模拟客户端（从目录里挑一个）。顺序照表里的顺序：面板按答复渲染
    // 下拉，不自己排。
    //
    // 默认地址取自 kind 注册表（ProviderKind.defaultBaseUrl）：catalog 那一列是
    // 空的，地址是各自适配器的地址常量，不写在面板这一层。额度插件同理（注册表
    // 里的 defaultBaseUrl）：面板建平台时拿它占位，用户可以改。
    return create(ListPlatformKindsResponseSchema, {
      kinds: platformKindChoices().map((option) =>
        create(PlatformKindSchema, {
          kind: option.kind,
          label: option.label,
          defaultBaseUrl: kindOf(option.kind)?.defaultBaseUrl ?? "",
          category: option.category,
          presetId: option.presetId,
          region: option.region,
        }),
      ),
    });
  },

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

  async tailLog(request) {
    const lines = tailLog(Number(request.lines ?? 0), String(request.filter ?? ""));
    return create(TailLogResponseSchema, { lines });
  },

  /* ---------------- 登录授权 ---------------- */

  async beginLogin(request) {
    const upstreamId = String(request.upstreamId ?? "");
    try {
      const session = await beginLogin(upstreamId, String(request.accountId ?? ""));
      return create(BeginLoginResponseSchema, {
        session: loginSessionMessage(session),
        ok: true,
        message: session.message,
      });
    } catch (e) {
      return create(BeginLoginResponseSchema, { ok: false, message: loginErrorText(e) });
    }
  },

  async getLoginStatus(request) {
    const session = getLoginStatus(String(request.loginId ?? ""));
    if (!session) {
      return create(GetLoginStatusResponseSchema, { ok: false, message: "未找到本次登录。" });
    }
    return create(GetLoginStatusResponseSchema, {
      session: loginSessionMessage(session),
      ok: true,
      message: session.message,
    });
  },

  async cancelLogin(request) {
    const result = cancelLogin(String(request.loginId ?? ""));
    return create(CancelLoginResponseSchema, { ok: result.ok, message: result.message });
  },

  async loginWithPassword(request) {
    try {
      const result = await loginWithPassword({
        upstreamId: String(request.upstreamId ?? ""),
        accountId: String(request.accountId ?? ""),
        username: String(request.username ?? ""),
        password: String(request.password ?? ""),
        captchaVerifyParam: String(request.captchaVerifyParam ?? ""),
        captchaSceneId: String(request.captchaSceneId ?? ""),
        captchaPrefix: String(request.captchaPrefix ?? ""),
        remember: request.remember === true,
      });
      return create(LoginWithPasswordResponseSchema, {
        ok: result.ok,
        message: result.message,
        account: accountMessage(result.accountId),
        credential: credentialMessage(result.credentialId),
      });
    } catch (e) {
      return create(LoginWithPasswordResponseSchema, { ok: false, message: loginErrorText(e) });
    }
  },

  async exchangeLoginCode(request) {
    try {
      const result = await exchangeLoginCode({
        upstreamId: String(request.upstreamId ?? ""),
        accountId: String(request.accountId ?? ""),
        code: String(request.code ?? ""),
      });
      return create(ExchangeLoginCodeResponseSchema, {
        ok: result.ok,
        message: result.message,
        credential: credentialMessage(result.credentialId),
      });
    } catch (e) {
      return create(ExchangeLoginCodeResponseSchema, { ok: false, message: loginErrorText(e) });
    }
  },

  async importLoginToken(request) {
    try {
      const result = await importLoginToken({
        upstreamId: String(request.upstreamId ?? ""),
        accountId: String(request.accountId ?? ""),
        token: String(request.token ?? ""),
      });
      return create(ImportLoginTokenResponseSchema, {
        ok: result.ok,
        message: result.message,
        credential: credentialMessage(result.credentialId),
      });
    } catch (e) {
      return create(ImportLoginTokenResponseSchema, { ok: false, message: loginErrorText(e) });
    }
  },
};
