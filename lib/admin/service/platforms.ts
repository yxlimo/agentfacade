// lib/admin/service/platforms.ts — 平台增删改与额度插件的方法分片。
//
// 从 service.ts 原样搬来：listUpstreams、开放平台的增删改与刷新目录、平台策略、
// listQuotaPlugins。校验与归一都在下层（open-platforms.ts），这里只把结果摆成
// 契约的形状、把连带删掉的东西写进日志。

import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  AddPlatformResponseSchema,
  AdminService,
  DeletePlatformResponseSchema,
  ListQuotaPluginsResponseSchema,
  ListUpstreamsResponseSchema,
  QuotaPluginFieldSchema,
  QuotaPluginPlatformSchema,
  QuotaPluginSchema,
  RefreshPlatformModelsResponseSchema,
  SetPlatformPolicyResponseSchema,
  UpdatePlatformResponseSchema,
} from "../../gen/agentfacade/admin/v1/admin_pb.ts";
import { log } from "../../log.ts";
import { adminError } from "../error-codes.ts";
import { policyErrorText, policyFromEnum } from "../policy.ts";
import { deleteAccount } from "../accounts.ts";
import { listAggregateModels } from "../../aggregate.ts";
import { forgetPlatformModelOverrides } from "../../model-overrides.ts";
import { forgetUpstreamSessions } from "../../upstream-session.ts";
import {
  createOpenPlatform,
  deleteOpenPlatform,
  listOpenPlatforms,
  openPlatformOf,
  updateOpenPlatform,
} from "../../open-platforms.ts";
import { refreshOpenPlatformCatalog } from "../../open-platform-catalog.ts";
import { isSimulatedClientKind } from "../../platform-catalog.ts";
import { allQuotaPlugins } from "../../quota-plugin-registry.ts";
import { quotaPluginOfAccount } from "../../quota-state.ts";
import { forgetPlatformPolicy, setPlatformPolicy as writePlatformPolicy } from "../../platforms.ts";
import { accountsOfPlatform } from "../../providers.ts";
import { openPlatformMessage, platformMessages } from "./platform-view.ts";
import { givenBool, givenText } from "./shared.ts";

export const platformMethods: Partial<ServiceImpl<typeof AdminService>> = {
  async listUpstreams() {
    // 列表是平台的数据源（代码里的模板 + 表里的开放平台），不是账号的：
    // 一个平台下没有账号也照样列出来，面板要在它下面「新增账号」。
    return create(ListUpstreamsResponseSchema, { upstreams: platformMessages() });
  },

  async addPlatform(request) {
    const id = String(request.id ?? "");
    // 校验与归一都在那一层（id 的规矩、地址的归一、模板与账号的重名，还有
    // kind 在不在能建的那张表里）。失败带机器码，细节只说事实。
    const result = createOpenPlatform({
      id,
      label: String(request.label ?? ""),
      baseUrl: String(request.baseUrl ?? ""),
      kind: String(request.kind ?? ""),
      // 头模板：建平台就能带；校验在那一层（validateHeaderTemplates），坏值整条拒绝。
      headers: request.headers,
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
      headers?: unknown;
    } = {
      label: givenText(request.label),
      baseUrl: givenText(request.baseUrl),
      // 带 presence 的开关：没给 = 别动（只改名字的单子不能把它清零）。
      traitsFromCommon: givenBool(request.traitsFromCommon),
      // 带 presence 的包装（HeaderTemplateList）：没给 = 别动，给了空列表 = 清空。
      headers: request.headers === undefined ? undefined : request.headers.items,
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
};
