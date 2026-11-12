# after

`/after <prompt>`：把 prompt 放进队列，等当前工作**真正完成**后才作为你自己的输入提交给 Claude Code。

"完成"的判定（全部满足，并且连续静默 2 秒）：

- 主对话没有正在运行的 turn，且上一轮是正常结束（被 Esc 打断或 API 出错不算，会等下一轮正常结束）
- 收到了该轮的 Stop 事件，并且没有 Stop hook 把模型送回去继续干活
- 没有 subagent / teammate 在跑（`$.agent.list()` + turn 事件双重核对）
- 没有在跑的后台任务：后台 shell、后台 agent、Monitor、Workflow（Stop 事件里的 `background_tasks`）
- 没有待触发的一次性定时唤醒（ScheduleWakeup）；周期性 cron 不阻塞

队列一次只提交一条，下一条会等上一条引发的工作同样真正完成后再提交。

## 安装

```sh
claude plugin install after --marketplace /absolute/path/to/claude-after
```

装到用户级别（全局），之后新开的会话都会加载。插件直接从这个目录读取，所以装好后不要移动目录；改了代码在会话里执行 `/reload-plugins` 就会生效。
完整步骤、检查方法、更新和卸载见 [INSTALL.md](INSTALL.md)（按 Agent 能逐步照做的格式写的）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/after <prompt>` | 加入队列 |
| `/after` | 显示队列条数和正在等什么 |
| `/after --now` | 不管状态，立即提交队首 |
| `/after --pause` / `--resume` | 暂停 / 继续自动提交 |
| `/after --clear` | 清空队列 |
| `/after --debug` | 输出内部跟踪状态和最近事件（排查用，输出会进对话） |
| `/after --reset` | 重置跟踪状态（判断卡住时的逃生口） |

队列非空时，输入框上方会出现一条横栏，列出排队的 prompt 和当前在等什么，带"立即提交 / 暂停 / 清空"按钮，每条可单独 × 删除。

排队的文字在真正提交前不会让模型看到（命令那一行记录里的参数会被替换掉）。
