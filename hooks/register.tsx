import { atom, read, update } from 'claude-code'
import type {
  AgentStatus,
  CommandRunInput,
  CommandRunResult,
  EngineInterface,
  Register,
  Timer,
} from 'claude-code'

import type { AfterItem, AfterStatus, AfterTracker } from '../types'

// ---------------------------------------------------------------------------
// /after <prompt>   (or /later <prompt>: the same command under another name)
//
// A queue of prompts, like the queued messages of Claude Desktop: each one is
// submitted as the person's own prompt once Claude has finished what it is
// doing, and until then it can be edited, removed or submitted at once.
//
// "Finished" means:
//   - no main-loop turn is running, and the last one ended normally (an
//     interrupted or failed turn holds the queue until the next normal end),
//   - the turn the previous /after prompt started has ended,
//   - no subagent / teammate is busy ($.agent.list + subagent turn events),
//   - and that has held for QUIET_TICKS ticks in a row with no new activity,
//     so a notification that is about to start a turn goes first.
// Prompts are submitted one at a time.
//
// Not the classic Stop event: a higher-tier built-in plugin can send it on
// past this mod's hook. Turn events and calls on `$` reach every plugin.
// ---------------------------------------------------------------------------

const TICK_MS = 500
/** Ticks of continuous "all clear" before firing (4 x 500ms = 2s). */
const QUIET_TICKS = 4
/** Ticks the prompt box must report idle before restored "running" state is dropped. */
const RECONCILE_TICKS = 4

const BUSY: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['pending', 'running', 'waiting'])
const ENDED: ReadonlySet<AgentStatus> = new Set<AgentStatus>(['completed', 'failed', 'killed'])

const queueAtom = atom({ plugin: 'after', key: 'queue' } as const, [] as AfterItem[], {
  shape: 'queue-1',
})
const statusAtom = atom({ plugin: 'after', key: 'status' } as const, {
  waiting: [],
  settling: false,
} as AfterStatus)
const pausedAtom = atom({ plugin: 'after', key: 'paused' } as const, false)
const editingAtom = atom({ plugin: 'after', key: 'editing' } as const, null as string | null)
const FRESH: AfterTracker = { mainTurns: [], agentTurns: [], lastEndOk: true, awaitingEnd: false }
// tracker-3: no Stop snapshot any more. Older values are read as FRESH.
const trackerAtom = atom({ plugin: 'after', key: 'tracker' } as const, FRESH, {
  shape: 'tracker-3',
})

/** The names the command answers to; both behave the same. */
const COMMANDS = ['after', 'later'] as const
const AFTER_CMD = /<command-name>\/?(?:after|later)<\/command-name>/
/** A prompt-box line that is one of this mod's commands. */
const OUR_LINE = /^\s*\/(?:after|later)(?:\s|$)/
const AFTER_ARGS = /<command-args>[\s\S]*?<\/command-args>/

function preview(text: string, max = 40): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// ---- module state: starts over on a reload --------------------------------
// The tracker part is restored from $.state in session.start.

let mainTurns = new Set<string>()
let agentTurns = new Map<string, string | null>()
let lastEndOk = true
let awaitingEnd = false

// Restored at load and not heard by this load: checked against the prompt
// box's own "working" flag, so a missed end cannot wedge the queue.
let restoredMain = new Set<string>()
let restoredAwaiting = false
let uiWorking: boolean | undefined
let uiIdleTicks = 0

// Activity counter: every turn and submission bumps it, which restarts the
// quiet window.
let epoch = 0
let streak = 0
let streakEpoch = -1
let ticking = false
let submitting = false
let lastStatus = ''
let timer: Timer | undefined
/** The name the person last used, for toasts, the band and edit lines. */
let lastCmd: string = 'after'

// Diagnostics for /after --debug.
let ticks = 0
let lastError = ''
const events: string[] = []
function note(text: string): void {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  events.push(`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${text}`)
  if (events.length > 40) events.splice(0, events.length - 40)
}

const say = ($: EngineInterface, text: string) => {
  $.ui.toast(`/${lastCmd}: ${text}`)
}

const persist = ($: EngineInterface) => {
  void update($, trackerAtom, () => ({
    mainTurns: [...mainTurns],
    agentTurns: [...agentTurns].map(([turnId, agentId]) => ({ turnId, agentId })),
    lastEndOk,
    awaitingEnd,
  })).catch(() => undefined)
}

const bump = ($: EngineInterface) => {
  epoch += 1
  persist($)
}

const publish = async ($: EngineInterface, status: AfterStatus) => {
  const json = JSON.stringify(status)
  if (json === lastStatus) return
  lastStatus = json
  await update($, statusAtom, () => status)
}

/** Every reason the queue cannot fire yet; empty means Claude is done. */
const waitingReasons = async ($: EngineInterface): Promise<string[]> => {
  const reasons: string[] = []

  if (mainTurns.size > 0) reasons.push('Claude 正在工作')
  else if (awaitingEnd) reasons.push('等待已提交的 prompt 跑完')
  else if (!lastEndOk) reasons.push('上一轮被中断/出错, 等下一轮正常结束')

  const agents = await $.agent.list().catch(() => [])
  const ended = new Set(agents.filter(a => ENDED.has(a.status)).map(a => a.id))
  for (const [turnId, agentId] of agentTurns) {
    if (agentId !== null && ended.has(agentId)) agentTurns.delete(turnId)
  }
  const subagents = new Set<string>()
  for (const a of agents) if (BUSY.has(a.status)) subagents.add(a.id)
  for (const [turnId, agentId] of agentTurns) subagents.add(agentId ?? turnId)
  if (subagents.size > 0) reasons.push(`${subagents.size} 个 subagent 运行中`)

  return reasons
}

/** Drops restored "running" state once the prompt box says nothing runs. */
const reconcile = ($: EngineInterface) => {
  uiIdleTicks = uiWorking === false ? uiIdleTicks + 1 : 0
  if (uiIdleTicks < RECONCILE_TICKS) return
  if (restoredMain.size === 0 && !restoredAwaiting) return
  for (const id of restoredMain) mainTurns.delete(id)
  if (restoredAwaiting) awaitingEnd = false
  note(`reconciled restored state (turns: ${[...restoredMain].join(',') || '-'}, awaiting: ${restoredAwaiting})`)
  restoredMain = new Set()
  restoredAwaiting = false
  bump($)
}

/** Takes `item` off the queue and submits it as the person's own prompt. */
const fire = async ($: EngineInterface, item: AfterItem) => {
  submitting = true
  streak = 0
  try {
    await update($, queueAtom, q => q.filter(x => x.id !== item.id))
    if ((await read($, editingAtom)) === item.id) await update($, editingAtom, () => null)
    awaitingEnd = true
    restoredAwaiting = false
    bump($)
    note(`submit "${preview(item.text, 30)}"`)
    await publish($, { waiting: ['正在提交…'], settling: false })
    say($, `提交 "${preview(item.text)}"`)
    const result = await $.prompt.submit({ text: item.text, asUser: true })
    if (result.drop !== undefined) {
      awaitingEnd = false
      note(`submit dropped: ${result.drop}`)
      say($, `提交被拦截: ${result.drop}`)
    }
  } catch (err) {
    awaitingEnd = false
    note(`submit failed: ${String(err)}`)
    await update($, queueAtom, q => [item, ...q.filter(x => x.id !== item.id)])
    await update($, pausedAtom, () => true)
    say($, `提交失败, 队列已暂停: ${String(err)}`)
  } finally {
    submitting = false
    bump($)
  }
}

const tick = async ($: EngineInterface) => {
  if (ticking || submitting) return
  ticking = true
  ticks += 1
  try {
    reconcile($)
    const queue = await read($, queueAtom)
    if (queue.length === 0) {
      streak = 0
      await publish($, { waiting: [], settling: false })
      return
    }
    const reasons = await waitingReasons($)
    if (await read($, pausedAtom)) reasons.unshift('已暂停')
    const head = queue[0]
    if (head !== undefined && (await read($, editingAtom)) === head.id) {
      reasons.unshift('第 1 条正在编辑')
    }
    if (reasons.length > 0) {
      streak = 0
      await publish($, { waiting: reasons, settling: false })
      return
    }
    if (streakEpoch !== epoch) {
      streakEpoch = epoch
      streak = 0
    }
    streak += 1
    if (streak < QUIET_TICKS) {
      await publish($, { waiting: [], settling: true })
      return
    }
    if (head !== undefined) await fire($, head)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message !== lastError) note(`tick error: ${message}`)
    lastError = message
    streak = 0
    await publish($, { waiting: [`内部错误: ${message}`], settling: false }).catch(() => undefined)
  } finally {
    ticking = false
  }
}

const runNow = async ($: EngineInterface) => {
  if (submitting) return '正在提交中'
  const queue = await read($, queueAtom)
  const head = queue[0]
  if (head === undefined) return '队列为空'
  await fire($, head)
  return undefined
}

/**
 * Puts item `id` in the prompt box as `/<command> <text>` and holds it; the
 * next `/after` or `/later <text>` replaces it in place. Never overwrites a
 * draft of the person's own.
 */
const startEdit = async ($: EngineInterface, id: string): Promise<string> => {
  const queue = await read($, queueAtom)
  const index = queue.findIndex(x => x.id === id)
  const item = queue[index]
  if (item === undefined) return '这一条已经不在队列里了'
  const box = await $.prompt.read()
  if (box.text.trim() !== '' && !OUR_LINE.test(box.text)) {
    return '输入框里还有没发的内容, 先清空再编辑'
  }
  await update($, editingAtom, () => id)
  const filled = await $.prompt.fill({ text: `/${lastCmd} ${item.text}`, mode: 'replace' })
  if (!filled.isFilled) {
    await update($, editingAtom, () => null)
    return `没法填进输入框 (${filled.refusal ?? '被拦截'})`
  }
  note(`edit #${index + 1}`)
  return `正在编辑第 ${index + 1} 条: 改完回车保存, 不改点"取消"`
}

const cancelEdit = async ($: EngineInterface) => {
  await update($, editingAtom, () => null)
  const box = await $.prompt.read()
  if (OUR_LINE.test(box.text)) await $.prompt.fill({ text: '', mode: 'replace' })
}

const debugText = async ($: EngineInterface): Promise<string> => {
  const queue = await read($, queueAtom)
  const status = await read($, statusAtom)
  const paused = await read($, pausedAtom)
  const editing = await read($, editingAtom)
  const agents = await $.agent.list().catch(() => [])
  return [
    `/${lastCmd} debug (answers to ${COMMANDS.map(c => '/' + c).join(', ')})`,
    `queue: ${queue.length}${queue.map((q, i) => `\n  ${i + 1}. ${q.id === editing ? '[editing] ' : ''}${preview(q.text, 60)}`).join('')}`,
    `paused: ${paused}  status: ${status.settling ? 'settling' : status.waiting.join('; ') || '-'}`,
    `mainTurns: [${[...mainTurns].join(', ')}]  awaitingEnd: ${awaitingEnd}  lastEndOk: ${lastEndOk}`,
    `restoredMain: [${[...restoredMain].join(', ')}]  restoredAwaiting: ${restoredAwaiting}`,
    `uiWorking: ${uiWorking}  uiIdleTicks: ${uiIdleTicks}  ticks: ${ticks}  epoch: ${epoch}  streak: ${streak}`,
    `agentTurns: [${[...agentTurns].map(([t, a]) => `${a ?? '?'}:${t}`).join(', ')}]`,
    `agents: [${agents.map(a => `${a.id}=${a.status}`).join(', ')}]`,
    `lastError: ${lastError || '-'}`,
    'events:',
    ...events.map(x => `  ${x}`),
  ].join('\n')
}

/** `/after ...` and `/later ...`: one handler, `cmd` the name that was typed. */
const runCommand = async (
  $: EngineInterface,
  e: CommandRunInput,
  cmd: string,
): Promise<CommandRunResult> => {
  lastCmd = cmd
  const args = e.args.trim()

  if (args === '' || args === '--list') {
    const queue = await read($, queueAtom)
    const status = await read($, statusAtom)
    if (queue.length === 0) say($, '队列为空')
    else {
      const why = status.settling ? '即将提交' : status.waiting.join('; ') || '检查中'
      say($, `${queue.length} 条排队 · ${why}`)
    }
    return {}
  }
  if (args === '--clear') {
    await update($, queueAtom, () => [])
    await update($, editingAtom, () => null)
    say($, '队列已清空')
    return {}
  }
  if (args === '--pause') {
    await update($, pausedAtom, () => true)
    say($, `已暂停, /${cmd} --resume 继续`)
    return {}
  }
  if (args === '--resume') {
    await update($, pausedAtom, () => false)
    say($, '已继续')
    return {}
  }
  if (args === '--debug') {
    return { text: await debugText($) }
  }
  if (args === '--reset') {
    mainTurns = new Set()
    agentTurns = new Map()
    lastEndOk = true
    awaitingEnd = false
    restoredMain = new Set()
    restoredAwaiting = false
    note(`reset by /${cmd} --reset`)
    bump($)
    say($, '跟踪状态已重置')
    return {}
  }
  if (args === '--now') {
    const why = await runNow($)
    if (why !== undefined) say($, `${why}`)
    return {}
  }
  const editArg = /^--edit(?:\s+(\d+))?$/.exec(args)
  if (editArg !== null) {
    const queue = await read($, queueAtom)
    const n = Number(editArg[1] ?? '1')
    const item = queue[n - 1]
    if (item === undefined) say($, `没有第 ${n} 条`)
    else {
      // The command's own line is still in the box as it runs; clear it first.
      await $.prompt.fill({ text: '', mode: 'replace' })
      say($, `${await startEdit($, item.id)}`)
    }
    return {}
  }

  // A prompt: replaces the item being edited, else joins the queue.
  const editing = await read($, editingAtom)
  if (editing !== null) {
    let index = -1
    await update($, queueAtom, q => {
      index = q.findIndex(x => x.id === editing)
      return index < 0 ? q : q.map(x => (x.id === editing ? { ...x, text: args } : x))
    })
    await update($, editingAtom, () => null)
    if (index >= 0) {
      bump($)
      note(`edited #${index + 1}`)
      say($, `第 ${index + 1} 条已更新 "${preview(args)}"`)
      return {}
    }
  }

  const item: AfterItem = { id: newId(), text: args, addedAt: await $.clock.now() }
  const queue = await update($, queueAtom, q => [...q, item])
  streak = 0
  bump($)
  note(`queued #${queue.length} "${preview(item.text, 30)}"`)
  say($, `已排队 #${queue.length} "${preview(item.text)}", Claude 做完当前的事后提交`)
  return {}
}

export const register: Register = on => {
  // ---- lifecycle ----------------------------------------------------------

  on('session.start', async ($, e, next) => {
    const saved = await read($, trackerAtom)
    mainTurns = new Set(saved.mainTurns)
    agentTurns = new Map(saved.agentTurns.map(t => [t.turnId, t.agentId]))
    lastEndOk = saved.lastEndOk
    awaitingEnd = saved.awaitingEnd
    restoredMain = new Set(saved.mainTurns)
    restoredAwaiting = saved.awaitingEnd
    note(`session.start: restored turns [${saved.mainTurns.join(',')}], awaiting ${saved.awaitingEnd}`)

    const hint = '<prompt> | --edit N | --now | --pause | --resume | --clear | --debug | --reset'
    await $.command.register({
      name: 'after',
      description: 'Claude 做完当前的事(含 subagent)后再提交这条 prompt, 像排队消息一样',
      argumentHint: hint,
      immediate: true,
    })
    try {
      await $.command.register({
        name: 'later',
        description: '同 /after: 把 prompt 排队, Claude 做完当前的事后提交',
        argumentHint: hint,
        immediate: true,
      })
    } catch (err) {
      // Should a later Claude Code ship a /later of its own, /after still works.
      note(`could not register /later: ${String(err)}`)
    }

    timer?.cancel()
    timer = $.clock.every(TICK_MS, () => {
      void tick($).catch(() => undefined)
    })

    return next(e)
  })

  // ---- tracking the work --------------------------------------------------

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) {
      mainTurns.add(e.turnId)
      note(`turn.start main ${e.turnId}`)
    } else {
      agentTurns.set(e.turnId, e.agentId)
      note(`turn.start agent ${e.agentId} ${e.turnId}`)
    }
    bump($)
    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      mainTurns.delete(e.turnId)
      restoredMain.delete(e.turnId)
      lastEndOk = e.reason === 'answer' || e.reason === 'refusal'
      awaitingEnd = false
      restoredAwaiting = false
      note(`turn.complete main ${e.turnId} ${e.reason}`)
    } else {
      agentTurns.delete(e.turnId)
      note(`turn.complete agent ${e.agentId} ${e.turnId} ${e.reason}`)
    }
    bump($)
    return next(e)
  })

  // Keep the queued text away from the model until it is actually submitted.
  on('session.append', { door: 'command' }, ($, e, next) => {
    let changed = false
    const content = e.message.content.map(block => {
      if (block.type !== 'text' || typeof block.text !== 'string') return block
      if (!AFTER_CMD.test(block.text)) return block
      const text = block.text.replace(
        AFTER_ARGS,
        '<command-args>(queued; it will be sent as its own prompt later)</command-args>',
      )
      if (text === block.text) return block
      changed = true
      return { ...block, text }
    })
    return next(changed ? { ...e, message: { ...e.message, content } } : e)
  })

  // ---- the command --------------------------------------------------------

  on('command.run', { command: 'after' }, ($, e) => runCommand($, e, 'after'))
  on('command.run', { command: 'later' }, ($, e) => runCommand($, e, 'later'))

  // ---- the band above the prompt -----------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The prompt box's own word on whether a model turn runs; reconcile()
    // reads it to drop stale restored state.
    if (uiWorking !== e.props.isWorking) note(`prompt box isWorking=${e.props.isWorking}`)
    uiWorking = e.props.isWorking
    if (e.props.hasSurvey) return next(e)
    const queue = await read($, queueAtom)
    if (queue.length === 0) return next(e)
    const status = await read($, statusAtom)
    const paused = await read($, pausedAtom)
    const editing = await read($, editingAtom)
    const { Box, Text, Button } = $.ui.resolve(e)

    const room = Math.max(1, Math.min(5, e.props.maxRows - 2))
    const shown = queue.slice(0, room)
    const hidden = queue.length - shown.length
    const state = status.settling
      ? '即将提交…'
      : status.waiting.length > 0
        ? `等待: ${status.waiting.join('; ')}`
        : '检查中…'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              <Text color="claude" bold>
                /{lastCmd}
              </Text>{' '}
              <Text dimColor>{queue.length} 条 ·</Text>{' '}
              <Text color={status.settling ? 'success' : 'warning'}>{state}</Text>
            </Text>
          </Box>
          <Button key="now" label="立即提交" onPress={() => void runNow($)} />
          <Button
            key="pause"
            label={paused ? '继续' : '暂停'}
            onPress={() => void update($, pausedAtom, p => !p)}
          />
          <Button
            key="clear"
            label="清空"
            onPress={() => {
              void update($, queueAtom, () => []).then(() => update($, editingAtom, () => null))
            }}
          />
        </Box>
        {shown.map((item, i) => {
          const isEditing = item.id === editing
          return (
            <Box key={`row-${item.id}`} flexDirection="row" gap={1}>
              <Box flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">
                  <Text dimColor>{i + 1}.</Text>{' '}
                  {isEditing && <Text color="suggestion">[编辑中] </Text>}
                  {item.text.replace(/\s+/g, ' ')}
                </Text>
              </Box>
              {isEditing ? (
                <Button key={`cancel-${item.id}`} label="取消" plain onPress={() => void cancelEdit($)} />
              ) : (
                <Button
                  key={`edit-${item.id}`}
                  label="编辑"
                  plain
                  onPress={() => {
                    void startEdit($, item.id).then(msg => say($, `${msg}`))
                  }}
                />
              )}
              <Button
                key={`rm-${item.id}`}
                label="×"
                plain
                onPress={() => {
                  void update($, queueAtom, q => q.filter(x => x.id !== item.id)).then(() =>
                    isEditing ? update($, editingAtom, () => null) : undefined,
                  )
                }}
              />
            </Box>
          )
        })}
        {hidden > 0 && <Text dimColor>…还有 {hidden} 条</Text>}
      </Box>
    )
  })
}
