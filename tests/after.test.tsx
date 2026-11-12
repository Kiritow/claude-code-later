import { expect, mock, test } from 'claude-code/testing'
import type { Engine as Eng } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

const PRESENTATION = { isFullscreen: false, columns: 100 } as const

function world(on: On, agents: { list: AgentInfo[] }) {
  const clock = mock.clock(on, { now: 1_000 })
  const submitted: string[] = []
  const box = { text: '' }
  on('command.register', () => ({ value: { command: 'after' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: agents.list }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } }))
  on('prompt.fill', (_, e) => {
    box.text = e.text
    return { isFilled: true }
  })
  on('prompt.submit', (_, e) => {
    submitted.push(e.text)
    return { text: e.text }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  return { clock, submitted, box }
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

const BAND_PROPS = (isWorking: boolean) => ({
  hasSurvey: false,
  isCollapsed: false,
  isWorking,
  maxRows: 10,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 9 },
  view: {},
})

const band = ($: Eng, surface: 'terminal' | 'desktop', isWorking: boolean) =>
  $.ui.mount({ plugin: 'after', surface, component: 'AbovePrompt', props: BAND_PROPS(isWorking) })

const agentA: AgentInfo = { id: 'agent-a', description: 'research', type: 'Explore', status: 'running' }

test('waits for the main turn, then for a background subagent', async ($, on) => {
  const agents = { list: [] as AgentInfo[] }
  const { clock, submitted } = world(on, agents)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  await start($, 't1')
  await after($, 'run the tests')
  await clock.advance(5_000)
  expect(submitted).toEqual([])

  // The turn ends but leaves a background subagent running.
  agents.list = [agentA]
  await complete($, 't1')
  await clock.advance(5_000)
  expect(submitted).toEqual([])

  // The subagent finishes: fires after the quiet window.
  agents.list = [{ ...agentA, status: 'completed' }]
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

  // "first"'s turn has not ended: "second" must not follow.
  await clock.advance(5_000)
  expect(submitted).toEqual(['first'])

  // "first"'s turn is interrupted: the queue holds.
  await start($, 't1')
  await complete($, 't1', 'aborted')
  await clock.advance(5_000)
  expect(submitted).toEqual(['first'])

  // The person's next turn ends normally: "second" goes.
  await start($, 't2')
  await complete($, 't2')
  await clock.advance(3_000)
  expect(submitted).toEqual(['first', 'second'])
})

test('the band lists the queue and why it waits', async ($, on) => {
  const { clock } = world(on, { list: [] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($, 't1')
  await after($, 'write the changelog')
  await clock.advance(1_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface, true)
    expect(await ui.find({ type: 'Text', text: /Claude 正在工作/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /write the changelog/ })).toBeDefined()
    await ui.unmount()
  }
})

test('edit from the band: held while edited, replaced in place, then sent', async ($, on) => {
  const { clock, submitted, box } = world(on, { list: [] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($, 't1')
  await after($, 'frist draft')
  await after($, 'second')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface, true)
    const edit = (await ui.findAll({ type: 'Button' })).find(b => b.text === '编辑')
    expect(edit?.key).toBeDefined()
    if (surface === 'terminal') {
      await ui.press({ key: String(edit?.key) })
      expect(box.text).toBe('/after frist draft')
      expect(await ui.find({ type: 'Text', text: /编辑中/ })).toBeDefined()
    }
    await ui.unmount()
  }

  // The turn ends; the head item is being edited, so nothing goes.
  await complete($, 't1')
  await clock.advance(5_000)
  expect(submitted).toEqual([])

  // Enter on the edited line replaces the item in place, then it goes first.
  box.text = ''
  await after($, 'first draft, fixed')
  await clock.advance(3_000)
  expect(submitted).toEqual(['first draft, fixed'])
})

test('/after --edit N, and an edit never overwrites a draft', async ($, on) => {
  const { clock, submitted, box } = world(on, { list: [] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($, 't1')
  await after($, 'one')
  await after($, 'two')

  await after($, '--edit 2')
  expect(box.text).toBe('/after two')
  await after($, 'two, edited')

  // A draft of the person's own is left alone.
  box.text = 'something I am typing'
  const ui = await band($, 'terminal', true)
  const edit = (await ui.findAll({ type: 'Button' })).find(b => b.text === '编辑')
  await ui.press({ key: String(edit?.key) })
  expect(box.text).toBe('something I am typing')
  await ui.unmount()

  await complete($, 't1')
  await clock.advance(3_000)
  expect(submitted).toEqual(['one'])
  await start($, 't2')
  await complete($, 't2')
  await clock.advance(3_000)
  expect(submitted).toEqual(['one', 'two, edited'])
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

test('a "running" turn restored from an earlier load is dropped once the prompt box is idle', async ($, on) => {
  const { clock, submitted } = world(on, { list: [] })
  // An earlier load heard a turn start and was unloaded before its end.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($, 'lost-turn')
  await clock.advance(100)
  // The next load restores that turn from $.state.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await after($, 'should still go')
  await clock.advance(1_000)
  expect(submitted).toEqual([])

  const ui = await band($, 'terminal', false)
  await clock.advance(6_000)
  await ui.unmount()
  expect(submitted).toEqual(['should still go'])
})

test('a turn this load heard start is not dropped on the prompt box alone', async ($, on) => {
  const { clock, submitted } = world(on, { list: [] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($, 't1')
  await after($, 'wait for me')
  const ui = await band($, 'terminal', false)
  await clock.advance(10_000)
  await ui.unmount()
  expect(submitted).toEqual([])
})

test('/after --debug reports the tracker', async ($, on) => {
  world(on, { list: [] })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await start($, 't9')
  const out = await after($, '--debug')
  expect(String(out.text)).toContain('mainTurns: [t9]')
  expect(String(out.text)).toContain('turn.start main t9')
})
