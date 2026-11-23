// lib/admin/service/login.ts — 登录授权的方法分片。
//
// 从 service.ts 原样搬来：beginLogin、getLoginStatus、cancelLogin、
// loginWithPassword、exchangeLoginCode、importLoginToken。登录流程在
// lib/admin/login.ts，这里把会话与错误摆成面板能显示的形状。

import { create } from "@bufbuild/protobuf";
import type { ServiceImpl } from "@connectrpc/connect";
import {
  AdminService,
  BeginLoginResponseSchema,
  CancelLoginResponseSchema,
  ExchangeLoginCodeResponseSchema,
  GetLoginStatusResponseSchema,
  ImportLoginTokenResponseSchema,
  LoginWithPasswordResponseSchema,
} from "../../gen/agentfacade/admin/v1/admin_pb.ts";
import {
  beginLogin,
  cancelLogin,
  exchangeLoginCode,
  getLoginStatus,
  importLoginToken,
  loginWithPassword,
} from "../login.ts";
import { accountMessage, credentialMessage, loginErrorText, loginSessionMessage } from "./account-view.ts";

export const loginMethods: Partial<ServiceImpl<typeof AdminService>> = {
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
