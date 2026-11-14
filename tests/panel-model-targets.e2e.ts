// tests/panel-model-targets.e2e.ts — 主路由模型弹窗的「平台目标」排序。
//
// 位次即权重：第 1 行的权重 = 目标总数，往下递减（后端按 weight DESC 先试
// 大的）。拖拽不再常驻：平时是完整卡片（可填平台组 / 平台模型 id、可删行），
// 点「排序」进入排序模式，每个目标压成一行「平台组 / 上游模型」，拖着排，
// 点「完成排序」退出 —— 草稿不动，退出后各字段的输入原样回来。没有
// 上移 / 下移按钮，也没有「启用这个目标」开关。
//
// 断言的真相有两处：界面上每行只读的「权重 N」，和服务端存下来的
// targets[]（`ListPublishedModels` 回查，权重与顺序都要对上）。
// 目标组的目录是空的（平台没拉过目录），ModelPicker 退回手填输入框，
// 所以「平台模型 id」直接 fill。

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
} from './panel.ts';

const PLATFORM_ID = 'e2e-targets';
const PLATFORM_LABEL = 'E2E 目标站';
const MODEL_ID = 'e2e-weight-model';

/** 回查服务端存下来的那个模型（targets 按权重从大到小回）。 */
type SavedTarget = {
  groupName: string;
  upstreamModel: string;
  weight: number;
  enabled: boolean;
};

async function savedModel(id: string): Promise<{
  targets: SavedTarget[];
} | undefined> {
  const res = await adminRpc<{
    models?: Array<{ id: string; targets?: SavedTarget[] }>;
  }>('ListPublishedModels', {});
  const model = (res.models ?? []).find((item) => item.id === id);
  return model ? { targets: model.targets ?? [] } : undefined;
}

async function cleanup(): Promise<void> {
  await adminRpc('DeletePublishedModel', { id: MODEL_ID }).catch(() => {});
  await dropPlatform(PLATFORM_ID).catch(() => {});
}

/** 进「主路由模型」页。 */
async function openModelsPage(screen: Screen, browser: Browser): Promise<void> {
  await login(screen);
  await screen.getByRole('link', { name: '主路由模型' }).click();
  await expect(screen.getByRole('heading', { name: '主路由模型' })).toBeVisible();
  await expect(browser).toHaveURL('/admin/models');
}

/** 开「新增主路由模型」弹窗，填好对外 id，切到「平台目标」页。 */
async function openTargetTab(screen: Screen): Promise<Locator> {
  await screen.getByRole('button', { name: '新增' }).click();
  const dialog = screen.getByRole('dialog', { name: '新增主路由模型' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('对外 id').fill(MODEL_ID);
  await dialog.getByRole('tab', { name: '平台目标' }).click();
  await expect(targetList(dialog)).toBeVisible();
  return dialog;
}

/**
 * 目标顺序列表。卡片模式和排序模式共用一个可访问名（`目标顺序`）：
 * 任一时刻只有一份在 DOM 里，按当时所在的模式解读行内容。
 */
function targetList(dialog: Locator): Locator {
  return dialog.getByRole('list', { name: '目标顺序' });
}

/** 第 index 行（位次从 0 数，对应 data-target-row；行就是列表里第 index 个 listitem）。 */
function targetRow(dialog: Locator, index: number): Locator {
  return targetList(dialog).getByRole('listitem').nth(index);
}

/** 行数（当前模式里摆了几行）。 */
function rowCount(dialog: Locator): Locator {
  return targetList(dialog).getByRole('listitem');
}

/** 排序模式里第 index 行的正文（「平台组 / 上游模型」两段文字）。 */
function sortRowText(dialog: Locator, index: number): Promise<string | null> {
  return targetRow(dialog, index).textContent();
}

/**
 * 弹窗里选平台组：下拉是浮在最上层的一层，选项挂在 screen 上。
 * 选项文本是「标签（…）」，按标签前缀认。
 */
async function pickGroup(
  screen: Screen,
  row: Locator,
): Promise<void> {
  await row.getByRole('combobox', { name: '平台组' }).click();
  await screen
    .getByRole('option', { name: new RegExp(`^${PLATFORM_LABEL}`) })
    .click();
}

/** 铺满一行：选平台组 + 手填平台模型 id（目录空，ModelPicker 退回输入框）。 */
async function fillRow(
  screen: Screen,
  dialog: Locator,
  index: number,
  modelId: string,
): Promise<void> {
  const row = targetRow(dialog, index);
  await pickGroup(screen, row);
  await row.getByLabel('平台模型 id').fill(modelId);
}

/** 铺三个目标：t1 / t2 / t3（同一平台三个不同的模型 id）。 */
async function seedThreeTargets(
  screen: Screen,
  dialog: Locator,
): Promise<void> {
  await rowCount(dialog).waitFor({ state: 'visible' });
  // 弹窗自带一行空目标，再加两行。
  await dialog.getByRole('button', { name: '加一个目标' }).click();
  await dialog.getByRole('button', { name: '加一个目标' }).click();
  await expect(rowCount(dialog)).toHaveCount(3);
  for (const [index, modelId] of ['t1', 't2', 't3'].entries()) {
    await fillRow(screen, dialog, index, modelId);
  }
}

/** 进排序模式：点「排序」，等卡片退场、排序行出场。 */
async function enterSortMode(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: '排序', exact: true }).click();
  // 卡片退场：平台模型 id 的输入框不在了。
  await expect(dialog.getByLabel('平台模型 id')).toHaveCount(0);
  // 排序行出场：每行带 data-target-row，整行可拖。
  for (const index of [0, 1, 2]) {
    await expect(rowAt(dialog, index)).toHaveAttribute('data-target-row', String(index));
  }
}

/** 退出排序模式：点「完成排序」，等卡片回来。 */
async function exitSortMode(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: '完成排序' }).click();
  await expect(dialog.getByLabel('平台模型 id').first()).toBeVisible();
  await expect(dialog.getByRole('button', { name: '完成排序' })).toHaveCount(0);
}

/** 整行作为拖拽源 / 落点（排序模式的 li 自身 draggable，没有独立把手）。 */
function rowAt(dialog: Locator, index: number): Locator {
  return targetList(dialog).getByRole('listitem').nth(index);
}

/** 行上只读的权重文字（「权重 N」），只在卡片模式有。 */
function shownWeight(row: Locator): Promise<string | null> {
  return row.getByText(/^权重 /).textContent();
}

async function save(dialog: Locator, browser: Browser): Promise<void> {
  await markPage(browser);
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  // 保存走的是面板的 mutation，不是刷新：页面没重载也要存进去。
  await expectSamePage(browser);
}

/**
 * 用真实指针序列在页内走半场拖动：mouse.down 起于第 from 行、分步 mouse.move
 * 移到第 to 行上沿，不落手 —— 拖动过程的状态留在 DOM 里给断言看，之后由调用
 * 方 mouse.up 落位（finishPointerDrag）。指针被 setPointerCapture 抓在起拖行
 * 上，移出行外也收得到 move / up。
 *
 * 落点取第 to 行的上沿而不是中心：DragSortList 的悬停判定按各行中点切
 * （`hoverFromPointer`），正中那一点会被切到下一行。移动分多步：组件靠
 * pointermove 逐次算切行，一步到位收到的 move 不够。行位移只改 transform
 * 不改行高，起拖前量一次的行几何整场有效。
 */
async function startPointerDrag(
  browser: Browser,
  from: number,
  to: number,
): Promise<void> {
  const rects = await browser.evaluate<
    Array<{ x: number; top: number; height: number }>
  >(
    `[...document.querySelectorAll('ul[aria-label="目标顺序"] > li')].map((li) => {
      const r = li.getBoundingClientRect();
      return { x: r.x + r.width / 2, top: r.top, height: r.height };
    })`,
  );
  const startY = rects[from].top + rects[from].height / 2;
  const targetY = rects[to].top + 2;
  await browser.mouse.move(rects[from].x, startY);
  await browser.mouse.down();
  const steps = 8;
  for (let step = 1; step <= steps; step++) {
    await browser.mouse.move(
      rects[from].x,
      startY + ((targetY - startY) * step) / steps,
    );
  }
  // 等拖动状态的渲染追上指针：后面的断言读的是 DOM 里的拖拽态。
  await browser.evaluate<null>(
    'new Promise((resolve) => setTimeout(() => resolve(null), 50))',
  );
}

/** 收半场拖动：落手，让次序真正提交。 */
async function finishPointerDrag(browser: Browser): Promise<void> {
  await browser.mouse.up();
}

test('排序模式进出：点「排序」卡片换出排序列表，点「完成排序」卡片回来', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await adminRpc('AddPlatform', {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'openai',
    baseUrl: 'https://probe.example/v1',
  });
  try {
    await openModelsPage(screen, browser);
    const dialog = await openTargetTab(screen);
    await seedThreeTargets(screen, dialog);

    // 平时没有排序列表这回事：行是卡片（有输入框、有权重）。
    await expect(targetRow(dialog, 0).getByLabel('平台模型 id')).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: '完成排序' }),
    ).toHaveCount(0);

    await enterSortMode(dialog);

    // 排序按钮换成了「完成排序」；行压成一行文字「平台组 / 上游模型」，
    // 没有输入框、没有权重文字、也没有删除按钮。
    await expect(
      dialog.getByRole('button', { name: '排序', exact: true }),
    ).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: '完成排序' })).toBeVisible();
    for (const index of [0, 1, 2]) {
      const text = await sortRowText(dialog, index);
      expect(text).toContain(['t1', 't2', 't3'][index]);
      await expect(browser).toHaveClass(rowAt(dialog, index), /touch-none/);
      await expect(rowAt(dialog, index).getByRole('textbox')).toHaveCount(0);
      await expect(rowAt(dialog, index).getByText(/^权重 /)).toHaveCount(0);
      await expect(
        rowAt(dialog, index).getByRole('button', { name: /删除/ }),
      ).toHaveCount(0);
    }

    await exitSortMode(dialog);

    // 卡片回来：三行都在、顺序没动、权重照位次摆。
    await expect(rowCount(dialog)).toHaveCount(3);
    for (const [index, modelId] of ['t1', 't2', 't3'].entries()) {
      await expect(targetRow(dialog, index).getByLabel('平台模型 id')).toHaveValue(modelId);
    }
    expect(await shownWeight(targetRow(dialog, 0))).toBe('权重 3');
    expect(await shownWeight(targetRow(dialog, 2))).toBe('权重 1');
  } finally {
    await cleanup();
  }
});

test('拖动换位即权重：排序模式里拖第 3 个到第 1 位，退出后权重 3/2/1，保存后服务端一致', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await adminRpc('AddPlatform', {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'openai',
    baseUrl: 'https://probe.example/v1',
  });
  try {
    await openModelsPage(screen, browser);
    const dialog = await openTargetTab(screen);
    await seedThreeTargets(screen, dialog);
    await enterSortMode(dialog);

    // 拖第 3 行（t3）到第 1 行：真实指针拖放，落点在第 1 行上沿 —— 悬停
    // 判定按中点切，正中会被切到下一行（见 startPointerDrag 上方的注释；
    // 这里要的是「拖到第一位」）。
    await startPointerDrag(browser, 2, 0);
    await finishPointerDrag(browser);

    // 拖完排序列表里的次序立刻是 t3 / t1 / t2（还没退出）。
    for (const [index, modelId] of ['t3', 't1', 't2'].entries()) {
      expect(await sortRowText(dialog, index)).toContain(modelId);
    }

    await exitSortMode(dialog);

    // 退出后权重跟着位次重算：还是 3/2/1，但归属换了（总数 - 位次 + 1）。
    expect(await shownWeight(targetRow(dialog, 0))).toBe('权重 3');
    expect(await shownWeight(targetRow(dialog, 1))).toBe('权重 2');
    expect(await shownWeight(targetRow(dialog, 2))).toBe('权重 1');
    for (const [index, modelId] of ['t3', 't1', 't2'].entries()) {
      await expect(targetRow(dialog, index).getByLabel('平台模型 id')).toHaveValue(modelId);
    }

    await save(dialog, browser);

    // 服务端存的就是界面上的顺序与权重：weights DESC，第一位最大。
    const mine = await savedModel(MODEL_ID);
    expect(mine).toBeTruthy();
    expect(mine?.targets.map((t) => t.upstreamModel)).toEqual(['t3', 't1', 't2']);
    expect(mine?.targets.map((t) => t.weight)).toEqual([3, 2, 1]);
  } finally {
    await cleanup();
  }
});

test('键盘：排序模式里 Alt+方向键换位，换位即权重跟着变', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await adminRpc('AddPlatform', {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'openai',
    baseUrl: 'https://probe.example/v1',
  });
  try {
    await openModelsPage(screen, browser);
    const dialog = await openTargetTab(screen);
    await seedThreeTargets(screen, dialog);
    await enterSortMode(dialog);

    // Alt+ArrowUp：焦点在第 2 行，把它挪到第 1 位。
    await rowAt(dialog, 1).focus();
    await rowAt(dialog, 1).press('Alt+ArrowUp');
    expect(await sortRowText(dialog, 0)).toContain('t2');

    // Alt+ArrowDown：再挪回第 2 位，次序复原。
    await rowAt(dialog, 0).focus();
    await rowAt(dialog, 0).press('Alt+ArrowDown');
    expect(await sortRowText(dialog, 0)).toContain('t1');
    expect(await sortRowText(dialog, 1)).toContain('t2');

    // 换位即权重：退出后权重还是 3/2/1，归属没变。
    await exitSortMode(dialog);
    expect(await shownWeight(targetRow(dialog, 0))).toBe('权重 3');
    expect(await shownWeight(targetRow(dialog, 1))).toBe('权重 2');
    expect(await shownWeight(targetRow(dialog, 2))).toBe('权重 1');
  } finally {
    await cleanup();
  }
});

test('没有上移 / 下移：卡片模式和排序模式里都搜不到这两个可访问名', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await adminRpc('AddPlatform', {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'openai',
    baseUrl: 'https://probe.example/v1',
  });
  try {
    await openModelsPage(screen, browser);
    const dialog = await openTargetTab(screen);
    await seedThreeTargets(screen, dialog);

    // 卡片模式：任何按钮的可访问名都不叫「上移 …」/「下移 …」。
    await expect(dialog.getByRole('button', { name: /^上移/ })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /^下移/ })).toHaveCount(0);
    // 精确名也各试一条（旧实现是「上移目标 1」这个形状）。
    await expect(
      dialog.getByRole('button', { name: '上移目标 1' }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: '下移目标 3' }),
    ).toHaveCount(0);

    await enterSortMode(dialog);
    // 排序模式同样没有：换位只靠拖和 Alt + 方向键。
    await expect(dialog.getByRole('button', { name: /^上移/ })).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /^下移/ })).toHaveCount(0);

    await exitSortMode(dialog);
  } finally {
    await cleanup();
  }
});

test('进出排序模式不丢草稿：之前填的目标字段原样回来', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await adminRpc('AddPlatform', {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'openai',
    baseUrl: 'https://probe.example/v1',
  });
  try {
    await openModelsPage(screen, browser);
    const dialog = await openTargetTab(screen);
    await seedThreeTargets(screen, dialog);
    // 顺手在基本页也填一格：弹窗里所有草稿都该在排序模式前后保持。
    await dialog.getByRole('tab', { name: '基本' }).click();
    await dialog.getByLabel('显示名').fill('E2E 显示名');
    await dialog.getByLabel('推理档位（逗号分隔）').fill('low, high');
    await dialog.getByRole('tab', { name: '平台目标' }).click();

    await enterSortMode(dialog);
    await exitSortMode(dialog);

    // 目标行的输入都还在，顺序也没被排序模式动过。
    for (const [index, modelId] of ['t1', 't2', 't3'].entries()) {
      await expect(targetRow(dialog, index).getByLabel('平台模型 id')).toHaveValue(modelId);
    }
    // 基本页的两格也原样。
    await dialog.getByRole('tab', { name: '基本' }).click();
    await expect(dialog.getByLabel('显示名')).toHaveValue('E2E 显示名');
    await expect(dialog.getByLabel('推理档位（逗号分隔）')).toHaveValue('low, high');
    await dialog.getByRole('tab', { name: '平台目标' }).click();

    // 草稿完整不是白断言的：这单存得进去，服务端回读一致。
    await save(dialog, browser);
    const mine = await savedModel(MODEL_ID);
    expect(mine?.targets.map((t) => t.upstreamModel)).toEqual(['t1', 't2', 't3']);
    expect(mine?.targets.map((t) => t.weight)).toEqual([3, 2, 1]);
  } finally {
    await cleanup();
  }
});

test('让位动画有 DOM 证据：拖动进行中其余行带 transition-transform，被拖行不带过渡', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await adminRpc('AddPlatform', {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'openai',
    baseUrl: 'https://probe.example/v1',
  });
  try {
    await openModelsPage(screen, browser);
    const dialog = await openTargetTab(screen);
    await seedThreeTargets(screen, dialog);
    await enterSortMode(dialog);

    // 半场拖动：起于第 3 行、悬到第 1 行，不落手。
    await startPointerDrag(browser, 2, 0);

    // 拖动进行中：被拖行（t3，现在的第 3 行）是 transition-none，其余行
    // 带 transition-transform —— 让位是滑过去的，不是松手才跳变。
    const classes = await browser.evaluate<string[]>(
      `[...document.querySelectorAll('ul[aria-label="目标顺序"] > li')].map((li) => li.className)`,
    );
    expect(classes).toHaveLength(3);
    expect(classes[2]).toContain('transition-none');
    expect(classes[2]).not.toContain('transition-transform');
    for (const index of [0, 1]) {
      expect(classes[index]).toContain('transition-transform');
      expect(classes[index]).not.toContain('transition-none');
    }
    // 悬停位之前的行已经让出位移（computeOffsets：hover < from 时
    // [hover, from) 各让出一个行高），不是等 drop 才动。
    const transforms = await browser.evaluate<string[]>(
      `[...document.querySelectorAll('ul[aria-label="目标顺序"] > li')].map((li) => li.style.transform)`,
    );
    expect(transforms[0]).toContain('translateY');
    expect(transforms[1]).toContain('translateY');

    // 落手：次序真正换掉。
    await finishPointerDrag(browser);
    for (const [index, modelId] of ['t3', 't1', 't2'].entries()) {
      expect(await sortRowText(dialog, index)).toContain(modelId);
    }

    await exitSortMode(dialog);
  } finally {
    await cleanup();
  }
});

test('删除目标：卡片模式里删掉中间一个后权重重新紧凑（2/1），保存结果里没有它', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await adminRpc('AddPlatform', {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'openai',
    baseUrl: 'https://probe.example/v1',
  });
  try {
    await openModelsPage(screen, browser);
    const dialog = await openTargetTab(screen);
    await seedThreeTargets(screen, dialog);

    // 删中间那行（t2）。
    await targetRow(dialog, 1)
      .getByRole('button', { name: '删除目标 2' })
      .click();
    await expect(rowCount(dialog)).toHaveCount(2);
    // 剩下两行的权重重新紧凑：总数变成 2，第 1 行权重 2、第 2 行权重 1。
    for (const [index, modelId] of ['t1', 't3'].entries()) {
      await expect(targetRow(dialog, index).getByLabel('平台模型 id')).toHaveValue(modelId);
    }
    expect(await shownWeight(targetRow(dialog, 0))).toBe('权重 2');
    expect(await shownWeight(targetRow(dialog, 1))).toBe('权重 1');

    await save(dialog, browser);
    const mine = await savedModel(MODEL_ID);
    expect(mine?.targets.map((t) => t.upstreamModel)).toEqual(['t1', 't3']);
    expect(mine?.targets.map((t) => t.weight)).toEqual([2, 1]);
  } finally {
    await cleanup();
  }
});

test('没有「启用这个目标」开关：目标行里没有任何开关，保存后所有目标 enabled 都是 true', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await adminRpc('AddPlatform', {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'openai',
    baseUrl: 'https://probe.example/v1',
  });
  try {
    await openModelsPage(screen, browser);
    const dialog = await openTargetTab(screen);
    await seedThreeTargets(screen, dialog);

    // 目标顺序列表里：没有开关、没有勾选框、也没有「启用这个目标」这类字样。
    await expect(targetList(dialog).getByRole('switch')).toHaveCount(0);
    await expect(targetList(dialog).getByRole('checkbox')).toHaveCount(0);
    await expect(dialog.getByText(/启用这个目标/)).toHaveCount(0);

    await save(dialog, browser);
    const mine = await savedModel(MODEL_ID);
    expect(mine?.targets).toHaveLength(3);
    for (const target of mine?.targets ?? []) {
      expect(target.enabled).toBe(true);
    }
  } finally {
    await cleanup();
  }
});
