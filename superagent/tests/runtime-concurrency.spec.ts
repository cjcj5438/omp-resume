/** Concurrent runtime behavior across overlapping triggers, deliveries, and worker launches. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { latestAssignment, waitsForPerson, type Ticket, type Trigger } from '../src/core/index.ts'
import { Later } from '../src/app/effects.ts'
import { reportRelay } from '../src/app/notices.ts'
import { WorkerSlots, inputMessage, mandateInstructions, ticketExecution, transient, triggerMessage } from '../src/executor/work.ts'
import { SettingsSchema } from '../src/policy.ts'
import { Commands } from '../src/infra/commands.ts'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deferred, waitUntil } from './fixtures/async.ts'
import { CHAT, MEMBER, feishu, startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const lark = { users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false }
const linkLookedUp = (messageId: string) =>
  vi.mocked(Commands.prototype.lark).mock.calls.some(([args]) => args.includes('+messages-mget') && args.includes(messageId))
/** Hold the next `prompt` request to `sessionId` until `gate` resolves; `held()` says whether one began. */
function holdPrompt(sessionId: string, gate: Promise<void>) {
  let held = false
  h.session(sessionId).respond('prompt', () => {
    held = true
    // The host wrapper records and confirms the prompt once this resolves; the responder stack
    // (last registered wins) routes the request here instead of the harness default. The fake
    // resolves responders with the raw return, so await the gate inside an async responder.
    return (async () => { await gate; return {} })() as unknown as Record<string, never>
  })
  return () => held
}
/** The worker's turn ends: yielded, then settled, as its session frames say. */
const idle = async (sessionId: string): Promise<void> => {
  const fake = h.session(sessionId)
  fake.respond('get_last_assistant_text', { text: '' })
  fake.emit({ type: 'agent_end', yielded: true })
  // Let the yield handler subscribe before the settle lands, as a real session's frames would.
  await new Promise(resolve => setTimeout(resolve, 0))
  fake.emit({ type: 'session_settled' })
  await h.runtime.idle()
}
/** The worker's last words, as `get_last_assistant_text` answers them. */
const said = (sessionId: string, text: string): void => {
  h.session(sessionId).respond('get_last_assistant_text', { text })
}
/** Fail the worker's turn with a provider error frame. */
const fail = (sessionId: string, message: string, retryable: boolean, httpStatus?: number): void => {
  h.session(sessionId).emit({ type: 'prompt_result', status: 'error', error: { message, retryable, ...(httpStatus === undefined ? {} : { httpStatus }) } })
}
const botMessage = () => feishu('2', 'CI 失败', { mentions: [], root_id: 'om_1', sender_id: 'cli_ci', sender_type: 'bot' })
const later = () => new Promise(resolve => setTimeout(resolve, 5))
const minutes = (n: number) => vi.advanceTimersByTimeAsync(n * 60_000)
const running = (sessionId: string): boolean => {
  const state = h.runtime.sessions.state(sessionId)
  return state === 'starting' || state === 'running' || state === 'settling'
}


it('evaluates a message that arrives on a thread while an earlier candidate\'s card waits for its link, in the thread\'s next Eval', async () => {
  const gate = deferred()
  // The first candidate's source link lookup is slow; Feishu allows it up to linkTimeoutMs.
  vi.mocked(Commands.prototype.lark).mockImplementation(async args => { if (args.includes('+messages-mget') && args.includes('om_1')) await gate.promise; return lark })
  await h.runtime.settings.pause(true, 'panel')
  const a1 = feishu('1', '@bot 修 A'), b1 = feishu('2', '@bot 修 B'), b2 = feishu('3', '@bot B 还有这个', { root_id: 'om_2' })
  h.runtime.receive(a1); h.runtime.receive(b1)
  await h.runtime.settings.pause(false, 'panel')
  await waitUntil(() => linkLookedUp('om_1'))
  h.runtime.receive(b2)
  gate.resolve(); await h.runtime.idle()
  const threadB = `feishu:${CHAT}:om_2`
  expect(h.runtime.store.threads.get(threadB)).toMatchObject({ evaluating: { triggerIds: [b1.id] }, pending: [b2.id] })
  await h.route({ kind: 'ignore', trigger_id: b1.id, reason: 'duplicate' })
  await h.runtime.idle()
  expect(h.runtime.store.threads.get(threadB)).toMatchObject({ evaluating: { triggerIds: [b2.id] }, pending: [] })
  // A slow link lookup holds only its own candidate's card.
  expect(h.candidates()).toEqual([b1.id, a1.id, b2.id])
})

it('delivers nothing to a ticket a person stopped while an earlier ticket\'s delivery waited', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  await h.runtime.settings.pause(true, 'panel')
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' }))
  h.runtime.receive(feishu('6', '二的补充', { mentions: [], root_id: 'om_5', sender_id: 'ou_guest' }))
  // Tickets are processed newest-first, so holding ticket two pauses the pass before ticket one is delivered.
  const gate = deferred()
  const resumed = h.runtime.settings.pause(false, 'panel')
  const held = holdPrompt(two.sessionId, gate.promise)
  await resumed
  await h.runtime.pump()
  await waitUntil(held)
  await h.runtime.engine.stopTicket(one.ticket.id)
  const before = h.deliveries.mock.calls.length
  gate.resolve(); await h.runtime.idle()
  expect(h.deliveries.mock.calls.slice(before).map(([call]) => call.sessionId)).not.toContain(one.sessionId)
  expect(h.runtime.store.tickets.get(one.ticket.id)).toMatchObject({ ended: { by: 'human' }, undelivered: [] })
})

it('drops a delivery whose ticket a person stopped while it waited for the worker Session', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  await h.runtime.settings.pause(true, 'panel')
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' }))
  const gate = deferred()
  const held = holdPrompt(one.sessionId, gate.promise)
  const resumed = h.runtime.settings.pause(false, 'panel')
  await waitUntil(held, 10000)
  await h.runtime.engine.stopTicket(one.ticket.id)
  gate.resolve(); await resumed
  // The orphaned prompt waiter settles on the 15-minute delivery timeout: the session died with the ticket,
  // so no confirmation can arrive; the timeout resolves it and the attempt is dropped.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try { await vi.advanceTimersByTimeAsync(15 * 60_000) } finally { vi.useRealTimers() }
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(one.ticket.id)).not.toHaveProperty('delivery')
})



it('runs prepare commands in the background, side by side, while accepts, intake and passes go on', async () => {
  const settings = h.runtime.store.settings()
  const gate = join(h.directory, 'prepare-gate'), started = join(h.directory, 'prepare-started')
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor,
    prepare: `echo started >> '${started}'; while [ ! -f '${gate}' ]; do sleep 0.05; done` } })
  const prepares = () => existsSync(started) ? readFileSync(started, 'utf8').trim().split('\n').length : 0
  const first = [feishu('1', '@bot 修一'), feishu('2', '@bot 修二')]
  for (const trigger of first) h.runtime.receive(trigger)
  await h.runtime.idle()
  // Fire both accepts without waiting: each launch blocks on the gated prepare, so both run side by side.
  const main = h.session(h.runtime.masterId)
  const before = main.toolCalls.length
  const accepts = first.map((trigger, index) =>
    main.callTool('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: trigger.id, title: 'fix', worktree_name: `fix-${index}`, acknowledgement: '收到。' }] }))
  await waitUntil(() => prepares() === 2)
  await Promise.all(accepts)
  for (const call of main.toolCalls.slice(before)) {
    const { results } = JSON.parse((call.result as { content: { text: string }[] }).content[0]!.text!) as { results: Record<string, unknown>[] }
    expect(results[0]).toMatchObject({ decision: 'accept', ticket: { state: 'working/queued' } })
  }
  // A Source loop's next message is stored at once, and a pass relays it while both prepare commands still run.
  const later = feishu('3', '@bot 修三')
  expect(h.runtime.receive(later)).toBe('stored')
  await h.runtime.pump()
  await waitUntil(() => h.candidates().length === 3)
  expect(h.candidates()).toEqual([...first, later].map(trigger => trigger.id))
  writeFileSync(gate, '')
  await h.runtime.idle()
  expect(h.runtime.store.tickets.list().map(ticket => ticket.assignments.at(-1)!.state)).toEqual(['running', 'running'])
})

it('keeps a launch that a pause cut short queued, and finishes it once processing resumes', async () => {
  const settings = h.runtime.store.settings()
  const gate = join(h.directory, 'prepare-gate'), started = join(h.directory, 'prepare-started')
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor,
    prepare: `echo started >> '${started}'; while [ ! -f '${gate}' ]; do sleep 0.05; done` } })
  const trigger = feishu('1', '@bot 修一')
  h.runtime.receive(trigger); await h.runtime.idle()
  await h.session(h.runtime.masterId).callTool('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: trigger.id, title: 'fix', worktree_name: 'fix-one', acknowledgement: '收到。' }] })
  await waitUntil(() => existsSync(started))
  await h.runtime.settings.pause(true, 'panel')
  writeFileSync(gate, ''); await h.runtime.idle()
  const [ticket] = h.runtime.store.tickets.list()
  expect(ticket!.assignments).toEqual([expect.objectContaining({ state: 'pending' })])
  expect(h.runtime.effects.pending('launch')).toBe(true)
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
  try { await h.runtime.settings.pause(false, 'panel'); await h.runtime.idle() } finally { vi.useRealTimers() }
  expect(h.runtime.store.tickets.get(ticket!.id)!.assignments).toEqual([expect.objectContaining({ state: 'running' })])
})

it('wakes an idle worker for a bot\'s Input only when a worker slot is free, and creates a worker Session someone deleted again', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  h.session(two.sessionId).emit({ type: 'agent_start' })
  expect(running(two.sessionId)).toBe(true)
  h.runtime.receive(botMessage()); await h.runtime.idle()
  // Ticket two's worker takes the only slot, so ticket one's Input waits.
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toHaveLength(1)
  await idle(two.sessionId)
  await h.runtime.sessions.close(one.sessionId)
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
  try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toEqual([])
  expect(h.runtime.sessions.state(one.sessionId)).not.toBe('absent')
})

it('wakes an idle worker for a person\'s message at once, in the slot kept beyond the limit', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  h.session(one.sessionId).emit({ type: 'agent_end', yielded: true })
  h.session(one.sessionId).emit({ type: 'session_settled' })
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  h.session(two.sessionId).emit({ type: 'agent_start' })
  expect(running(two.sessionId)).toBe(true)
  h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toEqual([])
  await idle(two.sessionId)
})

it('counts a launch under way against maxWorkers, so a bot\'s Input for an idle worker waits for the slot', async () => {
  const settings = h.runtime.store.settings()
  const gate = join(h.directory, 'prepare-gate'), started = join(h.directory, 'prepare-started')
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  // Ticket two's launch holds the only slot while its prepare command runs, before its worker's Session does.
  h.runtime.store.saveSettings({ ...h.runtime.store.settings(), executor: { ...h.runtime.store.settings().executor,
    prepare: `echo started >> '${started}'; while [ ! -f '${gate}' ]; do sleep 0.05; done` } })
  h.runtime.receive(feishu('5', '@bot 修二')); await h.runtime.idle()
  await h.session(h.runtime.masterId).callTool('orchestrator_route', { decisions: [{ kind: 'accept', trigger_id: feishu('5', '').id, title: 'two', worktree_name: 'fix-two', acknowledgement: '收到。' }] })
  await waitUntil(() => existsSync(started))
  h.runtime.receive(botMessage()); await h.runtime.pump()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toHaveLength(1)
  writeFileSync(gate, ''); await h.runtime.idle()
  const two = h.runtime.store.tickets.list().find(ticket => ticket.id !== one.ticket.id)!
  h.session(`worker-${two.id}`).emit({ type: 'agent_start' })
  // The slot is ticket two's now, so ticket one's Input still waits.
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toHaveLength(1)
  await idle(`worker-${two.id}`)
})

it('records on the ticket that its worker Session could not be created again', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  await h.runtime.sessions.close(one.sessionId)
  const realLaunch = h.launcher.launch.bind(h.launcher)
  h.launcher.launch = (async (spec, log) => {
    if (spec.env.OMP_SUPERAGENT_SESSION === one.sessionId) throw new Error('The Session store is offline')
    return realLaunch(spec, log)
  }) as typeof h.launcher.launch
  try {
    h.runtime.receive(feishu('2', '一的补充', { mentions: [], root_id: 'om_1', sender_id: 'ou_guest' })); await h.runtime.idle()
    expect(h.runtime.store.tickets.get(one.ticket.id)).toMatchObject({ delivery: { error: expect.stringContaining('The Session store is offline') } })
  } finally { h.launcher.launch = realLaunch }
})

it('lets a worker go on after a passing provider failure, three times, before its ticket fails', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
  const busy = () => fail(one.sessionId, 'Service Unavailable', false, 503)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    busy()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(h.deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === one.sessionId).at(-1)!.text)
      .toContain('Your last turn failed for a passing reason')
    expect(latestAssignment(ticket())?.report).toBeUndefined()
  } finally { vi.useRealTimers() }
  // Each failure of a new turn counts: the agent_start between them resets the turn's dedup.
  h.session(one.sessionId).emit({ type: 'agent_start' })
  busy()
  h.session(one.sessionId).emit({ type: 'agent_start' })
  busy()
  expect(latestAssignment(ticket())?.report).toBeUndefined()
  // The fourth passing failure fails the ticket, as any other failure does at once.
  h.session(one.sessionId).emit({ type: 'agent_start' })
  busy()
  await vi.waitFor(() => expect(latestAssignment(ticket())?.report).toMatchObject({ state: 'failed', summary: expect.stringContaining('Service Unavailable') }))
  h.session(one.sessionId).emit({ type: 'agent_end', yielded: true })
  h.session(one.sessionId).emit({ type: 'session_settled' })
})

describe('a worker that goes on after a passing failure', () => {
  const busy = (sessionId: string) => fail(sessionId, 'Service Unavailable', false, 503)
  const told = (sessionId: string) => h.deliveries.mock.calls.map(([call]) => call)
    .filter(call => call.sessionId === sessionId && call.text.includes('Your last turn failed for a passing reason'))

  it('starts the count of passing failures again once its turn ends as turns do', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      busy(one.sessionId)
      h.session(one.sessionId).emit({ type: 'agent_start' })
      busy(one.sessionId)
      h.session(one.sessionId).emit({ type: 'agent_start' })
      busy(one.sessionId)
      await vi.advanceTimersByTimeAsync(65_000)
    } finally { vi.useRealTimers() }
    expect(told(one.sessionId)).toHaveLength(3)
    // Once the resumed turn ends normally, a later passing failure starts a new retry count rather than counting as the fourth in a row.
    said(one.sessionId, '')
    await idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
    busy(one.sessionId)
    await h.runtime.idle()
    expect(latestAssignment(ticket())?.report?.state).toBe('waiting')
  })

  it('waits while processing is paused, and goes on once it resumes', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    await h.runtime.settings.pause(true, 'panel')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      busy(one.sessionId)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(told(one.sessionId)).toEqual([])
      await h.runtime.settings.pause(false, 'panel')
      await vi.advanceTimersByTimeAsync(5000)
    } finally { vi.useRealTimers() }
    expect(told(one.sessionId)).toHaveLength(1)
  })

  it('drops its timer when the host stops within the backoff', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      busy(one.sessionId)
      await h.runtime.stop()
      // Its timer is cleared with the Executor, so nothing reads the closed database.
      await vi.advanceTimersByTimeAsync(60_000)
    } finally { vi.useRealTimers() }
    expect(told(one.sessionId)).toEqual([])
  })

})

it('reports nothing for a worker whose turn ends while it waits out the backoff of a passing failure', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  const relayed = h.relays(h.runtime.masterId).length
  fail(one.sessionId, 'Service Unavailable', false, 503)
  await idle(one.sessionId)
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report).toBeUndefined()
  expect(h.relays(h.runtime.masterId)).toHaveLength(relayed)
})

it('wakes an idle worker for a status request in the slot kept for a person, while every other slot is taken', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, executor: { ...settings.executor, maxWorkers: 1 } })
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  // Its worker ended its turn without a report, so it waits.
  await idle(one.sessionId)
  await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report?.state).toBe('waiting'))
  const two = await h.acceptedTicket(feishu('5', '@bot 修二'))
  h.session(two.sessionId).emit({ type: 'agent_start' })
  expect(running(two.sessionId)).toBe(true)
  expect(h.runtime.engine.requestStatus(one.ticket.id)).toBe(true); await h.runtime.idle()
  expect(h.runtime.store.tickets.get(one.ticket.id)!.undelivered).toEqual([])
  await idle(two.sessionId)
})

it('reports a worker waiting when its turn ends after a person answered its blocked report', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  await h.runTool(one.sessionId, 'orchestrator_report', { state: 'blocked', summary: 'Which color?' })
  // The person answers later than the report.
  await new Promise(resolve => setTimeout(resolve, 5))
  h.runtime.receive(feishu('2', '蓝色', { mentions: [], root_id: 'om_1' })); await h.runtime.idle()
  const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
  expect(waitsForPerson(ticket())).toBe(false)
  await idle(one.sessionId)
  await vi.waitFor(() => expect(latestAssignment(ticket())?.report?.state).toBe('waiting'))
})

it('resumes an ended ticket a person wrote to during a pause once it lifts, under the Policy then', async () => {
  const pass = async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 6000 })
    try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  }
  const ended = async (id: string) => {
    const { ticket, sessionId } = await h.acceptedTicket(feishu(id, `@bot 修${id}`, { root_id: `om_${id}` }))
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done.' })
    return ticket.id
  }
  const first = await ended('1'), second = await ended('3')
  const followUp = async (id: string, root: string) => {
    await h.runtime.settings.pause(true, 'panel')
    h.runtime.receive(feishu(id, '再改一下', { mentions: [], root_id: root })); await h.runtime.idle()
  }
  // While processing is paused, the message waits on the ended ticket; the first pass after the pause resumes it.
  await followUp('2', 'om_1')
  expect(h.runtime.store.tickets.get(first)).toMatchObject({ ended: expect.anything(), undelivered: [expect.any(String)] })
  await h.runtime.settings.pause(false, 'panel'); await pass()
  expect(h.runtime.store.tickets.get(first)).toMatchObject({ assignments: [expect.anything(), expect.objectContaining({ state: 'running' })] })
  expect(h.runtime.store.tickets.get(first)).not.toHaveProperty('ended')
  // A Mandate the Policy no longer holds when the pause lifts does not resume: its sender left the list meanwhile.
  await followUp('4', 'om_3')
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, policy: { ...settings.policy, sources: { ...settings.policy.sources, feishu: { ...settings.policy.sources.feishu!, allowed: [] } } } })
  await h.runtime.settings.pause(false, 'panel'); await pass()
  expect(h.runtime.store.tickets.get(second)).toMatchObject({ ended: expect.anything(), undelivered: [] })
})

it('ends a worker\'s turn only when the stop that ended its Assignment commits', async () => {
  const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
  expect(() => h.runtime.store.atomic(() => { h.runtime.engine.stopTicket(one.ticket.id); throw new Error('rolled back') })).toThrow('rolled back')
  expect(h.runtime.sessions.state(one.sessionId)).not.toBe('absent')
  expect(h.runtime.store.tickets.get(one.ticket.id)!.ended).toBeUndefined()
  h.runtime.engine.stopTicket(one.ticket.id)
  await vi.waitFor(() => expect(h.runtime.sessions.state(one.sessionId)).toBe('absent'))
})

describe('a worker whose background work runs on after its turn', () => {

  it('records each end of a worker\'s turn on its Assignment, also after its ready report', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'PR ready' }); await h.runtime.idle()
    const report = latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)!.report!
    await new Promise(resolve => setTimeout(resolve, 5))
    await idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)!.idleAt! > report.at).toBe(true))
  })

  it('shows no turn end on a running Assignment whose worker works again, whatever turn ends were recorded', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    await idle(one.sessionId)
    await vi.waitFor(() => expect(latestAssignment(h.runtime.store.tickets.get(one.ticket.id)!)?.report?.state).toBe('waiting'))
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'progress', summary: 'On it again' })
    const page = await h.api('GET', `tickets/${one.ticket.id}`)
    expect((page.body as { assignments: Record<string, unknown>[] }).assignments[0]).not.toHaveProperty('turnEndedAt')
  })

  it('gives each yield of a worker its own 30 minutes, and a new turn ends the old look', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    said(one.sessionId, 'working')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      h.session(one.sessionId).emit({ type: 'agent_end', yielded: true })
      await minutes(20)
      // The worker runs again, which aborts the first look; it yields again 5 minutes later.
      h.session(one.sessionId).emit({ type: 'agent_start' })
      await minutes(5)
      h.session(one.sessionId).emit({ type: 'agent_end', yielded: true })
      // 35 minutes after the first yield, 10 after the second: nothing stopped, nothing reported.
      await minutes(10)
      expect(h.runtime.sessions.state(one.sessionId)).not.toBe('absent')
      expect(latestAssignment(ticket())?.report).toBeUndefined()
      await minutes(21)
    } finally { vi.useRealTimers() }
    // 30 minutes after the second yield the session closes and the worker reports waiting.
    await vi.waitFor(() => expect(h.runtime.sessions.state(one.sessionId)).toBe('absent'))
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report).toMatchObject({ state: 'waiting',
      summary: expect.stringContaining("Background work ran 30 minutes after the worker's turn ended and was stopped.") }))
  })

  it('stops with the session background work that runs 30 minutes after the turn ended, and reports waiting after the worker\'s words', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    said(one.sessionId, 'The tests run in the background.')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      h.session(one.sessionId).emit({ type: 'agent_end', yielded: true })
      await minutes(29)
      expect(latestAssignment(ticket())?.report).toBeUndefined()
      await minutes(2)
    } finally { vi.useRealTimers() }
    await vi.waitFor(() => expect(latestAssignment(ticket())?.report).toMatchObject({ state: 'waiting',
      summary: 'The tests run in the background.\n\nBackground work ran 30 minutes after the worker\'s turn ended and was stopped.' }))
    expect(h.runtime.sessions.state(one.sessionId)).toBe('absent')
    expect(h.relays(h.runtime.masterId).at(-1)).toMatchObject({ kind: 'worker_report', state: 'waiting' })
  })

})

describe('what a worker read', () => {
  /** A ticket its worker completed, and a person's thanks on its thread, which resumes it once received. */
  async function completed() {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done' }); await h.runtime.idle()
    await idle(one.sessionId)
    await later()
    return { one, thanks: feishu('2', '@bot 谢谢', { root_id: 'om_1' }), ticket: () => h.runtime.store.tickets.get(one.ticket.id)! }
  }
  /** Runs `then` after the delivery retry, two seconds on; the clock moves on only by `vi.setSystemTime`. */
  async function retried(then: () => Promise<void>) {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2000 })
    try { await h.runtime.pump(); await h.runtime.idle(); await then(); await h.runtime.pump(); await h.runtime.idle() }
    finally { vi.useRealTimers() }
  }
  it('sends to Eval a message that woke a ticket and that a retry delivered after a progress report, at a dropped report', async () => {
    const { one, thanks, ticket } = await completed()
    // The resumed launch succeeds, but the thanks delivery fails until the retry lets it through.
    // Arm every (re)launched worker session before it can take a prompt: the fail flag flips on retry.
    const realLaunch = h.launcher.launch.bind(h.launcher)
    let fail = true
    h.launcher.launch = (async (spec, log) => {
      const channel = await realLaunch(spec, log)
      if ((spec.env.OMP_SUPERAGENT_SESSION ?? '').startsWith('worker-')) {
        const armed = h.launcher.sessions.at(-1)!
        // Arm after the host wrapper adds its default responders (responder stack: last wins).
        setTimeout(() => {
          armed.respond('prompt', (command: Record<string, unknown>) => {
            if (fail && command.streamingBehavior === 'steer') throw new Error('Session busy')
            return {}
          })
        })
      }
      return channel
    }) as typeof h.launcher.launch
    try {
      h.runtime.receive(thanks)
      await h.runtime.pump()
      await h.runtime.idle()
      expect(ticket().delivery).toBeDefined()
      await h.runTool(one.sessionId, 'orchestrator_report', { state: 'progress', summary: 'Looking' })
      fail = false
      // The retry steers the message in while the worker writes that nothing is left; the drop sends it to Eval.
      await retried(async () => {
        expect(ticket().undelivered).toEqual([])
        await h.runTool(one.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'Nothing to do' })
      })
      expect(h.candidates()).toContain(thanks.id)
    } finally { h.launcher.launch = realLaunch }
  })

  it('counts a delivered message as read once its session confirms it', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const more = feishu('2', '再改一下', { mentions: [], root_id: 'om_1' })
    h.runtime.receive(more); await h.runtime.idle()
    const input = () => h.runtime.store.tickets.get(one.ticket.id)!.inputs.find(item => item.kind === 'trigger' && item.triggerId === more.id) as
      { readAt?: string | null }
    // The harness confirms every delivery, so the worker reads what reaches it.
    await vi.waitFor(() => expect(input().readAt).not.toBe(null))
  })

  it('counts a message that woke a ticket as read by a later dropped report once a step of its worker took it', async () => {
    const { one, thanks } = await completed()
    // The resumed Assignment's message wakes the worker, whose session confirms the message as read.
    h.runtime.receive(thanks); await h.runtime.idle()
    await later()
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'Nothing to do' })
    await h.runtime.pump(); await h.runtime.idle()
    expect(h.candidates()).not.toContain(thanks.id)
  })

  it('counts a message a retry delivered to its idle worker as read by the report of the turn it woke', async () => {
    const { one, thanks, ticket } = await completed()
    const realLaunch = h.launcher.launch.bind(h.launcher)
    let fail = true
    h.launcher.launch = (async (spec, log) => {
      const channel = await realLaunch(spec, log)
      if ((spec.env.OMP_SUPERAGENT_SESSION ?? '').startsWith('worker-')) {
        const armed = h.launcher.sessions.at(-1)!
        setTimeout(() => {
          armed.respond('prompt', (command: Record<string, unknown>) => {
            if (fail && command.streamingBehavior === 'steer') throw new Error('Session busy')
            return {}
          })
        })
      }
      return channel
    }) as typeof h.launcher.launch
    try {
      h.runtime.receive(thanks)
      await h.runtime.pump()
      await h.runtime.idle()
      expect(ticket().delivery).toBeDefined()
      fail = false
      // The retry wakes the worker, whose session confirms the message as read.
      await retried(async () => {
        vi.setSystemTime(Date.now() + 1000)
        await h.runTool(one.sessionId, 'orchestrator_report', { state: 'dropped', summary: 'Nothing to do' })
      })
      expect(h.candidates()).not.toContain(thanks.id)
    } finally { h.launcher.launch = realLaunch }
  })

  it('sends to Eval at a merge a message that reached the worker after its last step, which no step took before its turn ended', async () => {
    const one = await h.acceptedTicket(feishu('1', '@bot 修一'))
    const ticket = () => h.runtime.store.tickets.get(one.ticket.id)!
    h.runtime.engine.bindThread(one.ticket.id, { source: 'github', id: '7' }, true)
    await h.runTool(one.sessionId, 'orchestrator_report', { state: 'ready', summary: 'PR ready' }); await h.runtime.idle()
    // A person's thanks reaches the worker after its report, but the delivery never lands: the turn
    // ends first and the handoff parks (closes) the session while the prompt is still in flight.
    await later()
    const thanks = feishu('2', '@bot 谢谢', { root_id: 'om_1' })
    const gate = deferred()
    const held = holdPrompt(one.sessionId, gate.promise)
    h.runtime.receive(thanks)
    await waitUntil(held, 10000)
    h.session(one.sessionId).emit({ type: 'agent_end', yielded: true })
    await new Promise(resolve => setTimeout(resolve, 0))
    h.session(one.sessionId).emit({ type: 'session_settled' })
    await vi.waitFor(() => expect(h.runtime.sessions.state(one.sessionId)).toBe('absent'))
    await h.runtime.idle()
    await later()
    h.runtime.engine.threadClosed({ source: 'github', id: '7' }, 'merged', new Date().toISOString())
    await h.runtime.pump(); await h.runtime.idle()
    expect(ticket().ended).toMatchObject({ outcome: 'merged' })
    // The worker never confirmed the thanks, so the merge sends it to Eval.
    expect(h.candidates()).toContain(thanks.id)
    gate.resolve()
    await h.runtime.idle()
  })

})

it('tells a passing failure of the provider or the network from one that a later try would meet again', () => {
  for (const error of [Object.assign(new Error('x'), { status: 429 }), Object.assign(new Error('x'), { status: 503 }),
    Object.assign(new Error('connect'), { code: 'ECONNRESET' }), new TypeError('fetch failed'), new Error('getaddrinfo EAI_AGAIN api.example.com')]) {
    expect(transient(error)).toBe(true)
  }
  for (const error of [Object.assign(new Error('x'), { status: 400 }), Object.assign(new Error('x'), { status: 401 }), new Error('context too long'), 'LlmError: offline']) {
    expect(transient(error)).toBe(false)
  }
})

describe("the Executor's parts", () => {

  it('holds one worker slot per ticket that runs or starts, and lets launches take the slots no worker or wake holds', () => {
    const running = ['t1']
    const slots = new WorkerSlots(() => running, () => 3)
    slots.reserve('t2', 'launch')
    slots.reserve('t3', 'wake')
    expect(slots.used()).toBe(3)
    // launches() excludes 'launch' reservations because the launch queue tracks active launches separately.
    expect(slots.launches()).toBe(1)
    expect(() => slots.reserve('t4', 'wake')).toThrow(Later)
    expect(() => slots.reserve('t3', 'wake')).not.toThrow()
    slots.free('t3')
    expect(slots.used()).toBe(2)
    slots.reserve('t4', 'launch')
    expect(slots.used()).toBe(3)
  })

  it('wakes a worker for a person\'s message in the one slot beyond the limit, and ahead of launches once a slot frees up', () => {
    const running = ['t1', 't2', 't3']
    const slots = new WorkerSlots(() => running, () => 3)
    expect(() => slots.reserve('t4', 'launch')).toThrow(Later)
    expect(() => slots.reserve('t4', 'wake')).toThrow(Later)
    slots.reserve('t5', 'person')
    expect(slots.used()).toBe(4)
    expect(slots.launches()).toBeLessThanOrEqual(0)
    // No second person's wake fits beyond the limit; once a worker ends, it does, while a launch still waits.
    expect(() => slots.reserve('t6', 'person')).toThrow(Later)
    running.splice(0, 1)
    expect(() => slots.reserve('t7', 'launch')).toThrow(Later)
    slots.reserve('t6', 'person')
    expect(slots.used()).toBe(4)
  })

  it('words an assignment, and the limits an inferred mandate sets, from the ticket alone', () => {
    const settings = SettingsSchema.parse({ policy: { rules: [{ id: 'copy', name: 'Copy fixes', enabled: true,
      instruction: 'Fix typos only.' }] } })
    const ticket = { id: 'ticket-0123456789abcdef', origin: { triggerId: 'tr1', triggerIds: [] },
      mandate: { strength: 'inferred', policyVersion: 'v1', basis: { rules: ['copy'] }, actor: { source: 'github', id: 'alice' },
        scope: '' } } as unknown as Ticket
    const execution = ticketExecution(ticket, { kind: 'accept', title: 'Fix', scope: 'the typo', reason: 'r', name: 'fix-typo' } as never,
      settings, '/state')
    expect(execution).toEqual(expect.objectContaining({ name: 'fix-typo-ticket-01234' }))
    expect(execution).not.toHaveProperty('session')
    // The source Trigger goes with the assignment, so the text does not point at it.
    expect(execution.assignment).toContain('Scope: the typo.')
    expect(execution.assignment).not.toContain('trigger/tr1')
    expect(ticketExecution({ ...ticket, mandate: { ...ticket.mandate, strength: 'explicit' } } as Ticket,
      { kind: 'accept', title: 'Fix', scope: 'Fix', reason: 'r', name: 'fix-login', note: 'the login page' } as never, settings, '/state').assignment)
      .toBe('Routing note (not the source request): the login page')
    // The worker's system prompt holds the limits an inferred Mandate sets, so the assignment does not repeat them.
    expect(execution.assignment).not.toContain(mandateInstructions(ticket.mandate))
    expect(execution.assignment).toContain('- Copy fixes (copy): Fix typos only.')
    expect(mandateInstructions({ strength: 'explicit' })).toBe('')
  })

  it('renders each kind of Input as its worker reads it, inline, and no reopen Input', () => {
    const asked = { id: 'tr1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc:om_1' }], actor: { source: 'feishu', id: 'ou_a' }, human: true,
      at: '2026-09-01T00:00:00Z', text: 'Which page?', meta: {} } as Trigger
    const reply = { ...asked, id: 'tr2', text: 'The login page. '.repeat(50) }
    const card = triggerMessage(reply, { source_url: 'https://x' }, 'see the log', asked)
    expect(card).toEqual({ trigger_id: 'tr2', from: 'ou_a', thread: 'feishu:oc:om_1', at: '2026-09-01T00:00:00Z', text: expect.stringMatching(/^The login page\./),
      chars: reply.text.length, read: 'trigger/tr2', source_url: 'https://x', routing_note: 'see the log', replies_to: { trigger_id: 'tr1', preview: 'Which page?' } })
    expect(card.text).toHaveLength(601)
    expect(triggerMessage(asked, {})).toEqual({ trigger_id: 'tr1', from: 'ou_a', thread: 'feishu:oc:om_1', at: asked.at, text: 'Which page?' })
    expect(JSON.parse(inputMessage({ id: 'i1', kind: 'trigger', triggerId: 'tr2', at: '' }, card)!)).toEqual(card)
    expect(JSON.parse(inputMessage({ id: 'i1', kind: 'trigger', triggerId: 'gone', at: '' })!)).toEqual({ trigger_id: 'gone', read: 'trigger/gone' })
    expect(inputMessage({ id: 'i2', kind: 'text', at: '', text: 'Please also update the docs' })).toBe('Please also update the docs')
    // A Policy change says what it means for the ticket, without version hashes.
    const changed = inputMessage({ id: 'i3', kind: 'policy-changed', at: '', from: 'v1', to: 'v2', effect: { requesterAllowed: false,
      requester: { source: 'github', id: 'ci-bot' },
      rules: [{ id: 'copy', name: 'Copy fixes', change: 'changed', instruction: 'Fix typos only.' }, { id: 'visual', name: 'Visual', change: 'disabled' }] } })!
    expect(changed).toContain('Rule Copy fixes (copy), which this ticket was accepted under, changed. Keep the remaining work within it as it reads now: Fix typos only.')
    expect(changed).toContain('Rule Visual (visual), which this ticket was accepted under, no longer applies')
    // The sender is named, a bot as a person.
    expect(changed).toContain('The sender this ticket is for, ci-bot on github, may no longer start work here')
    expect(changed).not.toContain('person')
    expect(changed).not.toContain('v2')
    const mode = inputMessage({ id: 'i6', kind: 'policy-changed', at: '', from: 'v1', to: 'v2', effect: { proactive: false } })!
    expect(mode).toContain('Work inferred from a rule is no longer accepted, as the accept mode is no longer auto')
    expect(mode).not.toContain('sender')
    expect(inputMessage({ id: 'i5', kind: 'resumed', at: '', triggerId: 'tr2' })).not.toContain('tr2')
    expect(inputMessage({ id: 'i4', kind: 'reopen', at: '' } as never)).toBeUndefined()
  })

  it('relays a worker\'s question, result or answer to the main Session, and keeps its progress internal', () => {
    const ticket = { id: 't1', title: 'Fix', updatedAt: '2026-09-01T00:00:00Z', attention: { id: 'a1', question: 'Which color?' }, assignments: [],
      mandate: { strength: 'explicit' }, origin: { triggerId: 'tr1' } } as unknown as Ticket
    expect(reportRelay(ticket, { state: 'progress', summary: 'halfway' })).toBeUndefined()
    expect(reportRelay(ticket, { state: 'blocked', summary: 'need input', question: 'Which color?' }))
      .toMatchObject({ id: 'attention:t1:a1', text: expect.stringContaining('"kind":"worker_attention"') })
    const ready = reportRelay({ ...ticket, attention: undefined } as unknown as Ticket, { state: 'ready', summary: 'Done',
      answers: 'tr9' })!
    expect(ready.id).toMatch(/^report:/)
    expect(JSON.parse(ready.text)).toMatchObject({ kind: 'worker_report', ticket: { ticket_id: 't1' }, trigger_id: 'tr1', state: 'ready', answer_to: 'tr9', summary: 'Done' })
  })

})
