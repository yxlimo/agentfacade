// tests/panel-i18n.e2e.ts — 面板语言切换的四件事。
//
// 头部切 EN → 页面文案跟着变 → 刷新仍是 EN（localStorage）→ 切回中文恢复，
// 每一步都顺带验 <html lang>。断言的标签是侧栏/总览上的，跟平台页无关，
// 所以这一条同时守住了第一片（overview / login / auth / usage）的接入。

import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import { login } from './panel.ts';

test('语言切换：EN → 刷新保留 → 回中文，html lang 跟着变', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await login(screen);

  expect(await browser.evaluate<string>('document.documentElement.lang')).toBe('zh-CN');
  await expect(screen.getByRole('heading', { name: '总览' })).toBeVisible();

  // 1. 头部切到 EN：可见标签变英文。
  await screen.getByRole('button', { name: '语言' }).click();
  await screen.getByRole('menuitem', { name: 'English' }).click();
  await expect(screen.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(screen.getByRole('heading', { name: '总览' })).toBeHidden();
  expect(await browser.evaluate<string>('document.documentElement.lang')).toBe('en');
  expect(
    await browser.evaluate<string>("localStorage.getItem('agentfacade.lang')")
  ).toBe('en');

  // 2. 刷新：localStorage 生效，仍是英文。
  await browser.reload();
  await expect(screen.getByRole('heading', { name: 'Overview' })).toBeVisible();
  expect(await browser.evaluate<string>('document.documentElement.lang')).toBe('en');

  // 3. 切回中文：文案与 html lang 一起回来。
  await screen.getByRole('button', { name: 'Language' }).click();
  await screen.getByRole('menuitem', { name: '中文' }).click();
  await expect(screen.getByRole('heading', { name: '总览' })).toBeVisible();
  await expect(screen.getByRole('heading', { name: 'Overview' })).toBeHidden();
  expect(await browser.evaluate<string>('document.documentElement.lang')).toBe('zh-CN');
  expect(
    await browser.evaluate<string>("localStorage.getItem('agentfacade.lang')")
  ).toBe('zh');
});
