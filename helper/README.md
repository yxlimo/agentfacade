# buddy-helper

一个脚本，只用 Python 3 标准库（不用装任何东西）：

| 脚本 | 干什么 |
| --- | --- |
| `buddy_todo.py` | 盯着 MiniMax 的额度，额度回来（或到点）之后给当前目录的会话发一条消息 |

跑法（在主仓根目录下）：

```bash
python3 helper/buddy_todo.py
```

也可以用 mise：`mise run helper:todo`。

## 盯额度 + 发消息

在工作目录写一个 `.buddy-todo.md`，内容就是要发的话：

```markdown
# 收尾

- 把面板那个改动过一遍
- 跑一次 `mise run test`
```

然后：

```bash
python3 helper/buddy_todo.py              # 等额度回来再发
python3 helper/buddy_todo.py --now        # 立刻发，不等额度
python3 helper/buddy_todo.py --at 14:30   # 到点发（本地时间，也接受 14:30:00）
python3 helper/buddy_todo.py --client opencode
python3 helper/buddy_todo.py --dry-run    # 只打印要发的命令，不发
```

流程：

1. 读当前目录的 `.buddy-todo.md`（`--file` 可以换路径）；没有就报错退出。
2. 读网关 `/health` 里 MiniMax 各账号的 `general` 窗口额度，算出什么时候回来。
   默认就等到那个时候；`--now` 不看额度，`--at` 到点会重读一次额度，不可用就接着等（除非 `--force`）。
3. **列出当前目录的会话让你挑** —— 防止发错地方：

   ```text
   [1] pi        01a17814-ad50-775e       (2026-10-26 11:59)  给网关接个七牛
   [2] opencode  ses_e8f1b3e2cffeh5       (2026-10-25 11:01)  Pi 隐藏调用 js_reserve skill
   [3] pi                                    (新开一个 pi 会话)
   选哪个？(默认 1，回车确认，q 退出)
   ```

   自动化时用 `--session <编号或 id>` 跳过这步。
4. 发出去。pi 走 `pi -p --session <transcript 的绝对路径> -- <内容>`，
   opencode 走 `opencode run -s <id> -- <内容>`。
5. 发成功了 `.buddy-todo.md` 改名成 `.buddy-todo.sent-<YYYYMMDD-HHMMSS>.md` 存档；
   失败了原样留着，stderr 打印前 500 字。

退出码：`2` 没有待办文件，`3` 算不出额度什么时候回来，`4` 发送失败。

## 自检

```bash
mise run test:helper
```

离线跑，不联网、不跑真客户端。
