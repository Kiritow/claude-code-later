# INSTALL — for agents

Install guide for the Claude Code plugin `later`. It provides the `/later` slash command and its alias `/after` (identical).
Written for an AI agent to follow step by step: every step lists the command, the expected result and what to do on failure.
Run the steps in order. Do not skip the checks.

## Facts

| Item | Value |
| --- | --- |
| Plugin name | `later` |
| Slash commands | `/later` (main), `/after` (alias, identical) |
| Repository | <https://github.com/Kiritow/claude-code-later> (public), GitHub shorthand `Kiritow/claude-code-later` |
| Marketplace name | `claude-code-later` (the repository is itself a one-plugin marketplace: `.claude-plugin/marketplace.json`, `source: "./"`) |
| Installed plugin id | `later@claude-code-later` |
| Kind | function-hooks mod: `hooks/hooks.json` → `{ "modules": ["./register.tsx"] }` |
| Built and tested on | Claude Code `2.1.322` |
| Runtime dependencies | none (no npm install, no build step); `git` and access to github.com for the GitHub install |
| Default install scope | `user` (global: every new Claude Code session on this machine) |
| Legacy name | Before it was renamed, the plugin was `after` from marketplace `claude-after` (id `after@claude-after`). Remove that one first (Step 2). |

## Step 0: Preconditions

1. `claude --version` prints a version. If the command is not found, stop: Claude Code is not installed.
2. For the GitHub install: `git ls-remote https://github.com/Kiritow/claude-code-later HEAD` prints one line with a commit hash. If it fails, stop and report the network or git problem to the user.

## Step 1: Choose the source

- **A. GitHub (default, for using the plugin).** Claude Code keeps its own copy. Updates come with `claude plugin update`.
- **B. A local clone (for developing the plugin).** The plugin is read from the clone's folder directly: an edit is picked up with `/reload-plugins`. The folder must stay where it is.

Use B only if the user says they want to change the plugin's code. Otherwise use A.

## Step 2: Make sure it will not load twice

Two loaded copies mean two pollers, and **each queued prompt could be submitted twice**. Check:

```sh
claude plugin list 2>&1 | grep -nE "later@|after@" || echo "none installed"
claude plugin marketplace list 2>&1 | grep -nE "claude-code-later|claude-after" || echo "no marketplace"
grep -n "CLAUDE_CODE_PLUGIN_DIRS" ~/.claude/settings.json 2>/dev/null || echo "no CLAUDE_CODE_PLUGIN_DIRS"
```

- `after@claude-after` listed (legacy name): remove it.
  ```sh
  claude plugin uninstall after@claude-after
  claude plugin marketplace remove claude-after
  ```
- `later@claude-code-later` already listed: it is installed. If its source matches the one chosen in Step 1, skip to Step 4.
  Otherwise uninstall it (`claude plugin uninstall later@claude-code-later`, then `claude plugin marketplace remove claude-code-later`) before installing from the other source.
- Any other `later@...` or `after@...` id: ask the user before removing it. It may be a different plugin.
- `CLAUDE_CODE_PLUGIN_DIRS` names a copy of this plugin: remove that entry, or do not install. Use one way only.
- Once it is installed, do not start sessions with `claude --plugin-dir <folder of this plugin>`.

## Step 3A: Install from GitHub

```sh
claude plugin install later --marketplace Kiritow/claude-code-later --scope user < /dev/null
```

Expected: exit code 0, and the output ends with

```
✔ Successfully installed plugin: later@claude-code-later (scope: user)
```

It may first print `Adding marketplace…` and `✔ Successfully added marketplace: claude-code-later (declared in user settings)`.

- `--json` prints one machine-readable result line instead, if you need to parse it.
- No prompt should appear (the plugin declares no command source). If one does, stop and show it to the user. Do not pass `-y` without the user's consent.
- One project only: `--scope project` (shared through the project's `.claude/settings.json`) or `--scope local`, run from inside that project.
- Inside an interactive session the same install is `/plugin install later --marketplace Kiritow/claude-code-later`. Answer `y` to add the marketplace, then pick the user scope.

## Step 3B: Install from a local clone

Pick the folder's final location first (the plugin is read from it). `<CLONE>` is its absolute path.

```sh
git clone https://github.com/Kiritow/claude-code-later.git <CLONE>
claude plugin install later --marketplace <CLONE> --scope user < /dev/null
```

Expected: exit code 0, output ending with `✔ Successfully installed plugin: later@claude-code-later (scope: user)`.

## Step 4: Verify

```sh
claude plugin list 2>&1 | grep -A4 "later@claude-code-later"
```

Expected: a block for `later@claude-code-later` with `Scope: user` and `Status: ✔ enabled`. For a local clone (3B) it also shows `Read from: <CLONE>`.
If `Status` is disabled, run `claude plugin enable later@claude-code-later`.

Optional static checks, for a local clone:

```sh
claude plugin validate <CLONE>   # must end with "✔ Validation passed" (warnings about README/LICENSE/icon are for the public directory; ignore them)
claude plugin test <CLONE>       # must report "10 pass, 0 fail" (or more passes if tests were added)
```

Functional check (needs a person at an interactive session, so tell the user to do it):

1. Start a **new** session with `claude`. Sessions that were running before the install do not have the plugin yet (or run `/reload-plugins` in them).
2. Type `/later`. Expected: a toast `/later: the queue is empty`. `/later` and `/after` both show in the `/` typeahead.
3. Type `/later say hi`. Expected: a band above the prompt listing the item. About 2 seconds later (when nothing is running) the prompt `say hi` is submitted as the user's own message.

## Update

- **GitHub install (3A):**
  ```sh
  claude plugin marketplace update claude-code-later
  claude plugin update later@claude-code-later
  ```
  Then restart running sessions, or run `/reload-plugins` in them.
- **Local clone (3B):** `git -C <CLONE> pull` (or edit the files), then `/reload-plugins` in running sessions. New sessions pick it up by themselves. No reinstall.

## Uninstall

```sh
claude plugin uninstall later@claude-code-later
claude plugin marketplace remove claude-code-later   # optional: also forget the marketplace
```

Running sessions keep it until restarted (or until `/reload-plugins`). A local clone can be deleted after that.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `/later` or `/after` is an unknown command | The session started before the install. Start a new session, or run `/reload-plugins`. Then check Step 4. |
| A queued prompt was submitted twice | Two copies are loaded (for example the legacy `after@claude-after` beside `later@claude-code-later`, or a GitHub install beside a local one). Redo Step 2 and keep exactly one. |
| The queue never fires | The band says what it waits for: `Claude is working`, `N subagents running`, `item 1 is being edited`, `paused`. `/later --now` sends the head item at once. `/later --resume` if it is paused. Press **Cancel** on the edited row, or Enter on the edit line, to release an item being edited. |
| The band keeps saying `waiting: ...` although nothing runs | Run `/later --debug`: it prints the tracker (main turns, agents, edit state) and the last 40 events into the transcript. `/later --reset` clears the tracker. A "running" turn restored from an earlier load is dropped by itself once the prompt box reports idle for 2s. |
| A hook error line in the transcript naming `later` | Run `claude --debug` and look for lines starting with `later:`. For a local clone, run `claude plugin validate <CLONE>`. |
| Type-checking with `tsc -p <CLONE>` fails with a missing `.claude-plugin/types/tsconfig.json` | Claude Code writes that folder only when it loads the folder as a hot-reloaded mod. Start once with `claude --plugin-dir <CLONE>` (interactive, and only while the installed copy is disabled, see Step 2) to have it written. Otherwise use the tsconfig from the header of the engine's `claude-code.d.ts`. The folder is git-ignored. |

## Files

```
.claude-plugin/plugin.json        manifest (name "later", version, "types")
.claude-plugin/marketplace.json   makes the repo installable as marketplace "claude-code-later"
hooks/hooks.json                  names the hooks module
hooks/register.tsx                the mod: /later and /after commands, turn/subagent tracking, band above the prompt
types/index.d.ts                  $.state contract (queue, status, paused, editing, tracker)
tests/later.test.tsx              tests run by `claude plugin test`
tsconfig.json                     extends the engine-written .claude-plugin/types/tsconfig.json
README.md                         what the plugin does, for people
INSTALL.md                        this file
```
