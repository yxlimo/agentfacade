# 上游空答复诊断日志

- 目标：把 `watchFinish` 已有的 `onFinish` 线接到 `open-platform.ts`，并在空答复 warn 里记结束原因与片段结构；只加观测，不改行为
- 状态：开工

- 已接通 deliver 的 finish 线：`watchFinish` 计正文/思考/工具片段，OpenAI 与 Anthropic（原生 + 转 OpenAI）两条都把结构交给 `onFinish`；open-platform 两个调用点接线，handle 的 uctx 存 `lastFinish`
- 类型检查通过；尚未测试
- 测试：`test/empty-answer-check.ts` 新增假流用例（stop / length / 无 usage），pass=28 fail=0
- 反证：把 `emptyAnswerDetail` 的诊断字段去掉后，stop 两条与「未给」两条真红（pass=22 fail=6），已还原
