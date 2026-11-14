// lib/tokenrhythm/transport.ts — 中转站的推理错误形状。
//
// TokenRhythm 的推理请求现在走开放平台路径（openAiPlatformChat），这一层只剩
// 路由层还认的错误类型：余额不足要能跟「服务忙」分开，路由层才判断得出这个账号
// 该不该换。

/**
 * The account has no money left.
 *
 * Unlike "the service is busy", this does not get better by waiting: the
 * account cannot serve anything until it is recharged. The caller switches to
 * another account.
 */
export class TokenRhythmNoBalanceError extends Error {
  status = 402;
  traceId: string;

  constructor(message: string, traceId: string) {
    super(message);
    this.name = "TokenRhythmNoBalanceError";
    this.traceId = traceId;
  }
}