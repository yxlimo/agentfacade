# ZCode 手动领取（浏览器出验证码）— 后端那一半

## 目标
契约 + 管理端 RPC + 领取调用。浏览器跑阿里云无感验证码，把一次性 token 交给后端，
后端带 `X-Aliyun-Captcha-Verify-Param` 打 `billing/claim`。

## 步骤
- 读完 lib/zcode/{claim,marketing,auto-claim,transport,credits}.ts 与 lib/admin/service.ts、
  proto/agentfacade/admin/v1/admin.proto、test/zcode-claim-check.ts。
- 背景事实（不重新确认）：claim 必须带阿里云验证码头；验证码配置来自
  `GET /api/v1/client/configs`；可领与否由 `marketing/touch` 决定。
