// tests/panel-platform-sort.e2e.ts — 平台页的排序模式：拖拽、键盘、localStorage
// 持久化、坏数据容错，以及额度页 / 签到页跟着同一份次序走。
//
// 次序只存浏览器（`localStorage['buddy.panel.platformOrder']`），不传后端：
// 所以断言的真相有两处 —— 存着的那份 JSON，和页面上行的先后。
// 预置的六个模拟客户端永远在，用例自己再铺三个开放平台（id 带排序前缀），
// 只对这三个断言相对次序，不假设预置平台的摆法。每条用例收尾删干净。

import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import type { Browser } from '@e2e-dev/web';
import type { Locator, Screen } from 'e2e';
import {
  dropPlatform,
  login,
  markPage,
  expectSamePage,
  seedPlatform,
} from './panel.ts';

/** 次序存的那个 localStorage 键（`web/src/lib/platform-order.ts` 的常量）。 */
const ORDER_KEY = 'buddy.panel.platformOrder';

/** 每条用例自己铺的三个平台：只对它们断言次序。 */
const SEEDED = [
  { id: 'sort-alpha', label: '排序甲' },
  { id: 'sort-beta', label: '排序乙' },
  { id: 'sort-gamma', label: '排序丙' },
];

const SEEDED_IDS = SEEDED.map((row) => row.id);

/** 铺三个平台；先删一遍，前一条用例没收尾也不会撞「已存在」。 */
async function seedAll(): Promise<void> {
  for (const row of SEEDED) {
    await dropPlatform(row.id).catch(() => {});
  }
  for (const row of SEEDED) {
    await seedPlatform({ id: row.id, label: row.label, kind: 'openai' });
  }
}

/** 收尾：删掉自己铺的三个平台。 */
async function cleanupAll(): Promise<void> {
  for (const row of SEEDED) {
    await dropPlatform(row.id).catch(() => {});
  }
}

/** 进「平台」页。 */
async function openPlatforms(screen: Screen, browser: Browser): Promise<void> {
  await login(screen);
  await screen.getByRole('link', { name: '平台' }).click();
  await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();
  await expect(browser).toHaveURL('/admin/upstreams');
}

/** 进入排序模式，等拖拽列表出来、表格退场。 */
async function enterSortMode(screen: Screen): Promise<void> {
  const button = screen.getByRole('button', { name: '排序' });
  await button.click();
  await expect(sortList(screen)).toBeVisible();
  await expect(screen.getByRole('button', { name: '完成排序' })).toBeVisible();
  await expect(screen.getByRole('button', { name: '排序' })).toBeHidden();
}

/** 排序模式下那份拖拽列表。 */
function sortList(screen: Screen): Locator {
  return screen.getByRole('list', { name: '平台排序' });
}

/** 拖拽列表里的某一行（行文本里带着平台 id）。 */
function sortRow(screen: Screen, id: string): Locator {
  return sortList(screen)
    .getByRole('listitem')
    .filter({ hasText: id });
}

/** 拖拽列表里的第 index 行（位次从页面上读，不用假设预置平台的摆法）。 */
function sortRowAt(screen: Screen, index: number): Locator {
  return sortList(screen).getByRole('listitem').nth(index);
}

/** 拖拽列表里行的先后（按页面上摆的顺序，取 data-platform-id）。 */
function sortOrder(browser: Browser): Promise<string[]> {
  return browser.evaluate<string[]>(
    `[...document.querySelectorAll('ul[aria-label="平台排序"] > li')].map((li) => li.dataset.platformId ?? '')`,
  );
}

/**
 * 把第 from 行拖到第 to 行：合成拖拽（dragstart → dragover → drop）。
 *
 * 不用原生的 `dragTo`：它总把落点摆在目标行中心，而 DragSortList 的悬停判定
 * 按各行中点切（`hoverFromPointer`），正中那一点会被切到下一行 —— 拖到第一位
 * 会变成第二位。这里把 dragover 摆在第 to 行的上沿，悬停位就是第 to 行。
 * dragstart 和 dragover 分两次 evaluate：dragstart 的 setState 要先渲染出去，
 * dragover 的处理器才能看到拖动状态。
 */
async function dragRowToIndex(
  browser: Browser,
  from: number,
  to: number,
): Promise<void> {
  const rows =
    "[...document.querySelectorAll('ul[aria-label=\"平台排序\"] > li')]";
  await browser.evaluate(
    `(() => {
      const rows = ${rows};
      rows[${from}].dispatchEvent(new DragEvent('dragstart', {
        bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), clientY: 0,
      }));
    })()`,
  );
  await browser.evaluate(
    `(() => {
      const rows = ${rows};
      const rect = rows[${to}].getBoundingClientRect();
      rows[${to}].dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: new DataTransfer(),
        clientY: rect.top + 2,
      }));
    })()`,
  );
  await browser.evaluate(
    `(() => {
      document
        .querySelector('ul[aria-label="平台排序"]')
        .dispatchEvent(new DragEvent('drop', {
          bubbles: true, cancelable: true, dataTransfer: new DataTransfer(),
        }));
    })()`,
  );
}

/** 平台页表格里数据行的先后（行文本里都带着平台 id，按行文本认）。 */
async function tableOrder(browser: Browser): Promise<string[]> {
  const texts = await browser.evaluate<string[]>(
    `[...document.querySelectorAll('table tbody tr')].map((tr) => tr.textContent ?? '')`,
  );
  return texts.filter((text) => SEEDED_IDS.some((id) => text.includes(id)));
}

/** 平台页表格里三个自铺平台的先后（照页面上摆的顺序，按行文本认 id）。 */
async function seededTableOrder(browser: Browser): Promise<string[]> {
  const texts = await browser.evaluate<string[]>(
    `[...document.querySelectorAll('table tbody tr')].map((tr) => tr.textContent ?? '')`,
  );
  return texts
    .map((text) => SEEDED_IDS.find((id) => text.includes(id)))
    .filter((id): id is string => id !== undefined);
}

/** localStorage 里存着的次序（JSON 字符串数组；没存过是 null）。 */
async function storedOrder(browser: Browser): Promise<string[] | null> {
  const raw = await browser.evaluate<string | null>(
    `window.localStorage.getItem(${JSON.stringify(ORDER_KEY)})`,
  );
  return raw === null ? null : (JSON.parse(raw) as string[]);
}

test('拖动让位：拖动进行中其余行带 transition-transform 或 inline transform，不是松手才跳变', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await seedAll();
  await openPlatforms(screen, browser);
  await enterSortMode(screen);

  const before = await sortOrder(browser);
  // 半场拖动：dragstart 起于排序丙、dragover 悬到第一行，不落手。两次
  // evaluate：dragstart 的 setState 要先渲染出去，dragover 才能看到拖动状态。
  const from = before.indexOf('sort-gamma');
  expect(from).toBeGreaterThan(0);
  const rowsSelector =
    "[...document.querySelectorAll('ul[aria-label=\"平台排序\"] > li')]";
  await browser.evaluate(
    `(() => {
      const rows = ${rowsSelector};
      rows[${from}].dispatchEvent(new DragEvent('dragstart', {
        bubbles: true, cancelable: true, dataTransfer: new DataTransfer(), clientY: 0,
      }));
    })()`,
  );
  await browser.evaluate(
    `(() => {
      const rows = ${rowsSelector};
      const rect = rows[0].getBoundingClientRect();
      rows[0].dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: new DataTransfer(),
        clientY: rect.top + 2,
      }));
    })()`,
  );

  // 拖动进行中：被拖行（排序丙）跟指针（inline transform、无过渡），
  // 它上方的行已经让出位移（computeOffsets：hover < from 时 [hover, from)
  // 各让出一个行高）—— 让位是滑过去的，不是松手才跳变。
  const states = await browser.evaluate<
    Array<{ cls: string; transform: string; id: string }>
  >(
    `[...document.querySelectorAll('ul[aria-label="平台排序"] > li')].map((li) => ({
      cls: li.className,
      transform: li.style.transform,
      id: li.dataset.platformId ?? '',
    }))`,
  );
  const dragged = states.find((row) => row.id === 'sort-gamma');
  expect(dragged).toBeTruthy();
  expect(dragged?.cls).toContain('transition-none');
  expect(dragged?.transform).toContain('translateY');
  // 悬停位之前的行（含落点行）都让了位：inline transform、带 transition 类。
  for (const [index, row] of states.entries()) {
    if (row.id === 'sort-gamma') continue;
    if (index < from) {
      expect(row.transform).toContain('translateY');
      expect(row.cls).toContain('transition-transform');
    } else {
      // 悬停位之后的行不动，但过渡类照样在（下一帧让位也是滑的）。
      expect(row.cls).toContain('transition-transform');
    }
  }

  // 落手收尾：次序真正换掉，页面不炸。
  await browser.evaluate(
    `(() => {
      document
        .querySelector('ul[aria-label="平台排序"]')
        .dispatchEvent(new DragEvent('drop', {
          bubbles: true, cancelable: true, dataTransfer: new DataTransfer(),
        }));
    })()`,
  );
  const draggedOrder = await sortOrder(browser);
  expect(draggedOrder[0]).toBe('sort-gamma');

  await cleanupAll();
});

test('排序模式：点「排序」换出拖拽列表，点「完成排序」回表格', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await seedAll();
  await openPlatforms(screen, browser);

  // 没进排序模式时：表格在，拖拽列表不在；按钮不是按下态。
  await expect(screen.getByRole('table')).toBeVisible();
  await expect(sortList(screen)).toBeHidden();
  await expect(screen.getByRole('button', { name: '排序' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );

  await enterSortMode(screen);
  await expect(screen.getByRole('button', { name: '完成排序' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(screen.getByRole('table')).toBeHidden();
  // 三个平台都在拖拽列表里，各自带着拖拽该有的属性。
  for (const row of SEEDED) {
    const li = sortRow(screen, row.id);
    await expect(li).toBeVisible();
    await expect(li).toHaveAttribute('draggable', 'true');
  }

  await screen.getByRole('button', { name: '完成排序' }).click();
  await expect(screen.getByRole('table')).toBeVisible();
  await expect(sortList(screen)).toBeHidden();
  await expect(screen.getByRole('button', { name: '排序' })).toBeVisible();

  await cleanupAll();
});

test('拖拽：把排序丙拖到列表第一位，退出后表格第一行就是它', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await seedAll();
  await openPlatforms(screen, browser);
  await markPage(browser);
  await enterSortMode(screen);

  // 拖之前排序丙不在第一位（不然这条用例什么都没证明）。
  const before = await sortOrder(browser);
  const gammaFrom = before.indexOf('sort-gamma');
  expect(gammaFrom).toBeGreaterThan(0);

  await dragRowToIndex(browser, gammaFrom, 0);

  // 换位立刻生效：列表第一行是它，localStorage 里它排第一。
  expect((await sortOrder(browser))[0]).toBe('sort-gamma');
  expect((await storedOrder(browser))?.[0]).toBe('sort-gamma');

  // 退出排序模式：表格第一行（数据行）就是它，而且页面没被刷新过 ——
  // 次序是 React 摆的，不是 reload 才变。
  await screen.getByRole('button', { name: '完成排序' }).click();
  await expect(screen.getByRole('table')).toBeVisible();
  expect((await tableOrder(browser))[0]).toContain('sort-gamma');
  await expectSamePage(browser);

  await cleanupAll();
});

test('键盘：Alt+方向键换位，行尾「上移/下移」同样生效，首行上移不可用', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await seedAll();
  await openPlatforms(screen, browser);
  await enterSortMode(screen);

  // Alt+ArrowUp：焦点在第 2 行，把它挪到第 1 位。位次从页面上读。
  const before = await sortOrder(browser);
  const secondId = before[1];
  await sortRowAt(screen, 1).focus();
  await sortRowAt(screen, 1).press('Alt+ArrowUp');
  expect((await sortOrder(browser))[0]).toBe(secondId);
  expect((await storedOrder(browser))?.[0]).toBe(secondId);

  // 行尾「上移」按钮：把第 2 行（原来的第 1 行）再挪回去。行定位按位次，
  // 不按文本（预置的 id 有前缀重叠，比如 qoder 与 qoder-cn）。
  const afterUp = await sortOrder(browser);
  await sortRowAt(screen, 1)
    .getByRole('button', { name: `上移 ${afterUp[1]}` })
    .click();
  expect(await sortOrder(browser)).toEqual(before);

  // 行尾「下移」按钮：把第 1 行挪到第 2 位。
  await sortRowAt(screen, 0)
    .getByRole('button', { name: `下移 ${before[0]}` })
    .click();
  expect((await sortOrder(browser))[1]).toBe(before[0]);

  // Alt+ArrowDown：焦点在第 1 行，挪到第 2 位。第 1 行现在是原来的第 2 位那位，
  // 挪下去之后它回到第 2 位。
  await sortRowAt(screen, 0).focus();
  await sortRowAt(screen, 0).press('Alt+ArrowDown');
  expect((await sortOrder(browser))[1]).toBe(secondId);
  // Alt+ArrowDown 之后次序已经回到 before（qoder 回到第 2 位，minimax 回到第 1 位）。
  expect(await sortOrder(browser)).toEqual(before);

  // 首行「上移」、末行「下移」都是 disabled。
  const current = await sortOrder(browser);
  await expect(
    sortRowAt(screen, 0).getByRole('button', { name: `上移 ${current[0]}` }),
  ).toBeDisabled();
  const lastId = current[current.length - 1];
  await expect(
    sortRowAt(screen, current.length - 1).getByRole('button', { name: `下移 ${lastId}` }),
  ).toBeDisabled();

  await cleanupAll();
});

test('刷新保持：改完次序 reload，表格行的先后还在', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await seedAll();
  await openPlatforms(screen, browser);
  await enterSortMode(screen);

  const before = await sortOrder(browser);
  await dragRowToIndex(browser, before.indexOf('sort-gamma'), 0);
  const dragged = await sortOrder(browser);
  expect(dragged).not.toEqual(before);
  await screen.getByRole('button', { name: '完成排序' }).click();

  await browser.reload();
  await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();
  expect(await seededTableOrder(browser)).toEqual(
    dragged.filter((id) => SEEDED_IDS.includes(id)),
  );
  expect(await storedOrder(browser)).toEqual(dragged);

  await cleanupAll();
});

test('容错：localStorage 里混着不存在的平台 id，页面不炸、坏 id 被丢掉', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await seedAll();
  // 先进一次页面（有了源），再塞一份带坏 id 的次序，刷新让它生效。
  await openPlatforms(screen, browser);
  await browser.evaluate<string>(
    `window.localStorage.setItem(${JSON.stringify(ORDER_KEY)}, ${JSON.stringify(
      JSON.stringify(['sort-gamma', 'ghost-one', 'sort-alpha', 'ghost-two', 'sort-beta']),
    )})`,
  );
  await browser.reload();
  await expect(screen.getByRole('heading', { name: '平台' })).toBeVisible();
  await expect(screen.getByRole('table')).toBeVisible();

  // 表格照存的那份次序摆：丙、甲、乙的相对次序成立；坏 id 不会出现在页面上。
  await expect(screen.getByText('ghost-one')).toBeHidden();
  expect(await seededTableOrder(browser)).toEqual([
    'sort-gamma',
    'sort-alpha',
    'sort-beta',
  ]);

  // 排序模式里同一份次序：三个真实的都在、次序一致，坏 id 不占行。
  await enterSortMode(screen);
  const order = await sortOrder(browser);
  expect(order.filter((id) => SEEDED_IDS.includes(id))).toEqual([
    'sort-gamma',
    'sort-alpha',
    'sort-beta',
  ]);
  expect(order.some((id) => id.startsWith('ghost-'))).toBe(false);
  await screen.getByRole('button', { name: '完成排序' }).click();

  await cleanupAll();
});

test('跨页一致：改完次序，额度页与签到页的行次序跟着走', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await seedAll();
  await openPlatforms(screen, browser);
  await enterSortMode(screen);

  const crossBefore = await sortOrder(browser);
  await dragRowToIndex(browser, crossBefore.indexOf('sort-gamma'), 0);
  const dragged = await sortOrder(browser);
  const seededOrder = dragged.filter((id) => SEEDED_IDS.includes(id));
  expect(seededOrder).toEqual(['sort-gamma', 'sort-alpha', 'sort-beta']);
  await screen.getByRole('button', { name: '完成排序' }).click();

  // 额度页：默认收起只摆前几条，先「展开全部」让九条都在，再读行的先后。
  // 清单没到时页面摆的是骨架（空的 ul 同名），所以要等真行出来。
  await screen.getByRole('link', { name: '额度' }).click();
  await expect(screen.getByRole('heading', { name: '额度' })).toBeVisible();
  await screen.getByRole('button', { name: /展开全部/ }).click();
  for (const id of SEEDED_IDS) {
    await expect(screen.getByLabel(`${id} 额度行`, { exact: false })).toBeVisible();
  }
  // 行的 aria-label 是 `<平台id> 额度行`（读取中会再带后缀），取头一个词认 id。
  const balanceOrder = await browser.evaluate<string[]>(
    `[...document.querySelectorAll('ul[aria-label="平台额度"] > li')].map((li) => (li.getAttribute('aria-label') ?? '').split(' ')[0])`,
  );
  expect(balanceOrder.filter((id) => SEEDED_IDS.includes(id))).toEqual(seededOrder);

  // 签到页：排的那三个是开放平台，没有签到能力 —— 能力过滤生效，整行
  // 不出现（跨页一致的签到页次序断言在 panel-checkin.e2e 里，用
  // 有签到能力的平台验）。
  await screen.getByRole('link', { name: '签到' }).click();
  await expect(screen.getByRole('heading', { name: '签到' })).toBeVisible();
  for (const id of SEEDED_IDS) {
    await expect(screen.getByLabel(`${id} 签到行`, { exact: true })).toHaveCount(0);
  }

  await cleanupAll();
});
