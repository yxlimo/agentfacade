# 阿里云验证码 SDK 契约修正

- 下载公开 SDK 到 /tmp/AliyunCaptcha.js，确认 success 传字符串（verifyType 1.0 裸 CertifyId，3.0 base64），mode 只接受 popup/embed。
- 重写 SDK 封装：Config 前置、mode popup、选择器、四回调、无参 start、无感退化 show()、success 原样字符串。
- 假 SDK 改成真契约；20 个前端单测绿。
- 反证：旧实现跑 mode 守门用例红（code INIT_FAIL 而非 modeError）。
- UI 接线改成选择器，交互式通过时如实提示并把提示与领取结论合并；e2e 假 SDK 同步真契约。
