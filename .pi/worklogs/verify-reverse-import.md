# verify 的反向依赖选组

## 背景

清 `lib/router/catalog.ts` 的死导出时，测试脚本的 import 断了，但按路径算的
规则表只选了 check:admin + check:routing —— 断掉的那个测试属于 check:kinds，
没被选上。tsconfig 的 include 又不覆盖 test/**，tsc 也不会发现。

## 计划

- `tools/verify-changes.ts` 里读 mise.toml，解析 check:* 的 depends → test:*
  名字，再解析 test:* 的 run → 脚本路径。不手抄清单。
- 扫测试脚本的直接 import（一跳；已知上限写进注释）。命中的门禁并进计划，
  打印里写明「import → check:X  [源文件 被 脚本 直接 import]」。
- 解析失败 / 零个任务解析出来 → 全量 check。
- tests/** 不进图。
- `test/verify-changes-check.ts` 加回归用例。已有 25 项没有删减；其中
  handle.ts 那项把预期从 2 组加到 3 组 —— admin 的 model-visibility 测试
  确实直接 import 了它，这是新规则抓到的真依赖，不是放宽。

## 状态

- `test:verify` 32 项全过，typecheck 过。
- 反证真做过：临时让 `matchImports` 返回空，事故 case 真红（28 过 4 没过），
  已还原。
- 待跑：`mise run verify --plan --base 0009c6c`。

