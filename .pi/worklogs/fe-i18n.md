# fe: 面板 i18n（i18next，zh/en）

任务：i18n 基础设施 + overview / login+auth / usage 三个目录迁移。

## 计划

1. 基础设施：`web/src/lib/i18n/`（实例、CustomTypeOptions、zh/en 词典）、LangToggle（头部）、format.ts 跟随语言、单测。提交。
2. 迁移三个目录。提交。
3. e2e：`tests/panel-i18n.e2e.ts`。验证 `check:web` / `check:panel` / `typecheck`。

## 日志

- 开工。依赖 i18next@27.2.1 / react-i18next@18.0.2 已在 package.json（d9f3d86）。
- 词典用扁平键（点号前缀），en 类型 `Record<keyof typeof zh, string>` —— 键集不一致 tsc 先报错；运行时一致性的那条测试也写。
- 复数走 i18next `_one/_other` + count（en 生效；zh 只有 other，词典里补同名键以满足 en 的键集约束）。
- format.ts 不改签名：内部按 `i18n.language` 选 Intl locale，中文单位词走 t。
