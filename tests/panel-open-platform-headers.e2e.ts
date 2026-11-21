// tests/panel-open-platform-headers.e2e.ts — 开放平台的注入头在面板上的闭环。
//
// 造平台走面板（填头、保存），但「值还在」这一步必须先刷新页面：只有从服务端
// ListUpstreams 读回来的 upstream.headers 才算数，客户端缓存里的草稿不算。
// 删光所有行保存那一步同理，刷新之后再打开弹窗才钉住「删光 = 清空」。

import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import type { Locator, Screen } from 'e2e';
import type { Browser } from '@e2e-dev/web';
import {
  adminRpc,
  dropPlatform,
  expectSamePage,
  login,
  markPage,
} from './panel.ts';

const ID = 'e2e-headers';
const LABEL = 'E2E 注入头站';
const BASE_URL = 'https://probe.example/v1';

/** 找到平台上那一行（按名字）。 */
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

test('开放平台注入头：刷新后从服务端读回、列表可见、删光清空、EN 文案', async ({
  app,
  screen,
  browser,
}) => {
  // 上一条用例失败跳过收尾时，这里不能撞「已存在」。
  await dropPlatform(ID).catch(() => {});
  await app.open();
  await openPlatforms(screen, browser);

  try {
    // 造一个带一条注入头的开放平台，走面板保存。
    await screen.getByRole('button', { name: '新增平台' }).click();
    const add = screen.getByRole('dialog', { name: '新增平台' });
    await expect(add).toBeVisible();
    await add.getByLabel('平台 id').fill(ID);
    await add.getByLabel('名字').fill(LABEL);
    await add.getByLabel('地址').fill(BASE_URL);
    await add.getByRole('button', { name: '加一条' }).click();
    await add.getByLabel('头名 1').fill('x-env');
    await add.getByLabel('头值 1').fill('{session-id}');

    await markPage(browser);
    await add.getByRole('button', { name: '加上' }).click();
    await expect(add).toBeHidden();
    await expect(rowOf(screen, LABEL)).toBeVisible();
    await expectSamePage(browser);

    // 刷新：弹窗里那一条只能来自服务端 ListUpstreams 的 upstream.headers。
    await browser.reload();
    await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();
    const row = rowOf(screen, LABEL);
    await expect(row).toBeVisible();
    await expect(row).toContainText('注入头：1 条 · x-env');

    await row.getByRole('button', { name: '编辑' }).click();
    const dialog = screen.getByRole('dialog');
    await expect(dialog.getByLabel('头名 1')).toHaveValue('x-env');
    await expect(dialog.getByLabel('头值 1')).toHaveValue('{session-id}');
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toBeHidden();

    // EN：列表的注入头那行与弹窗的标题都换成英文词条。
    await screen.getByRole('button', { name: '语言' }).click();
    await screen.getByRole('menuitem', { name: 'English' }).click();
    await expect(row).toContainText('Injected headers: 1 · x-env');
    await row.getByRole('button', { name: 'Edit' }).click();
    const enDialog = screen.getByRole('dialog');
    await expect(enDialog.getByText('Injected headers')).toBeVisible();
    await expect(enDialog.getByLabel('Header name 1')).toHaveValue('x-env');
    await enDialog.getByRole('button', { name: 'Cancel' }).click();
    await screen.getByRole('button', { name: 'Language' }).click();
    await screen.getByRole('menuitem', { name: '中文' }).click();

    // 删光所有行、保存：这一格发的是空列表，不是「这一格不出现」。
    await markPage(browser);
    await row.getByRole('button', { name: '编辑' }).click();
    const edit = screen.getByRole('dialog');
    await edit.getByRole('button', { name: '删掉第 1 条' }).click();
    await expect(edit.getByLabel('头名 1')).toHaveCount(0);
    await edit.getByRole('button', { name: '保存' }).click();
    await expect(edit).toBeHidden();
    await expect(row).not.toContainText('注入头：');
    await expectSamePage(browser);

    // 再刷新、重新打开：是空的，服务端那一份也被清空了。
    await browser.reload();
    await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();
    const afterClear = rowOf(screen, LABEL);
    await expect(afterClear).toBeVisible();
    await expect(afterClear).not.toContainText('注入头：');
    await afterClear.getByRole('button', { name: '编辑' }).click();
    const reopened = screen.getByRole('dialog');
    await expect(reopened.getByLabel('头名 1')).toHaveCount(0);
    await expect(reopened.getByRole('button', { name: '加一条' })).toBeVisible();

    const list = await adminRpc<{
      upstreams?: Array<{ id: string; headers?: Array<{ name: string }> }>;
    }>('ListUpstreams');
    const serverRow = (list.upstreams ?? []).find((item) => item.id === ID);
    expect(serverRow?.headers ?? []).toEqual([]);
  } finally {
    await dropPlatform(ID).catch(() => {});
  }
});
