# later

`/later <prompt>`: queue a prompt, like Claude Desktop's queued messages. It is submitted as your own message once Claude has finished what it is doing. While it waits you can edit it, remove it, or submit it at once.

`/after` is an alias of `/later`: the two are identical. (The plugin itself is named `after`, installed as `after@claude-after`.)

"Finished" means all of the following, holding for 2 seconds of quiet:

- No main-conversation turn is running, and the last one ended normally. An interrupted turn (Esc) or one that died on an API error does not count: the queue waits for the next turn that ends normally.
- The turn started by the previous queued prompt has ended.
- No subagent or teammate is running (`$.agent.list()` plus the subagents' turn events).

Background shells, monitors and scheduled wakeups are not waited for: as with Desktop's queued messages, the prompt goes as soon as Claude finishes its turn.
The queue submits one prompt at a time.

## Install

```sh
claude plugin install after --marketplace /absolute/path/to/claude-after
```

This installs at user scope (global): every new session loads it. The plugin is read from this folder directly, so do not move the folder after installing. After editing the code, run `/reload-plugins` in a session to pick up the change.
Full steps, checks, update and uninstall are in [INSTALL.md](INSTALL.md), written so an agent can follow it step by step.

## Commands

Every `/later` below can also be written `/after`.

| Command | What it does |
| --- | --- |
| `/later <prompt>` | Add to the queue. While an item is being edited, Enter replaces that item in place. |
| `/later --edit N` | Put item N (default 1) in the prompt box for editing. The item is held, and not submitted, while it is edited. |
| `/later` | Show how many items are queued and what the queue waits for. |
| `/later --now` | Submit the head item right away, whatever the state. |
| `/later --pause` / `--resume` | Pause / resume automatic submission. |
| `/later --clear` | Empty the queue. |
| `/later --debug` | Print the internal tracking state and recent events (for troubleshooting; the output goes into the conversation). |
| `/later --reset` | Reset the tracking state (the way out if it seems stuck). |

## The band above the prompt

While the queue is not empty, a band above the prompt box lists the queued prompts and what the queue waits for. It has three buttons: 立即提交 (submit now), 暂停 / 继续 (pause / resume) and 清空 (clear).

Each item has 编辑 (edit) and × (remove). 编辑 puts `/later <text>` in the prompt box (it never overwrites a draft you have typed yourself). Edit it and press Enter to save it in place, or press 取消 (cancel) to give up.

The band, the toasts and the edit line use the command name you last typed, `/later` or `/after`.

The interface text (band, toasts) is in Chinese. The status line reads `等待: …` (waiting: …) with reasons such as `Claude 正在工作` (Claude is working), `N 个 subagent 运行中` (N subagents running), `第 1 条正在编辑` (item 1 is being edited) or `已暂停` (paused), and `即将提交…` (about to submit) once everything is clear.

## Privacy

The queued text is not shown to the model before it is actually submitted: the arguments in the command's transcript row are replaced.
