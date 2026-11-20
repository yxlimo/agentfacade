# claim-result-unmount

任务：领取成功后 offers 清空导致结果文案随组件一起被卸载

## 记录

- 开工：任务上下文文件不存在，以派单消息为准

- 反证用例已写：领取成功后让 GetZcodeClaimStatus 返回 offers:[]。改动前真红：
  ```
  FAIL  src/features/upstreams/claim-button.test.tsx > ZCode 账号行的领取按钮 > 领取成功后 offer 变空：仍显示已领取额度与这次的结论，按钮不再可点
  TestingLibraryElementError: Unable to find an element with the text: 已领取额度. ...
   ❯ src/features/upstreams/claim-button.test.tsx:193:25
   Test Files  1 failed (1)
        Tests  1 failed | 12 skipped (13)
  ```
- 生成物缺失，跑了 `mise run proto`（只生成，未改契约与生成物源码）
- 主代理扩权：tests/panel-zcode-claim.e2e.ts 只改定位字面量
- 文案键不变，值改为 领取额度 / 领取额度中 / 已领取额度（en: Claim quota / Claiming… / Quota claimed）

- 修复落地：`claim-button.tsx` 把 `return null` 收窄为「没有 offer 且没有本次结果」；有结论无 offer 时渲染不可点的状态块（成功时带 `upstreams.claimed` 抬头 + `wordingOf` 文本），失败路径文案原样保留
- e2e / 单测里的按钮定位字面量跟随文案改名，`exact: true` 与断言强度未改
- 验证：`cd web && pnpm test` 75 文件 / 598 用例全绿；`mise run web:typecheck` 通过
- grep 旧定位字面量在 `tests/` 与 `web/src/` 已 0 命中
