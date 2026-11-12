# INSTALL — for agents

Install guide for the Claude Code plugin `after` (a function-hooks mod, which provides the `/after` slash command).
Written for an AI agent to follow step by step: every step lists the command, the expected result and what to do on failure.
Run the steps in order. Do not skip the checks.

## Facts

| Item | Value |
| --- | --- |
| Plugin name | `after` |
| Marketplace name | `claude-after` (this repository is itself a one-plugin marketplace: `.claude-plugin/marketplace.json`, `source: "./"`) |
| Installed plugin id | `after@claude-after` |
| Kind | function-hooks mod: `hooks/hooks.json` → `{ "modules": ["./register.tsx"] }` |
| Built and tested on | Claude Code `2.1.322` |
| Runtime dependencies | none (no npm install, no build step) |
| Default install scope | `user` (global: every new Claude Code session on this machine) |

`<REPO>` below means the absolute path of this repository's root, the folder that holds this file and `.claude-plugin/`.
On the original machine it is `/home/kiritow/workspace/claude-after`.

## Step 0: Preconditions

1. `claude --version` prints a version. If the command is not found, stop: Claude Code is not installed.
2. `test -f <REPO>/.claude-plugin/plugin.json && test -f <REPO>/.claude-plugin/marketplace.json && echo ok` prints `ok`.
   If it does not, `<REPO>` is wrong: find the folder that holds both files.
3. If the repository is not on this machine yet, clone it first (`git clone <url> <REPO>`), then use the absolute path of the clone.
4. The folder must stay where it is after the install. The installed plugin is **read from this folder**, not copied.
   Moving or deleting the folder breaks the plugin. Pick its final location before installing.

## Step 1: Make sure it will not load twice

Two loaded copies of this mod mean two pollers, and **each queued prompt could be submitted twice**.
Before installing, check that no other copy is loaded:

```sh
claude plugin list 2>&1 | grep -n "after@" || echo "no after plugin installed"
grep -n "CLAUDE_CODE_PLUGIN_DIRS" ~/.claude/settings.json 2>/dev/null || echo "no CLAUDE_CODE_PLUGIN_DIRS"
```

- `after@claude-after` already listed with `Read from: <REPO>`: it is already installed. Skip to Step 3.
- `after@` listed with any other marketplace or path: uninstall that copy first (`claude plugin uninstall <that id>`), or ask the user.
- `CLAUDE_CODE_PLUGIN_DIRS` names this folder or another copy of it: remove that entry, or do not install (use one way only).
- Also do not start sessions with `claude --plugin-dir <REPO>` once it is installed.

## Step 2: Install (global, user scope)

```sh
claude plugin install after --marketplace <REPO> --scope user < /dev/null
```

Expected output (exit code 0):

```
Adding marketplace…
✔ Successfully added marketplace: claude-after (declared in user settings)
Installing plugin "after@claude-after"...✔ Successfully installed plugin: after@claude-after (scope: user)
```

- If the marketplace `claude-after` was added before, the first line can be missing. That is fine.
- `--json` prints one machine-readable result line instead, if you need to parse it.
- No prompt should appear (the plugin declares no command source). If one does, stop and show it to the user. Do not pass `-y` without the user's consent.
- Installing for one project only: use `--scope project` (shared via the project's `.claude/settings.json`) or `--scope local`, run from inside that project.
- Inside an interactive session the same install is `/plugin install after --marketplace <REPO>`.
  Then answer `y` to add the marketplace and pick the `user` scope.

## Step 3: Verify

```sh
claude plugin list 2>&1 | grep -A4 "after@claude-after"
```

Expected:

```
  ❯ after@claude-after
    Version: 0.1.0
    Read from: <REPO>
    Scope: user
    Status: ✔ enabled
```

If `Status` is disabled, run `claude plugin enable after@claude-after`.

Optional static checks (no session needed):

```sh
claude plugin validate <REPO>   # must end with "✔ Validation passed" (warnings about README/LICENSE/icon are for the public directory, ignore them)
claude plugin test <REPO>       # must report "5 pass, 0 fail" (or more passes if tests were added)
```

Functional check (needs a person at an interactive session, so tell the user to do it):

1. Start a **new** session with `claude`. Sessions that were already running before the install do not have the plugin yet.
2. Type `/after`. Expected: a toast `/after: 队列为空`. The command also shows in the `/` typeahead.
3. Type `/after say hi`. Expected: a band above the prompt listing the item. About 2 seconds later (when nothing is running) the prompt `say hi` is submitted as the user's own message.

## Update

The plugin is read from `<REPO>` directly, so an update is just new files in the folder:

1. `git -C <REPO> pull` (or edit the files).
2. New sessions pick the change up automatically. In a running session, run `/reload-plugins`.

No version bump and no reinstall are needed.

## Uninstall

```sh
claude plugin uninstall after@claude-after
claude plugin marketplace remove claude-after   # optional: also forget the marketplace
```

Running sessions keep it until restarted (or until `/reload-plugins`). The repository folder can be deleted after that.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `/after` is an unknown command | The session started before the install. Start a new session, or run `/reload-plugins`. Then check Step 3. |
| A queued prompt was submitted twice | Two copies are loaded. Redo Step 1 and keep exactly one. |
| The queue never fires | The band says what it waits for. A persistent `Monitor`, a pending one-shot `ScheduleWakeup` or a `/loop` keeps it waiting by design. `/after --now` submits the head item at once. `/after --resume` if it says `已暂停` (paused). |
| A hook error line in the transcript naming `after` | Run `claude --debug` and look for lines starting with `after:`. Run `claude plugin validate <REPO>`. |
| Type-checking with `tsc -p <REPO>` fails with a missing `.claude-plugin/types/tsconfig.json` | That folder is written by Claude Code only when it loads the folder as a hot-reloaded mod. Start once with `claude --plugin-dir <REPO>` (interactive, and only while the installed copy is disabled, see Step 1) to have it written. Otherwise use the tsconfig from the header of the engine's `claude-code.d.ts`. The folder is git-ignored. |

## Files

```
.claude-plugin/plugin.json        manifest (name, version, "types")
.claude-plugin/marketplace.json   makes this repo installable as marketplace "claude-after"
hooks/hooks.json                  names the hooks module
hooks/register.tsx                the mod: /after command, work tracking, band above the prompt
types/index.d.ts                  $.state contract (queue, status, paused, tracker)
tests/after.test.tsx              tests run by `claude plugin test`
tsconfig.json                     extends the engine-written .claude-plugin/types/tsconfig.json
README.md                         what the mod does, for people
INSTALL.md                        this file
```
