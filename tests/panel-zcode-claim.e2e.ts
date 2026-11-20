// tests/panel-zcode-claim.e2e.ts — zcode 账号行的「领取」端到端。
//
// 验证码 SDK 是第三方浏览器脚本：CI 没有外网，测试绝不能去加载 CDN。
// 这里用 browser.route 把那一个 URL 换成一段假 SDK（只实现 init +
// startTracelessVerification），并拦下两条 admin RPC —— 面板按真流程走：
// 查状态 → 渲染按钮 → 点 → init（要真的两个节点在页面上）→ 无感回调 →
// ClaimZcodePlan → 界面显示结论。断言「发了什么请求、带什么参数」用的是
// 路由记下来的请求体，不是页面自己说的话。
//
// 网关是本地实例，假上游不发请求；账号由 admin RPC 铺在测试自己的数据目录里。

import { expect } from 'e2e';
import type { Screen } from 'e2e';
import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import { addAccount, adminRpc, login } from './panel.ts';

const SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
const CLAIM_PATH = '/agentfacade.admin.v1.AdminService/ClaimZcodePlan';
const STATUS_PATH = '/agentfacade.admin.v1.AdminService/GetZcodeClaimStatus';

/** 假 SDK：记下 init 收到的节点与配置，按页面上挂的开关决定成功还是失败。 */
// 照真 SDK 的调用契约：一个参数对象里带四个回调，mode 只认 popup/embed，
// element/button 是选择器，实例由 getInstance 给，无感方法无参。
const FAKE_SDK = `
(() => {
  window.__captchaCalls = [];
  window.__captchaConfigAtScript = window.AliyunCaptchaConfig;
  window.initAliyunCaptcha = (params) => {
    if (!['popup', 'embed'].includes(params.mode)) throw new Error('modeError');
    if (typeof params.element !== 'string' || typeof params.button !== 'string') throw new Error('elementError');
    if (typeof params.getInstance !== 'function' || typeof params.success !== 'function' ||
        typeof params.fail !== 'function' || typeof params.onError !== 'function') {
      throw new Error('paramsError');
    }
    window.__captchaCalls.push({
      sceneId: params.SceneId,
      prefix: params.prefix,
      region: params.region,
      mode: params.mode,
      language: params.language,
      elementExists: !!document.querySelector(params.element),
      buttonExists: !!document.querySelector(params.button),
    });
    const instance = {
      startTracelessVerification() {
        window.__captchaCalls.push({ started: true, startArgs: arguments.length });
        const mode = window.__captchaMode || 'success';
        if (mode === 'failure') {
          params.onError({ code: 'DYNAMICJS_FAIL', msg: 'fake SDK failed' });
        } else {
          params.success('param-TESTONLY');
        }
      },
    };
    params.getInstance(instance);
  };
})();
`;

interface RecordedClaim {
  providerId?: string;
  planId?: string;
  campaignId?: string;
  captchaVerifyParam?: string;
  captchaRegion?: string;
}

/** 进平台页展开 zcode 那一行。账号由用例先铺好、路由先拦好。 */
async function openZcodeRow(screen: Screen, app: { open(): Promise<void> }): Promise<void> {
  await app.open();
  await login(screen);
  await screen.getByRole('link', { name: '平台' }).click();
  await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();
  await screen.getByRole('button', { name: '展开 zcode 的账号与凭据' }).click();
  await expect(screen.getByText('领取测试账号')).toBeVisible();
}

/**
 * 拦住 SDK 与两条 RPC。
 *
 * 状态由测试指定（这样不依赖上游投放）；领取请求原样记录并回一个固定结论。
 */
async function stub(
  browser: Browser,
  options: { captchaAvailable: boolean; hasOffer: boolean; outcome?: string },
) {
  const claims: RecordedClaim[] = [];
  await browser.route(SDK_URL, async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_SDK });
  });
  await browser.route(`**${STATUS_PATH}`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      json: {
        ok: true,
        message: '',
        captcha: {
          present: true,
          enabled: true,
          sceneId: 'scene-TESTONLY',
          prefix: 'prefix-TESTONLY',
          region: 'cn',
        },
        offers: options.hasOffer
          ? [{
              campaignId: 'camp-TESTONLY',
              planId: 'plan-TESTONLY',
              name: '周积分包',
              priority: 10,
              alreadyClaimed: false,
            }]
          : [],
        captchaAvailable: options.captchaAvailable,
      },
    });
  });
  await browser.route(`**${CLAIM_PATH}`, async (route) => {
    claims.push(JSON.parse(route.request.postData ?? '{}') as RecordedClaim);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      json: {
        ok: true,
        message: '',
        outcome: options.outcome ?? 'ZCODE_CLAIM_OUTCOME_CLAIMED',
        code: 0,
        upstreamMessage: '',
        planId: 'plan-TESTONLY',
        campaignId: 'camp-TESTONLY',
        planName: '周积分包',
        effectiveAtMs: '0',
      },
    });
  });
  return claims;
}

test('有 offer + 验证码配置：点领取 → 假 SDK 给 param → 带正确参数发 ClaimZcodePlan → 说领到了', async ({
  app, screen, browser,
}) => {
  let account = '';
  try {
    account = await addAccount('zcode', '领取测试账号');
    const claims = await stub(browser, { captchaAvailable: true, hasOffer: true });
    await openZcodeRow(screen, app);

    await screen.getByRole('button', { name: '领取额度' }).click();

    await expect(screen.getByText(/已领到/)).toBeVisible();
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      providerId: account,
      planId: 'plan-TESTONLY',
      campaignId: 'camp-TESTONLY',
      captchaVerifyParam: 'param-TESTONLY',
      captchaRegion: 'cn',
    });

    // SDK 那一侧：init 收到的 scene/prefix/region/中文都在，两个节点都真在页面上。
    const calls = await browser.evaluate<
      { sceneId?: string; prefix?: string; region?: string; mode?: string; language?: string; elementExists?: boolean; buttonExists?: boolean; started?: boolean; startArgs?: number }[]
    >('window.__captchaCalls');
    expect(calls[0]).toMatchObject({
      sceneId: 'scene-TESTONLY',
      prefix: 'prefix-TESTONLY',
      region: 'cn',
      mode: 'popup',
      language: 'cn',
      elementExists: true,
      buttonExists: true,
    });
    expect(calls[0].mode).toBe('popup');
    const configAtScript = await browser.evaluate<{ region?: string; prefix?: string }>(
      'window.__captchaConfigAtScript',
    );
    expect(configAtScript).toEqual({ region: 'cn', prefix: 'prefix-TESTONLY' });
    expect(calls.some((call) => call.started === true && call.startArgs === 0)).toBe(true);
  } finally {
    if (account) await adminRpc('DeleteAccount', { id: account }).catch(() => {});
  }
});

test('假 SDK 报失败：显示「这台浏览器没能通过验证码」，不发 ClaimZcodePlan', async ({
  app, screen, browser,
}) => {
  let account = '';
  try {
    account = await addAccount('zcode', '领取测试账号');
    const claims = await stub(browser, { captchaAvailable: true, hasOffer: true });
    await openZcodeRow(screen, app);
    await browser.evaluate("window.__captchaMode = 'failure'");

    await screen.getByRole('button', { name: '领取额度' }).click();

    const status = screen.getByRole('status');
    await expect(status).toContainText('这台浏览器没能通过验证码');
    await expect(status).toContainText('建议去官方客户端点一次');
    expect(claims).toHaveLength(0);
  } finally {
    if (account) await adminRpc('DeleteAccount', { id: account }).catch(() => {});
  }
});

test('验证码配置不可用时没有领取按钮（不知道不是没有）', async ({ app, screen, browser }) => {
  let account = '';
  try {
    account = await addAccount('zcode', '领取测试账号');
    await stub(browser, { captchaAvailable: false, hasOffer: true });
    await openZcodeRow(screen, app);
    await expect(screen.getByRole('button', { name: '领取额度', exact: true })).toHaveCount(0);
  } finally {
    if (account) await adminRpc('DeleteAccount', { id: account }).catch(() => {});
  }
});
