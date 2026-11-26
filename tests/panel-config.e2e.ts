// tests/panel-config.e2e.ts — 「配置」页：界面上的配置项与接口给的清单一致、
// 分组的中文名、热设置的生效。
//
// 先问接口，再对界面：用例开头调 ListConfig（面板自己也会调的那个 RPC）拿到
// 真实的配置项清单，然后断言界面上画的就是那些 —— 一项不多、一项不少，每组
// 的条数、名字、分组都对得上。后端加一项、改名、改分组，这条用例自动仍然绿
// （只要页面没画坏）；页面漏画、多画、把组名画成英文，才会红。

import { expect } from 'e2e';
import { test } from '@e2e-dev/web';
import { adminRpc, login } from './panel.ts';

/**
 * 分组键的中文名。
 *
 * 服务端给的 group 是英文的键（general、gateway……），面板翻成中文，翻不出
 * 来的原样显示。这里只列已知的翻译；新冒出来的组走 fallback，不需要改用例。
 */
const GROUP_LABELS: Record<string, string> = {
  general: '常规',
  gateway: '网关',
  benefits: '签到',
  qoder: 'Qoder',
};

/** 一项在接口里的样子（ListConfig 回的，字段是 camelCase）。 */
interface RpcItem {
  key: string;
  label: string;
  group: string;
}

/**
 * 从接口给的清单推出「界面应该长什么样」：按分组合并，组名用中文。
 *
 * 顺序照面板的画法：general、gateway 这两个固定的排前面，其余的组按清单里
 * 出现的先后接在后面（web/src/features/config/index.tsx 的 GROUP_ORDER）。
 */
function expectedGroups(items: RpcItem[]): Array<{
  tab: string;
  items: RpcItem[];
}> {
  const map = new Map<string, RpcItem[]>();
  for (const item of items) {
    const group = item.group || 'general';
    const list = map.get(group) ?? [];
    list.push(item);
    map.set(group, list);
  }
  const known = ['general', 'gateway'].filter((group) => map.has(group));
  const extra = [...map.keys()].filter((group) => !['general', 'gateway'].includes(group));
  return [...known, ...extra].map((group) => ({
    tab: GROUP_LABELS[group] ?? group,
    items: map.get(group) ?? [],
  }));
}

/** 「网关 (7)」→ { name: '网关', count: 7 }。 */
function parseTab(text: string): { name: string; count: number } {
  const match = /^(.*?)\s*\((\d+)\)/.exec(text.trim());
  if (!match) throw new Error(`tab 上的字看不懂：${text}`);
  return { name: match[1].trim(), count: Number(match[2]) };
}

test('配置页：界面上的项与 ListConfig 给的清单一致，分组 tab 是中文名（不是 gateway / benefits / qoder）', async ({
  app,
  screen,
  browser,
}) => {
  // 先问接口：面板启动时本来就会调 ListConfig，这里要同一份清单当基准。
  const listed = await adminRpc<{
    items?: RpcItem[];
  }>('ListConfig');
  const items = listed.items ?? [];
  expect(items.length).toBeGreaterThan(0);
  const groups = expectedGroups(items);

  await app.open();
  await login(screen);
  await screen.getByRole('link', { name: '配置' }).click();
  await expect(screen.getByRole('heading', { name: '配置' })).toBeVisible();

  const tabs = (await screen.getByRole('tab').allTextContents()).map(parseTab);
  // 分组与顺序：接口给出的每一组都在，先后也一致。服务端给的是英文的键，
  // 面板要翻译过来 —— 翻译漏了就会看见 gateway / benefits / qoder。
  expect(tabs.map((tab) => tab.name)).toEqual(groups.map((group) => group.tab));
  // 每组括号里的条数与接口给的那一组一致。
  expect(tabs.map((tab) => tab.count)).toEqual(groups.map((group) => group.items.length));
  // 英文的组名一个都不该露在界面上。
  for (const english of ['gateway', 'benefits', 'qoder', 'general']) {
    await expect(screen.getByRole('tab', { name: english })).toHaveCount(0);
  }

  // 打开就停在第一组（不是空白的一屏，也不是最后点过的那一组）。
  await expect(screen.getByRole('tab').first()).toBeSelected();

  // 面板不该露出来的内部设置：上游地址、端口、轮询窗口这些改了也没用 ——
  // 露出来只会让人改出坏状态。键名与短名字都不该出现。
  for (const internal of [
    'ROUTER_PORT',
    'MINIMAX_API_BASE',
    'QODER_POLL_INTERVAL_MS',
    'HEALTH_CACHE_MS',
  ]) {
    await expect(screen.getByText(internal, { exact: true })).toHaveCount(0);
  }

  // 每一项都在它那一组里：点进去，接口给的每个名字都要在，行数不多不少。
  for (const [index, group] of groups.entries()) {
    await screen.getByRole('tab').nth(index).click();
    for (const item of group.items) {
      await expect(screen.getByText(item.label, { exact: true })).toBeVisible();
    }
    // 表头一行 + 这一组的每一项：多出来的行就是界面自己编的项。
    await expect(screen.getByRole('row')).toHaveCount(group.items.length + 1);
  }

  await expect(browser).toHaveURL('/admin/config');
});

test('热设置：改「多久算静默」立刻生效，弹窗不说要重启，能清回默认值', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await login(screen);
  await screen.getByRole('link', { name: '配置' }).click();
  await screen.getByRole('tab', { name: /网关/ }).click();

  // 项名是后端给的 label（lib/admin/config.ts 的 LABELS），面板不自己写死文案。
  const row = screen.getByRole('row').filter({ hasText: '多久算静默' });
  await expect(row).toBeVisible();
  // 热设置：整页那句说的是「立刻生效」，不是「要重启」。
  await expect(
    screen.getByText('改动写进数据库，改完立刻生效。'),
  ).toBeVisible();

  await row.getByRole('button', { name: '改' }).click();
  const dialog = screen.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // 弹窗初值是秒（契约里是 180000 毫秒）。
  await expect(dialog.getByLabel('新值')).toHaveValue('180');
  await expect(dialog.getByLabel('新值')).toBeVisible();
  // 面板上填的是秒：5 秒（600000 毫秒的上限换算过来是 600 秒，不会越界）。
  await dialog.getByLabel('新值').fill('5');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();

  // 这一行立刻是新值，来源变成数据库覆盖。
  await expect(row).toContainText('5 秒');
  await expect(row).toContainText('数据库覆盖');

  // 服务端那边生效的也是这个值（面板上看到的不只是本地状态）。
  const listed = await adminRpc<{
    items?: Array<{ key: string; value: string; source: string }>;
  }>('ListConfig');
  const item = (listed.items ?? []).find(
    (entry) => entry.key === 'ROUTER_STREAM_IDLE_MS',
  );
  expect(item?.value).toBe('5000');
  expect(item?.source).toBe('database');

  // 再打开弹窗：新值在，且这一项说的是「立即生效」。热设置不该说要重启 ——
  // 说了会让人以为得重启一次才算，实际下一个请求就是新值。
  await row.getByRole('button', { name: '改' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('新值')).toHaveValue('5');
  await expect(dialog.getByText('写入数据库后立即生效。')).toBeVisible();
  await expect(dialog.getByText('重启', { exact: false })).toHaveCount(0);
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toBeHidden();

  // 收拾干净：清回默认值，别把这一轮的值留给这次的其余测试。
  await row.getByRole('button', { name: '清回默认' }).click();
  await expect(row).toContainText('180 秒');
  await expect(row).toContainText('默认值');

  await expect(browser).toHaveURL('/admin/config');
});

test('配置页：自定义会话头来自后端清单，写入后刷新仍在且来源是数据库覆盖', async ({
  app,
  screen,
  browser,
}) => {
  // 先问接口：这一行必须是后端 ListConfig 给的，不是面板自己编的设置项。
  const listed = await adminRpc<{
    items?: Array<{ key: string; label: string }>;
  }>('ListConfig');
  const item = (listed.items ?? []).find((entry) => entry.key === 'SESSION_HEADER');
  expect(item).toBeTruthy();
  expect(item?.label).toBe('自定义会话头');

  try {
    await app.open();
    await login(screen);
    await screen.getByRole('link', { name: '配置' }).click();
    await expect(screen.getByRole('heading', { name: '配置' })).toBeVisible();

    const row = screen.getByRole('row').filter({ hasText: '自定义会话头' });
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: '改' }).click();
    const dialog = screen.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('新值').fill('x-my-session');
    await dialog.getByRole('button', { name: '保存' }).click();
    await expect(dialog).toBeHidden();

    // 界面上立刻是新值，来源变成数据库覆盖。
    await expect(row).toContainText('x-my-session');
    await expect(row).toContainText('数据库覆盖');

    const saved = await adminRpc<{
      items?: Array<{ key: string; value: string; source: string }>;
    }>('ListConfig');
    const savedItem = (saved.items ?? []).find(
      (entry) => entry.key === 'SESSION_HEADER',
    );
    expect(savedItem?.value).toBe('x-my-session');
    expect(savedItem?.source).toBe('database');

    // 整页刷新后还在，不是只活在这一次渲染里。
    await browser.goto('/admin/config');
    await expect(screen.getByRole('heading', { name: '配置' })).toBeVisible();
    const after = screen.getByRole('row').filter({ hasText: '自定义会话头' });
    await expect(after).toContainText('x-my-session');
    await expect(after).toContainText('数据库覆盖');

    // 清回默认，不给后面的测试留状态。
    await after.getByRole('button', { name: '清回默认' }).click();
    await expect(after).not.toContainText('x-my-session');
    // 清理要清到「来源」这一层：只把值抹成空串、留着数据库覆盖，
    // 会把别人的环境变量态改成数据库态 —— 来源必须不再是「数据库覆盖」。
    await expect(after).not.toContainText('数据库覆盖');
  } finally {
    await adminRpc('SetConfig', {
      key: 'SESSION_HEADER',
      value: '',
      clear: true,
    }).catch(() => {});
  }
});

/**
 * 毫秒设置的另一半：填秒、落库毫秒，读回来的值列与弹窗初值也都是秒。
 *
 * 「热设置」那条钉的是写入路径；这条钉读回来的形状 —— 值列与初值都由
 * displayMilliseconds / msToSecondsText 从 ListConfig 的毫秒算出来，整页刷新
 * 之后不会变成 5000，也不会被四舍五入成别的数。
 */
test('毫秒设置：填 5 秒落库 5000 毫秒，刷新后值列仍说「5 秒」、初值仍是「5」', async ({
  app,
  screen,
  browser,
}) => {
  await app.open();
  await login(screen);
  await screen.getByRole('link', { name: '配置' }).click();
  await screen.getByRole('tab', { name: /网关/ }).click();

  const row = screen.getByRole('row').filter({ hasText: '多久算静默' });
  await row.getByRole('button', { name: '改' }).click();
  const dialog = screen.getByRole('dialog');
  await expect(dialog).toBeVisible();
  // 初值是秒：契约里的 180000 毫秒 → 180。
  await expect(dialog.getByLabel('新值')).toHaveValue('180');
  await dialog.getByLabel('新值').fill('5');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText('5 秒');

  try {
    // 整页刷新：值列那个「5 秒」是算出来的，不是某次保存留在内存里的。
    await browser.goto('/admin/config');
    await expect(screen.getByRole('heading', { name: '配置' })).toBeVisible();
    await screen.getByRole('tab', { name: /网关/ }).click();
    const after = screen.getByRole('row').filter({ hasText: '多久算静默' });
    await expect(after).toContainText('5 秒');
    await expect(after).toContainText('数据库覆盖');

    // 弹窗初值也是秒，不是 5000。
    await after.getByRole('button', { name: '改' }).click();
    await expect(dialog.getByLabel('新值')).toHaveValue('5');
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toBeHidden();

    // 传输层仍是毫秒：ListConfig 给的是 5000。
    const listed = await adminRpc<{
      items?: Array<{ key: string; value: string }>;
    }>('ListConfig');
    const item = (listed.items ?? []).find(
      (entry) => entry.key === 'ROUTER_STREAM_IDLE_MS',
    );
    expect(item?.value).toBe('5000');
  } finally {
    // 收拾干净：清回默认值，别把这一轮的值留给这次的其余测试。
    await adminRpc('SetConfig', {
      key: 'ROUTER_STREAM_IDLE_MS',
      value: '',
      clear: true,
    }).catch(() => {});
  }

  await expect(browser).toHaveURL('/admin/config');
});

/**
 * 填错的数字在面板层就被拦住：一个 SetConfig 都不发，字段下方出提示。
 *
 * 必须拦在面板层：服务端对数字项的脏值会静默落回默认值，用户看不到自己填错。
 * 请求数是拦着 SetConfig 那条路由数出来的 —— 只看「界面没变」不够：填 900 秒时
 * 服务端会把值按上限收下（存 600000），界面同样会变。
 */
test('毫秒设置填越界、填不进数字框的值：一个 SetConfig 都不发，字段下方出提示', async ({
  app,
  screen,
  browser,
}) => {
  // 真发出去的请求会被这条路由记下来；正常路径下一次都不该被调用。
  const sent: string[] = [];
  await browser.route('**/SetConfig', async (route) => {
    sent.push(route.request.postData ?? '');
    await route.fulfill({ status: 200, json: { ok: true } });
  });

  await app.open();
  await login(screen);
  await screen.getByRole('link', { name: '配置' }).click();
  await screen.getByRole('tab', { name: /网关/ }).click();

  const row = screen.getByRole('row').filter({ hasText: '多久算静默' });
  await row.getByRole('button', { name: '改' }).click();
  const dialog = screen.getByRole('dialog');
  const field = dialog.getByLabel('新值');
  await expect(field).toBeVisible();

  // 上限 600 秒（契约里的 600000 毫秒）：填 900 秒越界。
  await field.fill('900');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog.getByText('不能大于 600 秒')).toBeVisible();
  await expect(field).toHaveAttribute('aria-invalid', 'true');

  // 数字框不收字母（浏览器自己就拦）：框里是空的，保存同样被拦住。
  await field.fill('');
  await field.pressSequentially('abc');
  await expect(field).toHaveValue('');
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog.getByText('这一项不能为空')).toBeVisible();

  // 两次都被拦住：一个请求都没有。
  expect(sent).toEqual([]);

  // 弹窗留着让用户接着改；取消掉，库里什么都没动。
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toBeHidden();
  const listed = await adminRpc<{
    items?: Array<{ key: string; value: string; source: string }>;
  }>('ListConfig');
  const item = (listed.items ?? []).find(
    (entry) => entry.key === 'ROUTER_STREAM_IDLE_MS',
  );
  expect(item?.value).toBe('180000');
  expect(item?.source).toBe('default');
});

/**
 * 布尔项是下拉框：选「开启」落库的是 "true"，界面上的中文不外流到库里。
 *
 * 用「静默后自动续写」而不是 REQUIRE_API_KEY：e2e 的环境变量钉着后者
 * （e2e.config.ts 给了 false），改了也不生效，看不到落库的形状。
 */
test('布尔项：选「开启」值列说「开启」、落库 true；改回「关闭」值列说「关闭」', async ({
  app,
  screen,
}) => {
  const key = 'ROUTER_CONTINUE_ON_IDLE';

  /** 这一项在服务端的形状：值 + 来源。面板上看到的必须与它一致。 */
  const readValue = async (): Promise<{ value?: string; source?: string }> => {
    const listed = await adminRpc<{
      items?: Array<{ key: string; value: string; source: string }>;
    }>('ListConfig');
    return (listed.items ?? []).find((entry) => entry.key === key) ?? {};
  };

  await app.open();
  await login(screen);
  await screen.getByRole('link', { name: '配置' }).click();
  await screen.getByRole('tab', { name: /网关/ }).click();

  // 起手是代码里的默认值：关。
  expect(await readValue()).toMatchObject({ value: 'false', source: 'default' });

  const row = screen.getByRole('row').filter({ hasText: '静默后自动续写' });
  await expect(row).toBeVisible();
  // 值列说「关闭」，与弹窗里的下拉同一套词 —— 不是裸的 false。
  await expect(row).toContainText('关闭');
  await expect(row).not.toContainText('false');
  await row.getByRole('button', { name: '改' }).click();
  const dialog = screen.getByRole('dialog');
  const trigger = dialog.getByLabel('新值');
  // 下拉框上写的是给人看的中文，不是让人自己打 true。
  expect((await trigger.textContent())?.trim()).toBe('关闭');
  await trigger.click();
  await screen.getByRole('option', { name: '开启' }).click();

  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText('数据库覆盖');
  // 落库的是 true，不是界面上的「开启」。
  expect(await readValue()).toMatchObject({ value: 'true', source: 'database' });

  // 值列跟着下拉改口径：库里是 true，界面说「开启」。
  await expect(row).toContainText('开启');
  await expect(row).not.toContainText('true');

  // 改回「关闭」：值列也跟着说「关闭」，落库是 false。
  await row.getByRole('button', { name: '改' }).click();
  await expect(dialog).toBeVisible();
  expect((await dialog.getByLabel('新值').textContent())?.trim()).toBe('开启');
  await dialog.getByLabel('新值').click();
  await screen.getByRole('option', { name: '关闭' }).click();
  await dialog.getByRole('button', { name: '保存' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toContainText('关闭');
  await expect(row).not.toContainText('false');
  expect(await readValue()).toMatchObject({ value: 'false', source: 'database' });

  // 清回默认：回到后端给的默认值 false，不是空串，也不是残留的 true。
  await row.getByRole('button', { name: '清回默认' }).click();
  await expect(row).toContainText('关闭');
  await expect(row).toContainText('默认值');
  expect(await readValue()).toMatchObject({ value: 'false', source: 'default' });
});
