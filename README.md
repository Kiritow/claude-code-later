# later

A Claude Code plugin that adds `/later <prompt>`: queue a prompt, like Claude Desktop's queued messages. It is submitted as your own message once Claude has finished what it is doing. While it waits you can edit it, remove it, or send it at once.

`/after` is an alias of `/later`: the two are identical.

Repository: <https://github.com/Kiritow/claude-code-later>

## Install

In a Claude Code session:

```
/plugin install later --marketplace Kiritow/claude-code-later
```

Answer `y` to add the marketplace, then pick the user scope.

Or from a shell:

```sh
claude plugin install later --marketplace Kiritow/claude-code-later
```

In the Claude desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Kiritow/claude-code-later`, then Add plugin.

The plugin installs at user scope (every new session loads it) as `later@claude-code-later`. Start a new session, or run `/reload-plugins` in a running one.

Step-by-step instructions with checks, update and uninstall, written so an agent can follow them: [INSTALL.md](INSTALL.md).

## Usage

```
/later run the full test suite and fix what fails
```

"Done" means all of the following, holding for 2 seconds of quiet:

- No main-conversation turn is running, and the last one ended normally. An interrupted turn (Esc) or one that died on an API error does not count: the queue waits for the next turn that ends normally.
- The turn started by the previous queued prompt has ended.
- No subagent or teammate is running.

Background shells, monitors and scheduled wakeups are not waited for: as with Desktop's queued messages, the prompt goes as soon as Claude finishes its turn. The queue submits one prompt at a time.

### Commands

Every `/later` below can also be written `/after`.

| Command | What it does |
| --- | --- |
| `/later <prompt>` | Add to the queue. While an item is being edited, Enter replaces that item in place. |
| `/later --edit N` | Put item N (default 1) in the prompt box for editing. The item is held, and not submitted, while it is edited. |
| `/later` | Show how many items are queued and what the queue waits for. |
| `/later --now` | Send the head item right away, whatever the state. |
| `/later --pause` / `--resume` | Pause / resume automatic submission. |
| `/later --clear` | Empty the queue. |
| `/later --debug` | Print the internal tracking state and recent events (for troubleshooting; the output goes into the conversation). |
| `/later --reset` | Reset the tracking state (the way out if it seems stuck). |

### The band above the prompt

While the queue is not empty, a band above the prompt box lists the queued prompts and shows what the queue waits for, for example `waiting: Claude is working`, `waiting: 1 subagent running`, `waiting: item 1 is being edited` or `waiting: paused`, then `about to submit…` once everything is clear. Its buttons: **Send now**, **Pause** / **Resume**, **Clear**.

Each item has **Edit** and **×** (remove). **Edit** puts `/later <text>` in the prompt box (it never overwrites a draft you have typed yourself); change it and press Enter to save it in place, or press **Cancel** to keep it as it was. The band, the toasts and the edit line use the command name you last typed, `/later` or `/after`.

### Privacy

The queued text is not shown to the model before it is actually submitted: the arguments in the command's transcript row are replaced.

## Development

```sh
git clone https://github.com/Kiritow/claude-code-later.git
claude plugin install later --marketplace "$PWD/claude-code-later"
```

Installed from a local folder, the plugin is read from that folder directly: after editing, run `/reload-plugins` in a session. Do not move the folder, and do not install it from GitHub and from a folder at the same time (two copies would send each queued prompt twice).

```sh
claude plugin validate .   # manifest and hooks module
claude plugin test .       # tests/later.test.tsx
```

Notes:

- The hooks module is `hooks/register.tsx`; its `$.state` contract is `types/index.d.ts`.
- It does not use the classic `Stop` event: a higher-tier built-in plugin can send that event on past other plugins' hooks. Turn events (`turn.start`, `turn.complete`) and calls on `$` (`$.agent.list()`) reach every plugin.
- Built and tested on Claude Code 2.1.322. The plugin API is early access and may change between releases.
