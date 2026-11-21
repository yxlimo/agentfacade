// lib/admin/service/system.ts — 系统与配置的方法分片。
//
// 从 service.ts 原样搬来：getSystemStatus、restartSystem、listConfig、setConfig、
// tailLog。分片按域组合回门面的 adminService，方法体一字未动。

import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import { AdminService, ConfigItemSchema, GetSystemStatusResponseSchema, ListConfigResponseSchema, RestartSystemResponseSchema, SetConfigResponseSchema, TailLogResponseSchema } from "../../gen/agentfacade/admin/v1/admin_pb.ts";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../../log.ts";
import { tailLog } from "../log.ts";
import { configItems, knownConfigKeys, pendingRestart, setConfigValue } from "../config.ts";
import { healthSnapshot } from "../upstreams.ts";
import { adminTokenSet } from "../token.ts";
import { publishedModels } from "../models.ts";
import { platformMessages } from "./platform-view.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const systemMethods: Partial<ServiceImpl<typeof AdminService>> = {
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

  async tailLog(request) {
    const lines = tailLog(Number(request.lines ?? 0), String(request.filter ?? ""));
    return create(TailLogResponseSchema, { lines });
  },
};

/** 服务的版本号：只被 getSystemStatus 用，随方法搬到这里。 */
function serviceVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "..", "..", "..", "package.json"), "utf8"));
    return String(pkg.version ?? "");
  } catch {
    return "";
  }
}
