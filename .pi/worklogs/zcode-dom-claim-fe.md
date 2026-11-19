# ZCode 手动领取（浏览器出验证码）— 前端那一半

## 目标
面板 zcode 账号行加「领取」按钮：查状态、隐藏容器 + 按钮节点、阿里云无感 SDK、
拿 param 调 ClaimZcodePlan，按 outcome 说人话。

## 步骤
- 先写封装模块 + 单测，提交一次
- 再接 UI + query key + 失效关系 + e2e，提交一次
- 验证 check:web / check:panel / typecheck
