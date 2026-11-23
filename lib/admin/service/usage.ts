// lib/admin/service/usage.ts — 用量统计的方法分片。
//
// 从 service.ts 原样搬来：getUsageSummary、listUsageEvents。聚合在
// lib/admin/usage.ts，这里只把合计与事件摆成契约里的形状。

import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  AdminService,
  GetUsageSummaryResponseSchema,
  ListUsageEventsResponseSchema,
  UsageEventSchema,
} from "../../gen/agentfacade/admin/v1/admin_pb.ts";
import { usageEvents, usageSummary } from "../usage.ts";
import { usageBucketMessage, usageSummaryMessage } from "./shared.ts";

export const usageMethods: Partial<ServiceImpl<typeof AdminService>> = {
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
};
