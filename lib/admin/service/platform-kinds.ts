// lib/admin/service/platform-kinds.ts — 「能建哪类平台」两个下拉的方法分片。
//
// 从 service.ts 原样搬来：listProviderKinds（账号的 kind）与 listPlatformKinds
// （建平台的 kind：两种方言 + 预置的模拟客户端）。

import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  AdminService,
  CredentialFieldSchema,
  ListPlatformKindsResponseSchema,
  ListProviderKindsResponseSchema,
  PlatformKindSchema,
  ProviderKindSchema,
} from "../../gen/agentfacade/admin/v1/admin_pb.ts";
import { platformKindChoices } from "../../platform-catalog.ts";
import { kindOf, selectableKinds } from "../../provider-kinds.ts";
import { policyEnum } from "../policy.ts";

export const platformKindMethods: Partial<ServiceImpl<typeof AdminService>> = {
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
};
