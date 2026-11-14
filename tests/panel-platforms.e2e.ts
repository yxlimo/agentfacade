// tests/panel-platforms.e2e.ts — 「平台」页：预置平台、新增平台、加账号、删平台。
//
// 前置数据用 admin RPC 铺（面板上要验的是「点了之后立刻变」，把平台一条条点出来
// 只是给断言添噪声）。每条测试自己收尾，不把平台留给下一个。

import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import type { Locator, Screen } from 'e2e';
import {
  adminRpc,
  dropPlatform,
  expectSamePage,
  login,
  markPage,
  seedOpenPlatform,
} from './panel.ts';

/** 预置的模拟客户端（`lib/platform-catalog.ts` 的 SIMULATED_CLIENTS，名字照抄）。 */
const SIMULATED = ['MiniMax Code', 'Qoder（全球区）', 'Qoder（中国区）', 'WorkBuddy（中国区）', 'WorkBuddy（国际区）', 'ZCode'];

/** 找到平台上那一行（按名字或 id）。 */
function rowOf(screen: Screen, text: string): Locator {
  return screen.getByRole('row').filter({ hasText: text });
}

/** 进「平台」页。 */
async function openPlatforms(screen: Screen, browser: Browser): Promise<void> {
  await login(screen);
  await screen.getByRole('link', { name: '平台' }).click();
  await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();
  await expect(browser).toHaveURL('/admin/upstreams');
}

test('平台页：六个预置的模拟客户端都在，行里没有地址与额度插件', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await openPlatforms(screen, browser);

  for (const label of SIMULATED) {
    await expect(rowOf(screen, label)).toBeVisible();
  }
  // 模拟客户端的地址与额度归代码，面板不摆这两格 —— 摆出来等于让人以为能填。
  for (const label of ['MiniMax Code', 'Qoder（中国区）', 'WorkBuddy（中国区）']) {
    const row = rowOf(screen, label);
    await expect(row.getByText('额度插件', { exact: false })).toHaveCount(0);
    await expect(row.getByText('地址', { exact: false })).toHaveCount(0);
  }
});

test('新增平台弹窗：两组类型标题都在；选模拟客户端定死 id，选开放平台 id 可填；建完列表立刻多一行', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await openPlatforms(screen, browser);

  await screen.getByRole('button', { name: '新增平台' }).click();
  const dialog = screen.getByRole('dialog', { name: '新增平台' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('先建一个空平台。id 是客户端地址里的一段。')).toBeVisible();

  // 类型下拉分两组：模拟客户端与开放平台。
  await dialog.getByRole('combobox', { name: '类型' }).click();
  const simulatedGroup = screen.getByRole('group', { name: '模拟客户端' });
  const openGroup = screen.getByRole('group', { name: '开放平台' });
  await expect(simulatedGroup).toBeVisible();
  await expect(openGroup).toBeVisible();
  for (const label of SIMULATED) {
    await expect(simulatedGroup.getByRole('option', { name: label })).toBeVisible();
  }
  await expect(openGroup.getByRole('option', { name: 'OpenAI 兼容' })).toBeVisible();
  await expect(openGroup.getByRole('option', { name: 'Anthropic 兼容' })).toBeVisible();

  // 选模拟客户端：id 与地址是预置定的，只摆出来，没有地址与额度插件两格。
  await simulatedGroup.getByRole('option', { name: 'MiniMax Code' }).click();
  await expect(
    dialog.getByText('模拟客户端的 id 与地址是固定的，改不了'),
  ).toBeVisible();
  await expect(dialog.getByText('客户端走的是 /minimax/v1')).toBeVisible();
  await expect(dialog.getByLabel('平台 id')).toHaveCount(0);
  await expect(dialog.getByLabel('地址')).toHaveCount(0);
  await expect(dialog.getByLabel('额度插件')).toHaveCount(0);

  // 换成开放平台（OpenAI 兼容）：id 变成能填的输入框，地址那一格也出来。
  await dialog.getByRole('combobox', { name: '类型' }).click();
  await screen.getByRole('option', { name: 'OpenAI 兼容' }).click();
  await expect(dialog.getByLabel('平台 id')).toBeVisible();
  await expect(dialog.getByLabel('地址')).toBeVisible();
  await expect(dialog.getByLabel('平台 id')).toBeEnabled();

  await dialog.getByLabel('平台 id').fill('e2e-dialog');
  await dialog.getByLabel('名字').fill('E2E 探针站');
  await dialog.getByLabel('地址').fill('https://probe.example/v1');

  // 记住「这一页没刷新过」：改完立刻生效的断言，不能靠刷新混过去。
  await markPage(browser);
  await dialog.getByRole('button', { name: '加上' }).click();
  await expect(dialog).toBeHidden();

  // 列表立刻多一行（没刷新、没重进页面）。
  await expect(rowOf(screen, 'E2E 探针站')).toBeVisible();
  await expect(rowOf(screen, 'e2e-dialog')).toBeVisible();
  await expectSamePage(browser);

  await dropPlatform('e2e-dialog');
});

test('加账号：状态说出「没有可用凭据」这一条明确原因；表格里没有「账号」列', async ({
  app,
  screen,
  browser,
}) => {
  // 先删一遍：上一条用例失败跳过收尾时，这里不能撞「已存在」。
  await dropPlatform('e2e-account').catch(() => {});
  await seedOpenPlatform('e2e-account', 'E2E 账号站');
  await app.open();
  await openPlatforms(screen, browser);

  try {
    const row = rowOf(screen, 'E2E 账号站');
  await expect(row).toBeVisible();
  // 还没有账号时，状态那一格（第 3 列）说的是「加一个账号」。
  await expect(row.getByRole('cell').nth(2)).toContainText('这个平台还没有账号');

  await row.getByRole('button', { name: '新增账号' }).click();
  const dialog = screen.getByRole('dialog', { name: '新增账号' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText('在「E2E 账号站」下加一个账号。客户端地址不变。'),
  ).toBeVisible();

  await dialog.getByLabel('别名').fill('探针一号');
  await markPage(browser);
  await dialog.getByRole('button', { name: '加上' }).click();
  await expect(dialog).toBeHidden();

  // 「账号」这一列整列删掉了（个数不给看）：表头不存在，行里也没有那个数字格。
  // 列序：平台 / 区域 / 状态 / 生效策略 / 操作。
  await expect(screen.getByRole('columnheader', { name: '账号' })).toHaveCount(0);
  await expect(row.getByRole('cell').nth(4)).not.toHaveText('1');
  await expect(row.getByRole('cell').nth(4)).not.toContainText('探针一号');
  // 没删过头：留下的几列都在。
  for (const name of ['平台', '区域', '状态', '生效策略', '操作']) {
    await expect(screen.getByRole('columnheader', { name })).toBeVisible();
  }
  // 操作列的按钮仍然可点。
  const addAccountButton = row.getByRole('button', { name: '新增账号' });
  await expect(addAccountButton).toBeVisible();
  await expect(addAccountButton).toBeEnabled();
  // 状态说清新的是哪一件事：账号有了，但它还没有凭据。
  await expect(row.getByRole('cell').nth(2)).toContainText('没有可用凭据');
  // 只有一个账号时策略不生效，这一格自己会说。
  await expect(row.getByRole('cell').nth(3)).toContainText(
    '这个平台只有一个账号，策略不生效',
  );
  // 展开之后账号还在：个数不给看，不等于账号看不到。展开的落点是行首
  // 那颗按钮（「生效策略」那格吃掉了点击，点行不展开）；展开出来的明细
  // 是独立的 <tr>，不在行子树里，从整张表里找。
  await row.getByRole('button', { name: '展开 e2e-account 的账号与凭据' }).click();
  await expect(screen.getByText('探针一号')).toBeVisible();
  await expectSamePage(browser);
  } finally {
    await dropPlatform('e2e-account').catch(() => {});
  }
});

test('平台行的小字里没有 base URL，也没有类型', async ({ app, screen, browser }) => {
  // 先删一遍：上一条用例失败跳过收尾时，这里不能撞「已存在」。
  await dropPlatform('e2e-account').catch(() => {});
  await seedOpenPlatform('e2e-account', 'E2E 账号站');
  await app.open();
  await openPlatforms(screen, browser);

  try {
    const row = rowOf(screen, 'E2E 账号站');
    await expect(row).toBeVisible();
    // 名字下的小字不给看 base URL（播种时填了 https://probe.example/v1）
    // 与类型（openai 的名字是「OpenAI 兼容」）—— 摆出来只会让人以为能改。
    await expect(row).not.toContainText('https://probe.example/v1');
    await expect(row).not.toContainText('OpenAI 兼容');
    // id 还在小字里：客户端路径里那一段得能认出来。
    await expect(row).toContainText('e2e-account');
  } finally {
    await dropPlatform('e2e-account').catch(() => {});
  }
});

test('删开放平台：确认框说清会连账号凭据一起清掉，删完列表立刻少一行', async ({
  app,
  screen,
  browser,
}) => {
  await seedOpenPlatform('e2e-delete', 'E2E 删站点');
  await app.open();
  await openPlatforms(screen, browser);
  await expect(rowOf(screen, 'E2E 删站点')).toBeVisible();

  await markPage(browser);
  await rowOf(screen, 'E2E 删站点').getByRole('button', { name: '删除' }).click();
  const confirm = screen.getByRole('alertdialog');
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText('删除 E2E 删站点')).toBeVisible();
  // 文案要说清删的是「连名下账号与凭据一起」、且回不来。
  await expect(confirm.getByText('一并清除', { exact: false })).toBeVisible();
  await expect(confirm.getByText('不可恢复', { exact: false })).toBeVisible();

  await confirm.getByRole('button', { name: '删除' }).click();
  await expect(confirm).toBeHidden();

  // 列表立刻少一行，没刷新。
  await expect(rowOf(screen, 'E2E 删站点')).toHaveCount(0);
  await expectSamePage(browser);

  // 服务端那边也真的没了（不只是这一页把它藏起来）。
  const list = await adminRpc<{ upstreams?: Array<{ id: string }> }>('ListUpstreams');
  expect((list.upstreams ?? []).map((item) => item.id)).not.toContain('e2e-delete');
});
