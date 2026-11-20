# verify 选组漏洞：smoke.sh 里的测试没有 mise 任务

- 任务：给 `test/config-check.ts` 与 `test/workbuddy-check.ts` 补 mise 任务与 check 依赖；在 `test/verify-changes-check.ts` 加守门用例；做反证。
- 发现命名冲突：`test:config` 已被 config-restart-check.ts 占用。主代理决定新增任务叫 `test:config:sources`，保留原任务不动；config 那组放 check:admin（脚本直接 import lib/admin/config.ts，同组已有 test:config 测配置的另一半）。
- 已给两个脚本建任务（config:sources 进 check:admin，workbuddy 进 check:misc），加了 smoke.sh 守门用例与 workbuddy 路径的 check:misc 断言；test:verify 37 项全过，verify --plan 显示 check:misc 由 test/workbuddy-check.ts 的反向依赖命中。
- 交付要求计划里要能看到 test:workbuddy 这个名字，当前只打印脚本路径；准备给 ImportHit 加 test 字段并在计划里打出来（tools/verify-changes.ts，派单允许）。
- 计划输出加了 `经 test:*` 的任务名，交付要求能直接看到 test:workbuddy；test:verify 38 项全过，typecheck 过。
- 反证：从 mise.toml 临时删掉 test:workbuddy → test:verify 35 过 3 没过（守门、workbuddy 路径 check:misc、计划里的 test 任务名）；恢复后 38 项全过，git diff 为空。
- 收尾：test:config:sources 17 passed、test:workbuddy 170 passed、privacy --all 0 命中、typecheck 通过、verify --plan 输出 check:misc + 经 test:workbuddy。
