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
  CancelLoginResponseSchema,
  CatalogModelSchema,
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
import { benefitMethods } from "./service/benefits.ts";
import { zcodeMethods } from "./service/zcode.ts";

export { quotaMessage };
/** 管理接口的实现。纯门面：各方法分片按域组合在这里。 */
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
  ...benefitMethods,
  ...zcodeMethods,
};
