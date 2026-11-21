// lib/admin/service/models.ts — 模型目录与人工元数据的方法分片。
//
// 从 service.ts 原样搬来：公布模型的列表/保存/删除、人工元数据的读改删、
// listModels（各平台目录）。目录聚合在 lib/admin/models.ts 与 lib/aggregate.ts，
// 这里只摆形状、记日志。

import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  AdminService,
  CatalogModelSchema,
  DeleteModelOverrideResponseSchema,
  DeletePublishedModelResponseSchema,
  ListModelOverridesResponseSchema,
  ListModelsResponseSchema,
  ListPublishedModelsResponseSchema,
  ModelMetadataSchema,
  PublishedModelSchema,
  PublishedTargetSchema,
  SavePublishedModelResponseSchema,
  SetModelOverridesResponseSchema,
  type ModelOverride,
} from "../../gen/agentfacade/admin/v1/admin_pb.ts";
import { log } from "../../log.ts";
import { adminError } from "../error-codes.ts";
import { catalogModels, deletePublishedModel, publishedModels, savePublishedModel } from "../models.ts";
import { deleteModelOverride, listModelOverrides, upsertModelOverrides } from "../../model-overrides.ts";
import { modelBillingMessage, modelOverrideMessage, modelOverrideRow } from "./model-view.ts";

export const modelMethods: Partial<ServiceImpl<typeof AdminService>> = {
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
