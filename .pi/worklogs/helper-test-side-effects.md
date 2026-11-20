# helper 测试的对外副作用（待办 #70）

- 任务：找出 `helper/test_buddy.py` 里真发/真跑子进程的用例，改成完全离线，保持 CLI 行为不变
- 范围：只碰 `helper/**`

## 定位与证据

- 改前：给 `subprocess.run` 打桩跑全套 helper 测试，看到三条真实调用
  `[TRACE] subprocess.run argv=['opencode', 'run', '--help'] cwd=None`
  来源是 `OpenCodeFlagsTest`（三条：test_every_flag_we_pass_is_documented /
  test_the_message_is_a_positional_argument / test_the_prompt_is_the_last_argument），
  它的 `setUp` 无条件 `subprocess.run(["opencode", "run", "--help"])`。机器上确实装了
  opencode（`~/.nix-profile/bin/opencode`），三条都真跑了。
- `SendCommandTest` 那三条只拼 argv，没有进程/网络/文件副作用，不需要改。
- `ArchiveTest` 的归档写在 `TemporaryDirectory()` 里并随用例销毁，前后 /tmp 里没有
  残留 `.buddy-todo.sent-*`，也没有写用户目录；它的 runner 本来就是替身。
- 改后同一条带 trace 的命令：零条 `[TRACE]`，44 个测试全绿，没有新归档文件。

## 改动

- `helper/buddy_todo.py`：新增 `read_opencode_help(runner=None, timeout=60)`，把「读帮助」
  抽成可注入的一层，默认仍走 `common.run_command`，CLI 发送路径没动。
- `helper/test_buddy.py`：删掉 `subprocess` import 与靠本机是否装了 opencode 的
  `skipTest`；`OpenCodeFlagsTest` 改用录制的 `helper/fixtures/opencode-run-help.txt`，
  经注入 runner 读文本，断言 argv/cwd/timeout、退出码分支、stderr 合并、flag 齐备、
  位置参数与命令形状，不只是「替身被调用过」。
- `helper/fixtures/opencode-run-help.txt`：合成的 CLI 帮助文本样例（公开帮助形状）。

## 反证

- 临时把 `send_command` 的 `--` 改成 `--prompt` 后，
  `test_every_flag_we_pass_is_documented` 红：`--prompt 不是 opencode run 的 flag`；
  恢复后绿。新断言确实钉住了行为。

## 验证

- `mise run test:helper`：44 passed
- `mise run check:misc`：全绿（pass=143 fail=0），privacy 0 条命中
- CLI 默认 runner 已核对：`read_opencode_help()` 不传 runner 时仍调
  `common.run_command(["opencode", "run", "--help"], timeout=60)`；
  `mise run helper:todo` 的真发送路径未改。

## 其它同类风险点

- `common.py` 里还有两处真 `subprocess.run`：`_run_opencode_list` 与 `run_command`。
  两者都有 runner 注入口（`opencode_sessions(runner=...)`、`deliver(runner=...)`），
  现有测试都传了替身，全套 trace 里没有它们的调用。保留实实现是 CLI 真发送所需。
- `common.http_get_json` 是真 HTTP，但现有测试只调 `parse_health`/`resolve_gateway`，
  没有测试触发它。
