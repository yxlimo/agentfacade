# pi-lens / knip 清理（探针 + zcode 判据）

分支：`pi-subagents/be-core-pi-lens-knip-marketing.ts-sort-tools-probe.ts-214-no-unknown-returns-error-text-8d0682e7-dd8df4d-dbfa-s0-t0`

## 做了什么

- `tools/probe.ts`
  - `substitute` 不再返回 `unknown`：配置读进来时定形（`ProbeValue`），上游答复
    也定形（`UpstreamJson`），unknown 不往调用方流。
  - `JSON.parse`（配置）与 `new URL`（--fake 拼 URL）兜住：说清「哪份配置 / 哪条
    探针的 URL 不合法」，退出码仍是 2，不甩栈。
  - `import.meta.dirname!` 换成显式判空。
  - console：命令行工具的输出就是它的职责 —— 用 `tools/.pi-lens.json` 给
    `no-console-except-error` 开白（不写 30 条行内 disable）。
- `lib/zcode/marketing.ts`：`effectiveTimes.sort()[0]` 改成显式比较（ISO 字符串，
  字典序即时间序），行为不变。
- `lib/zcode/claim.ts` / `lib/zcode/auto-claim.ts`：嵌套三元改成 if/else；五个
  只在本文件内部用的导出去掉 `export`（实现留着）。

## 学到什么

- pi-lens 的 `rules.<id>.ignorePaths` 在项目级 `.pi-lens.json` 里可用，嵌套目录
  里的 `.pi-lens.json` 只管它下面那些文件。
- `no-console-except-error` 这条规则在 `lib/` + `tools/` 上一共 225 处命中 ——
  仓库没有另一套 logger，console.* 就是日志出口。

## 验证

`mise run typecheck`、`mise run test:probe`、`mise run test:zcode:claim`、
`mise run test:zcode`、`mise run check:misc`、`mise run privacy` 全绿。
新用例（配置不是合法 JSON）先红后绿验过。
