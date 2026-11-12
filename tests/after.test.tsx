import { expect, mock, test } from 'claude-code/testing'
import type { Engine as Eng } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

const PRESENTATION = { isFullscreen: false, columns: 100 } as const

function world(on: On, agents: { list: AgentInfo[] }) {
  const clock = mock.clock(on, { now: 1_000 })
  const submitted: string[] = []
  on('command.register', () => ({ value: { command: 'after' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: agents.list }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.Stop', () => ({}))
  return { clock, submitted }
}


const after = ($: Eng, args: string) =>
  $.command.run({ command: 'after', args, origin: { kind: 'composer' }, presentation: PRESENTATION })

const start = ($: Eng, turnId: string, agentId?: string) =>
  $.turn.start(agentId === undefined ? { text: '', turnId } : { text: '', turnId, agentId })

const complete = (
  $: Eng,
  turnId: string,
  reason: 'answer' | 'aborted' = 'answer',
  agentId?: string,
) =>
  $.turn.complete({
    answer: 'ok',
    durationMs: 1,
    isAborted: reason === 'aborted',
    turnId,
    reason,
    ...(agentId === undefined ? {} : { agentId }),
  })

const agentA: AgentInfo = { id: 'agent-a', description: 'research', type: 'Explore', status: 'running' }

test('waits for the main turn, a background subagent and its notification turn', async ($, on) => {
  const agents = { list: [] as AgentInfo[] }
  const { clock, submitted } = world(on, agents)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // Main turn running; the person queues a prompt.
  await start($, 't1')
  await after($, 'run the tests')
  await clock.advance(5_000)
  expect(submitted).toEqual([])

  // Main turn ends but leaves a background subagent running.
  agents.list = [agentA]
  await start($, 'a1', 'agent-a')
  await complete($, 't1')
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'agent-a', type: 'subagent', status: 'running', description: 'research' }],
    session_crons: [],
  })
  await clock.advance(5_000)
  expect(submitted).toEqual([])

  // The subagent finishes; its notification starts a main turn.
  await complete($, 'a1', 'answer', 'agent-a')
  agents.list = [{ ...agentA, status: 'completed' }]
  await clock.advance(1_000)
  await start($, 't2')
  await clock.advance(5_000)
  expect(submitted).toEqual([])

  // That turn ends with nothing in flight: fires after the quiet window.
  await complete($, 't2')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] })
  await clock.advance(1_000)
  expect(submitted).toEqual([])
  await clock.advance(2_000)
  expect(submitted).toEqual(['run the tests'])
})

test('one at a time, and an interrupted turn holds the queue', async ($, on) => {
  const { clock, submitted } = world(on, { list: [] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await after($, 'first')
  await after($, 'second')
  await clock.advance(3_000)
  expect(submitted).toEqual(['first'])

  // Nothing started yet for "first" in this mock, but no Stop arrived either:
  // "second" must not follow.
  await clock.advance(5_000)
  expect(submitted).toEqual(['first'])

  // "first"'s turn is interrupted: no Stop, queue holds.
  await start($, 't1')
  await complete($, 't1', 'aborted')
  await clock.advance(5_000)
  expect(submitted).toEqual(['first'])

  // The person's next turn ends normally: "second" goes.
  await start($, 't2')
  await complete($, 't2')
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [], session_crons: [] })
  await clock.advance(3_000)
  expect(submitted).toEqual(['first', 'second'])
})

test('a background shell and a one-shot wakeup keep it waiting', async ($, on) => {
  const { clock, submitted } = world(on, { list: [] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await start($, 't1')
  await after($, 'deploy')
  await complete($, 't1')
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [{ id: 'b1', type: 'shell', status: 'running', description: 'npm test', command: 'npm test' }],
    session_crons: [{ id: 'c1', schedule: '5 * * * *', recurring: false, prompt: 'check CI' }],
  })
  await clock.advance(10_000)
  expect(submitted).toEqual([])

  // Shell done (notification turn), but the wakeup is still pending.
  await start($, 't2')
  await complete($, 't2')
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [],
    session_crons: [{ id: 'c1', schedule: '5 * * * *', recurring: false, prompt: 'check CI' }],
  })
  await clock.advance(10_000)
  expect(submitted).toEqual([])

  // The wakeup fired; a recurring cron alone does not hold the queue.
  await start($, 't3')
  await complete($, 't3')
  await $.classic.Stop({
    stop_hook_active: false,
    background_tasks: [],
    session_crons: [{ id: 'c2', schedule: '0 9 * * *', recurring: true, prompt: 'daily' }],
  })
  await clock.advance(3_000)
  expect(submitted).toEqual(['deploy'])
})

test('the band lists the queue and why it waits', async ($, on) => {
  const { clock } = world(on, { list: [] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($, 't1')
  await after($, 'write the changelog')
  await clock.advance(1_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'after',
      surface,
      component: 'AbovePrompt',
      props: {
        hasSurvey: false,
        isCollapsed: false,
        isWorking: true,
        maxRows: 10,
        bodyColumns: 80,
        scroll: { offset: 0, bodyRows: 9 },
        view: {},
      },
    })
    expect(await ui.find({ type: 'Text', text: /主对话正在运行/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /write the changelog/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the queued text is hidden from the command row', async ($, on) => {
  world(on, { list: [] })
  const session = mock.session(on)
  await $.session.append({
    door: 'command',
    origin: { kind: 'composer' },
    uuid: 'row-1',
    message: {
      type: 'user',
      role: 'user',
      content: [
        {
          type: 'text',
          text: '<command-name>/after</command-name>\n<command-message>after</command-message>\n<command-args>secret plan</command-args>',
        },
      ],
    },
  })
  const row = session.appended().at(-1)
  const text = String(row?.message.content[0]?.text)
  expect(text).toContain('<command-name>/after</command-name>')
  expect(text.includes('secret plan')).toBe(false)
})
