# after

`/after <prompt>`：像 Claude Desktop 的排队消息一样，把 prompt 放进队列，等 Claude 做完当前的事再作为你自己的输入提交。排队期间可以编辑、删除、立即提交。

"做完"的判定（全部满足，并且连续静默 2 秒）：

- 主对话没有正在运行的 turn，且上一轮是正常结束（被 Esc 打断或 API 出错不算，会等下一轮正常结束）
- 上一条由 /after 提交的 prompt 那一轮已经结束
- 没有 subagent / teammate 在跑（`$.agent.list()` + subagent 的 turn 事件）

不等后台 shell、Monitor、定时唤醒：和 Desktop 的排队消息一样，Claude 这一轮说完就发。
队列一次只提交一条。

## 安装

```sh
claude plugin install after --marketplace /absolute/path/to/claude-after
```

装到用户级别（全局），之后新开的会话都会加载。插件直接从这个目录读取，所以装好后不要移动目录；改了代码在会话里执行 `/reload-plugins` 就会生效。
完整步骤、检查方法、更新和卸载见 [INSTALL.md](INSTALL.md)（按 Agent 能逐步照做的格式写的）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/after <prompt>` | 加入队列（正在编辑某条时，回车会原位替换那一条） |
| `/after --edit N` | 把第 N 条填进输入框编辑（默认第 1 条），编辑期间这条不会被提交 |
| `/after` | 显示队列条数和正在等什么 |
| `/after --now` | 不管状态，立即提交队首 |
| `/after --pause` / `--resume` | 暂停 / 继续自动提交 |
| `/after --clear` | 清空队列 |
| `/after --debug` | 输出内部跟踪状态和最近事件（排查用，输出会进对话） |
| `/after --reset` | 重置跟踪状态（判断卡住时的逃生口） |

队列非空时，输入框上方会出现一条横栏，列出排队的 prompt 和当前在等什么，带"立即提交 / 暂停 / 清空"按钮。每条有"编辑"和 × 删除：点"编辑"会把 `/after 原文` 填进输入框（输入框里有你自己没发的内容时不会覆盖），改完回车原位保存，点"取消"放弃。

排队的文字在真正提交前不会让模型看到（命令那一行记录里的参数会被替换掉）。
