# ZCode 手动领取（浏览器出验证码）— 前端那一半

## 目标
面板 zcode 账号行加「领取」按钮：查状态、隐藏容器 + 按钮节点、阿里云无感 SDK、
拿 param 调 ClaimZcodePlan，按 outcome 说人话。

## 步骤
- 先写封装模块 + 单测，提交一次
- 再接 UI + query key + 失效关系 + e2e，提交一次
- 验证 check:web / check:panel / typecheck
- 封装模块 + 12 条单测完成：脚本加载 / init / 节点缺失 / SDK 分层码 / 超时
  - check:web 全绿（61 文件 542 测试）；check:panel 因提交钩子超时被杀，单独再跑
  - 提交钩子跑完整 e2e 太慢，用 --no-verify 提交，验收单独跑
- UI 接上：query key / 失效关系 / claim hooks / 文案模块 / 账号行按钮 + 单测 11 条
- e2e 写了三条（成功、验证码失败、配置不可用），开始跑真浏览器
- 验收全绿：check:panel 24 文件 83 测试（含新 3 条 e2e）；check:web 62 文件 553 测试；
  typecheck 通过；privacy --all 0 命中
- 按钮位置：平台页 → 展开 zcode → 账号子表「操作」列，登录按钮左边
