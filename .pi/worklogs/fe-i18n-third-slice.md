# i18n 第三片（open-platforms / models / balance）
- 开工：任务上下文文件不存在，按派单描述执行
- 目标：三个目录里用户可见中文迁进词典，注释不动，后端原话不翻
- 每个目录：改生产文件 + 英文组件测试 + 单测 + 单独提交
- open-platforms：生产文件用户可见串全部迁到 openPlatforms.* 词条（130 条 zh/en），新增 open-platforms-i18n.test.tsx（en/zh 两例），web 单测 67 files/577 tests 全绿，typecheck 通过
- models：生产文件用户可见串迁到 models.* 词条（约 98 条 zh/en），新增 models-i18n.test.tsx（en/zh 两例），web 单测 68 files/579 tests 全绿，typecheck 通过
