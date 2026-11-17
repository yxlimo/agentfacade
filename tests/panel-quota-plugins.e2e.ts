// tests/panel-quota-plugins.e2e.ts — 额度插件按平台地址自动匹配的端到端。
//
// 插件不再是平台上选的一格：插件在登记表里声明自己服务哪些地址，服务端按
// base_url 对上其中一个，把匹配结果（quota_plugin_id / quota_plugin_label /
// quota_plugin_fields）随平台行带给面板，面板原样消费，不自己按地址算（见
// lib/quota-plugin-registry.ts）。对不上任何插件的平台就是没有额度接口：额度
// 区整块不摆、不报错、不提示。
//
// 这里验三件事：
//   1. 匹配是地址说了算：地址对得上的平台额度区在、给结论；对不上的额度区
//      整块不摆，页面上也不出现「没有插件」这类提示。
//   2. 「插件列表」页把对应关系摆出来：一行一插件，展开能看到匹配到它的
//      平台与账号；零匹配的插件只有那一句话。
//   3. 凭据从插件页也填得进去：插件要的那一格（七牛的门户 cookie）真存到
//      服务端（按指纹比，不看提示）。
//
// 七牛那条探测路在「没填门户 cookie」时翻成结论（missing）就返回，不碰网络
// —— 答复是确定的，整套不发一个出机器的请求。平台与账号用 admin RPC 铺，
// 收尾自己删掉，不给下一个用例留数据。

import { createHash } from 'node:crypto';
import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import type { Locator, Screen } from 'e2e';
import { addAccount, adminRpc, dropPlatform, login, QINIU_BASE_URL, seedPlatform } from './panel.ts';

/** 四个插件在登记表里的名字（各家 quota-plugin.ts 的声明，面板原样显示）。 */
const PLUGIN_LABELS = ['七牛云资源包', 'SenseNova 资源池', '书生·端砚墨点', 'TokenRhythm 钱包'] as const;

/** 弹窗里贴的两段值 —— 都是编造的样例。 */
const KEY = 'sk-E2E-PLUGIN-TESTONLY'; // privacy:allow — 编造的样例
const COOKIE = 'c=E2E-PLUGIN-TESTONLY'; // privacy:allow — 编造的样例

/** 服务端那边这个账号的凭据行。 */
interface CredentialRow {
  accountId?: string;
  kind?: string;
  label?: string;
  fingerprint?: string;
}

/** 值的指纹：与 lib/admin/accounts.ts 的 fingerprintOf 同一个算法。 */
function fingerprintOf(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
}

/** 进「平台」页。 */
async function openPlatforms(screen: Screen, browser: Browser): Promise<void> {
  await login(screen);
  await screen.getByRole('link', { name: '平台' }).click();
  await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();
  await expect(browser).toHaveURL('/admin/upstreams');
}

/** 进「插件列表」页。 */
async function openPluginList(screen: Screen): Promise<void> {
  await login(screen);
  await screen.getByRole('link', { name: '插件列表' }).click();
  await expect(screen.getByRole('heading', { name: '插件列表' })).toBeVisible();
}

/** 插件列表里的一行（行容器的 aria-label 恒为 `额度插件 <label>`）。 */
function pluginRow(screen: Screen, label: string): Locator {
  return screen.getByRole('listitem', { name: `额度插件 ${label}` });
}

/**
 * 铺一对平台：地址对得上七牛的（带一个没填门户 cookie 的账号），与地址
 * 对不上任何插件的。返回账号 id（对得上的那家名下）。
 *
 * 对得上的那家随后给一条确定的额度结论：没填门户 cookie 的探测在发请求
 * 之前就翻成 missing —— 先打一趟 GetBalance 把快照喂饱，平台卡与额度页
 * 读的都是它。
 */
async function seedMatchedAndUnmatched(): Promise<string> {
  await seedPlatform({
    id: 'e2e-plugin-hit',
    label: 'E2E 对上七牛的站',
    kind: 'openai',
    baseUrl: QINIU_BASE_URL,
  });
  await seedPlatform({
    id: 'e2e-plugin-miss',
    label: 'E2E 对不上的站',
    kind: 'openai',
    // 默认地址（probe.example）不在任何插件的声明里：这家没有额度接口。
  });
  const account = await addAccount('e2e-plugin-hit', '没填 cookie 的那家');
  await adminRpc('SetProviderKeys', {
    upstreamId: account,
    keys: ['sk-e2e-plugin-hit-key', ''], // privacy:allow — 编造的样例（第二段空串占位：还没填门户 cookie）
  });
  // 整轮刷一次快照：七牛的探测没 cookie 就翻结论，不碰网络。
  await adminRpc('GetBalance', {});
  return account;
}

/** 收尾：这对平台（连账号与凭据）一起删掉。 */
async function dropPair(accountId: string): Promise<void> {
  await adminRpc('DeleteAccount', { id: accountId }).catch(() => {});
  await dropPlatform('e2e-plugin-hit').catch(() => {});
  await dropPlatform('e2e-plugin-miss').catch(() => {});
}

test('按地址自动匹配：对得上的平台额度区在且给结论；对不上的额度区整块不摆，也没有提示', async ({
  app,
  screen,
  browser,
}) => {
  let account = '';
  try {
    account = await seedMatchedAndUnmatched();

    await app.open();
    await openPlatforms(screen, browser);

    // 对得上的那家：额度区在，给的是那条确定的结论（还没填凭据）。
    const hit = screen.getByRole('row').filter({ hasText: 'E2E 对上七牛的站' });
    await expect(hit).toBeVisible();
    await expect(hit).toContainText('还没填凭据');

    // 对不上的那家：额度区整块不摆 —— 没有结论、没有「额度：」那几行，
    // 页面上也不出现「没有插件/未配插件」这类提示（对不上不是错误）。
    const miss = screen.getByRole('row').filter({ hasText: 'E2E 对不上的站' });
    await expect(miss).toBeVisible();
    await expect(miss).not.toContainText('还没填凭据');
    await expect(miss).not.toContainText('额度：');
    const text = String(await browser.evaluate<string>('document.body.innerText'));
    expect(text).not.toContain('没有插件');
    expect(text).not.toContain('未配插件');
  } finally {
    await dropPair(account);
  }
});

test('插件列表页：四个插件都在；展开能看到匹配到的平台与账号；零匹配只有那一句话', async ({
  app,
  screen,
}) => {
  let account = '';
  try {
    account = await seedMatchedAndUnmatched();

    await app.open();
    await openPluginList(screen);

    // 四个插件一行一个，都在。
    for (const label of PLUGIN_LABELS) {
      await expect(pluginRow(screen, label)).toBeVisible();
    }

    // 展开对得上七牛的那家：列出匹配到它的平台与账号。
    await screen
      .getByRole('button', { name: '展开 七牛云资源包 的平台与账号' })
      .click();
    const hitRow = pluginRow(screen, '七牛云资源包');
    await expect(hitRow).toContainText('E2E 对上七牛的站');
    await expect(hitRow).toContainText(QINIU_BASE_URL);
    await expect(hitRow).toContainText('没填 cookie 的那家');

    // 展开一个零匹配的插件：唯一的那句话，没有平台也没有账号。
    await screen
      .getByRole('button', { name: '展开 SenseNova 资源池 的平台与账号' })
      .click();
    await expect(screen.getByText('暂无平台使用这个插件')).toBeVisible();
  } finally {
    await dropPair(account);
  }
});

test('插件字段能从插件页填：展开平台账号，填「额度 Cookie」，服务端真收到那一段', async ({
  app,
  screen,
}) => {
  let account = '';
  try {
    account = await seedMatchedAndUnmatched();

    await app.open();
    await openPluginList(screen);
    await screen
      .getByRole('button', { name: '展开 七牛云资源包 的平台与账号' })
      .click();
    const hitRow = pluginRow(screen, '七牛云资源包');

    // 两格（推理 Key + 插件那一段）= 「凭据」入口。格子数由地址匹配结果说了算。
    const row = hitRow
      .getByRole('row')
      .filter({ hasText: '没填 cookie 的那家' });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: '凭据' }).click();
    const dialog = screen.getByRole('dialog', { name: 'E2E 对上七牛的站的凭据' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('推理 Key')).toBeVisible();
    await expect(dialog.getByLabel('额度 Cookie')).toBeVisible();

    // 两段都填：位置就是顺序，插件那一段也要真存下来。
    await dialog.getByLabel('推理 Key').fill(KEY);
    await dialog.getByLabel('额度 Cookie').fill(COOKIE);
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toHaveCount(0);

    // 服务端真收到：两段各按指纹比对（提示说成功不算）。
    const listed = await adminRpc<{ credentials?: CredentialRow[] }>('ListCredentials', {
      accountId: account,
    });
    const rows = (listed.credentials ?? []).filter((r) => r.accountId === account);
    const inference = rows.filter((r) => r.kind === 'api_key');
    expect(inference).toHaveLength(1);
    expect(inference[0].fingerprint).toBe(fingerprintOf(KEY));
    const quota = rows.filter((r) => r.kind === 'cookie');
    expect(quota).toHaveLength(1);
    expect(quota[0].label).toBe('额度 Cookie');
    expect(quota[0].fingerprint).toBe(fingerprintOf(COOKIE));
  } finally {
    await dropPair(account);
  }
});
