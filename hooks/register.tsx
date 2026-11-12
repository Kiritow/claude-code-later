import { atom, read, update } from 'claude-code'
import type { AgentStatus, EngineInterface, Register, Timer } from 'claude-code'

import type { AfterItem, AfterStatus, AfterTask, AfterTracker } from '../types'

// ---------------------------------------------------------------------------
// /after <prompt>
//
// Queues a prompt and submits it only when the current piece of work is truly
// finished: not just "the prompt is idle", but
//   - no main-loop turn is running, and the last one ended normally,
//   - the Stop event for that turn arrived (and no Stop hook kept it going),
//   - no subagent / teammate loop is mid-turn ($.agent.list + turn events),
//   - no background task is in flight (shells, background agents, monitors,
//     workflows: the Stop event's `background_tasks`),
//   - no one-shot wakeup (ScheduleWakeup) is still pending,
//   - and all of the above has held for QUIET_TICKS ticks in a row with no
//     new activity, so a task notification that is about to start a turn wins.
// Prompts are submitted one at a time; each next one waits for the work the
// previous one started to finish in the same sense.
// ---------------------------------------------------------------------------

const TICK_MS = 500
/** Ticks of continuous "all clear" before firing (4 x 500ms = 2s). */
const QUIET_TICKS = 4
/** Ticks an ended agent may linger in the Stop snapshot before it is dropped. */
const PRUNE_TICKS = 10
/**
 * Ticks the prompt box must report "not working" before a "running" turn
 * restored from $.state (written by an earlier load of this mod) is dropped.
 */
const RECONCILE_TICKS = 4
/** Task statuses that are over, should a Stop snapshot ever carry one. */
const TASK_DONE: ReadonlySet<string> = new Set(['completed', 'failed', 'killed', 'stopped', 'error'])

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
const FRESH: AfterTracker = {
  mainTurns: [],
  agentTurns: [],
  stopSeen: true,
  lastEndOk: true,
  bgTasks: [],
  crons: [],
}
// tracker-2: AfterTask gained `status`. A value stored under tracker-1 (or by
// an earlier copy of this mod) is read as FRESH.
const trackerAtom = atom({ plugin: 'after', key: 'tracker' } as const, FRESH, {
  shape: 'tracker-2',
})

const AFTER_CMD = /<command-name>\/?after<\/command-name>/
const AFTER_ARGS = /<command-args>[\s\S]*?<\/command-args>/

function preview(text: string, max = 40): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

function countBy(tasks: readonly AfterTask[]): string {
  const counts = new Map<string, number>()
  for (const t of tasks) counts.set(t.type, (counts.get(t.type) ?? 0) + 1)
  return [...counts].map(([type, n]) => (n > 1 ? `${type}×${n}` : type)).join(', ')
}

// Module state: starts over on a reload; the tracker part is restored from
// $.state in session.start.
let mainTurns = new Set<string>()
let agentTurns = new Map<string, string | null>()
let stopSeen = true
let lastEndOk = true
let bgTasks: AfterTask[] = []
let crons: AfterTracker['crons'] = []

// Activity counter: every turn / Stop / submission bumps it, which restarts
// the quiet window.
let epoch = 0
let streak = 0
let streakEpoch = -1
let ticking = false
let submitting = false
let lastStatus = ''
let timer: Timer | undefined
const endedTicks = new Map<string, number>()

// What came back from $.state at load and was not heard by this load: a turn
// whose end was missed (the mod was unloaded first) would otherwise wedge the
// queue forever. Checked against the prompt box's own "working" flag.
let restoredMain = new Set<string>()
let restoredStopPending = false
let uiWorking: boolean | undefined
let uiIdleTicks = 0

// Diagnostics for /after --debug.
let ticks = 0
let lastError = ''
const events: string[] = []
function note(text: string): void {
  const d = new Date()
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
  events.push(`${t} ${text}`)
  if (events.length > 40) events.splice(0, events.length - 40)
}

const persist = ($: EngineInterface) => {
  void update($, trackerAtom, () => ({
    mainTurns: [...mainTurns],
    agentTurns: [...agentTurns].map(([turnId, agentId]) => ({ turnId, agentId })),
    stopSeen,
    lastEndOk,
    bgTasks,
    crons,
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

/** Every reason the queue cannot fire yet; empty means the work is done. */
const waitingReasons = async ($: EngineInterface): Promise<string[]> => {
  const reasons: string[] = []

  if (mainTurns.size > 0) reasons.push('主对话正在运行')
  else if (!lastEndOk) reasons.push('上一轮被中断/出错, 等下一轮正常结束')
  else if (!stopSeen) reasons.push('等待本轮结束确认 (Stop)')

  const agents = await $.agent.list().catch(() => [])
  const ended = new Set(agents.filter(a => ENDED.has(a.status)).map(a => a.id))

  // Drop turns of agents the engine already reports as ended (a lost end).
  for (const [turnId, agentId] of agentTurns) {
    if (agentId !== null && ended.has(agentId)) agentTurns.delete(turnId)
  }

  const subagents = new Set<string>()
  for (const a of agents) if (BUSY.has(a.status)) subagents.add(a.id)
  for (const [turnId, agentId] of agentTurns) subagents.add(agentId ?? turnId)
  if (subagents.size > 0) reasons.push(`${subagents.size} 个 subagent 运行中`)

  // Background tasks from the last Stop. A background agent that has ended
  // normally wakes the main loop (task notification -> new turn -> new Stop);
  // if that never comes, drop it after a grace period instead of hanging.
  const live = bgTasks.filter(t => {
    if (TASK_DONE.has(t.status)) return false
    if (!ended.has(t.id)) return true
    const n = (endedTicks.get(t.id) ?? 0) + 1
    endedTicks.set(t.id, n)
    return n < PRUNE_TICKS
  })
  if (live.length !== bgTasks.length) {
    bgTasks = live
    persist($)
  }
  const others = live.filter(t => !subagents.has(t.id))
  if (others.length > 0) reasons.push(`后台任务: ${countBy(others)}`)

  const oneShot = crons.filter(c => !c.recurring).length
  if (oneShot > 0) reasons.push(`${oneShot} 个定时唤醒待触发`)

  return reasons
}

/** Takes `item` off the queue and submits it as the person's own prompt. */
const fire = async ($: EngineInterface, item: AfterItem) => {
  submitting = true
  streak = 0
  try {
    await update($, queueAtom, q => q.filter(x => x.id !== item.id))
    // The turn this starts must produce its own Stop before the next fires.
    stopSeen = false
    bump($)
    await publish($, { waiting: ['正在提交…'], settling: false })
    $.ui.toast(`/after: 提交 "${preview(item.text)}"`)
    const result = await $.prompt.submit({ text: item.text, asUser: true })
    if (result.drop !== undefined) {
      stopSeen = true
      $.ui.toast(`/after: 提交被拦截: ${result.drop}`)
    }
  } catch (err) {
    stopSeen = true
    await update($, queueAtom, q => [item, ...q.filter(x => x.id !== item.id)])
    await update($, pausedAtom, () => true)
    $.ui.toast(`/after: 提交失败, 队列已暂停: ${String(err)}`)
  } finally {
    submitting = false
    bump($)
  }
}

/** Drops restored "running" state once the prompt box says nothing runs. */
const reconcile = ($: EngineInterface) => {
  uiIdleTicks = uiWorking === false ? uiIdleTicks + 1 : 0
  if (uiIdleTicks < RECONCILE_TICKS) return
  if (restoredMain.size === 0 && !restoredStopPending) return
  for (const id of restoredMain) mainTurns.delete(id)
  if (restoredStopPending) stopSeen = true
  note(`reconciled restored state (turns: ${[...restoredMain].join(',') || '-'}, stop pending: ${restoredStopPending})`)
  restoredMain = new Set()
  restoredStopPending = false
  bump($)
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
    const head = queue[0]
    if (head !== undefined) await fire($, head)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (message !== lastError) note(`tick error: ${message}`)
    lastError = message
    await publish($, { waiting: [`内部错误: ${message}`], settling: false }).catch(() => undefined)
  } finally {
    ticking = false
  }
}

const debugText = async ($: EngineInterface): Promise<string> => {
  const queue = await read($, queueAtom)
  const status = await read($, statusAtom)
  const paused = await read($, pausedAtom)
  const agents = await $.agent.list().catch(() => [])
  return [
    '/after debug',
    `queue: ${queue.length}${queue.map((q, i) => `\n  ${i + 1}. ${preview(q.text, 60)}`).join('')}`,
    `paused: ${paused}  status: ${status.settling ? 'settling' : status.waiting.join('; ') || '-'}`,
    `mainTurns: [${[...mainTurns].join(', ')}]  stopSeen: ${stopSeen}  lastEndOk: ${lastEndOk}`,
    `restoredMain: [${[...restoredMain].join(', ')}]  restoredStopPending: ${restoredStopPending}`,
    `uiWorking: ${uiWorking}  uiIdleTicks: ${uiIdleTicks}  ticks: ${ticks}  epoch: ${epoch}  streak: ${streak}`,
    `agentTurns: [${[...agentTurns].map(([t, a]) => `${a ?? '?'}:${t}`).join(', ')}]`,
    `agents: [${agents.map(a => `${a.id}=${a.status}`).join(', ')}]`,
    `bgTasks: [${bgTasks.map(t => `${t.type}:${t.id}=${t.status}`).join(', ')}]`,
    `crons: [${crons.map(c => `${c.id}${c.recurring ? '(recurring)' : ''}`).join(', ')}]`,
    `lastError: ${lastError || '-'}`,
    'events:',
    ...events.map(x => `  ${x}`),
  ].join('\n')
}

const runNow = async ($: EngineInterface) => {
  if (submitting) return '正在提交中'
  const queue = await read($, queueAtom)
  const head = queue[0]
  if (head === undefined) return '队列为空'
  await fire($, head)
  return undefined
}

export const register: Register = on => {
  // ---- lifecycle ----------------------------------------------------------

  on('session.start', async ($, e, next) => {
    const saved = await read($, trackerAtom)
    mainTurns = new Set(saved.mainTurns)
    agentTurns = new Map(saved.agentTurns.map(t => [t.turnId, t.agentId]))
    stopSeen = saved.stopSeen
    lastEndOk = saved.lastEndOk
    bgTasks = saved.bgTasks
    crons = saved.crons
    restoredMain = new Set(saved.mainTurns)
    restoredStopPending = !saved.stopSeen
    note(`session.start: restored turns [${saved.mainTurns.join(',')}], stopSeen ${saved.stopSeen}, bg ${saved.bgTasks.length}`)

    await $.command.register({
      name: 'after',
      description: '当前工作真正完成后(含 subagent/后台任务)再提交这条 prompt',
      argumentHint: '<prompt> | --now | --pause | --resume | --clear | --debug | --reset',
      immediate: true,
    })

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
      stopSeen = false
      restoredStopPending = false
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
      note(`turn.complete main ${e.turnId} ${e.reason}`)
    } else {
      agentTurns.delete(e.turnId)
      note(`turn.complete agent ${e.agentId} ${e.turnId} ${e.reason}`)
    }
    bump($)
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (result.block === undefined) {
      // The main loop has stopped: whatever main turn we think runs is over.
      stopSeen = true
      mainTurns.clear()
      restoredMain = new Set()
      restoredStopPending = false
      bgTasks = (e.background_tasks ?? []).map(t => ({
        id: t.id,
        type: t.type,
        status: t.status,
        description: t.description,
      }))
      crons = (e.session_crons ?? []).map(c => ({ id: c.id, recurring: c.recurring }))
      endedTicks.clear()
      note(`Stop: bg [${bgTasks.map(t => `${t.type}=${t.status}`).join(', ')}], crons ${crons.length}`)
    } else {
      // A Stop hook sent the model back to work: not done.
      stopSeen = false
      note('Stop blocked by a hook: model continues')
    }
    bump($)
    return result
  })

  // Keep the queued text away from the model until it is actually submitted:
  // the command's own transcript row would otherwise show it mid-work.
  on('session.append', { door: 'command' }, ($, e, next) => {
    let changed = false
    const content = e.message.content.map(block => {
      if (block.type !== 'text' || typeof block.text !== 'string') return block
      if (!AFTER_CMD.test(block.text)) return block
      const text = block.text.replace(
        AFTER_ARGS,
        '<command-args>(queued by /after; it will be sent as its own prompt later)</command-args>',
      )
      if (text === block.text) return block
      changed = true
      return { ...block, text }
    })
    return next(changed ? { ...e, message: { ...e.message, content } } : e)
  })

  // ---- the command --------------------------------------------------------

  on('command.run', { command: 'after' }, async ($, e) => {
    const args = e.args.trim()

    if (args === '' || args === '--list') {
      const queue = await read($, queueAtom)
      const status = await read($, statusAtom)
      if (queue.length === 0) $.ui.toast('/after: 队列为空')
      else {
        const why = status.settling ? '即将提交' : status.waiting.join('; ') || '检查中'
        $.ui.toast(`/after: ${queue.length} 条排队 · ${why}`)
      }
      return {}
    }
    if (args === '--clear') {
      await update($, queueAtom, () => [])
      $.ui.toast('/after: 队列已清空')
      return {}
    }
    if (args === '--pause') {
      await update($, pausedAtom, () => true)
      $.ui.toast('/after: 已暂停, /after --resume 继续')
      return {}
    }
    if (args === '--resume') {
      await update($, pausedAtom, () => false)
      $.ui.toast('/after: 已继续')
      return {}
    }
    if (args === '--debug') {
      return { text: await debugText($) }
    }
    if (args === '--reset') {
      mainTurns = new Set()
      agentTurns = new Map()
      stopSeen = true
      lastEndOk = true
      bgTasks = []
      crons = []
      restoredMain = new Set()
      restoredStopPending = false
      note('reset by /after --reset')
      bump($)
      $.ui.toast('/after: 跟踪状态已重置')
      return {}
    }
    if (args === '--now') {
      const why = await runNow($)
      if (why !== undefined) $.ui.toast(`/after: ${why}`)
      return {}
    }

    const item: AfterItem = { id: newId(), text: args, addedAt: await $.clock.now() }
    const queue = await update($, queueAtom, q => [...q, item])
    streak = 0
    $.ui.toast(`/after: 已排队 #${queue.length} "${preview(item.text)}", 当前工作真正完成后提交`)
    return {}
  })

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
                /after
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
          <Button key="clear" label="清空" onPress={() => void update($, queueAtom, () => [])} />
        </Box>
        {shown.map((item, i) => (
          <Box key={`row-${item.id}`} flexDirection="row" gap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text wrap="truncate-end">
                <Text dimColor>{i + 1}.</Text> {item.text.replace(/\s+/g, ' ')}
              </Text>
            </Box>
            <Button
              key={`rm-${item.id}`}
              label="×"
              plain
              onPress={() => void update($, queueAtom, q => q.filter(x => x.id !== item.id))}
            />
          </Box>
        ))}
        {hidden > 0 && <Text dimColor>…还有 {hidden} 条</Text>}
      </Box>
    )
  })
}
