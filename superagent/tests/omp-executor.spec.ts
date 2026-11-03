import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { key, latestAssignment, runningAssignment } from '../src/core/index.ts'
import { workerSessionId } from '../src/executor/work.ts'
import { KV } from '../src/kv.ts'
import type { FakeSession } from './fixtures/fake-omp.ts'
import { pendingTicket, startExecutorHost, type ExecutorHost } from './fixtures/executor-host.ts'

let h: ExecutorHost
beforeEach(() => { h = startExecutorHost() })
afterEach(async () => { vi.useRealTimers(); await h.stop() })

/** Starts `ticket`'s pending assignment and waits until its worker session launches and starts. */
const launchWorker = async (ticketId: string): Promise<FakeSession> => {
  const ticket = h.store.tickets.get(ticketId)!
  h.executor.start(ticket, latestAssignment(ticket)!)
  await vi.waitFor(() => { expect(runningAssignment(h.store.tickets.get(ticketId)!)).toBeDefined() })
  return h.session(workerSessionId(ticketId))
}

it('reports waiting with the worker\'s last words once its turn yields and settles, then parks the session', async () => {
  pendingTicket(h)
  const session = await launchWorker('t1')
  const worker = runningAssignment(h.store.tickets.get('t1')!)!
  void worker
  session.respond('get_last_assistant_text', { text: 'All done here' })
  session.emit({ type: 'agent_end', yielded: true, isTerminal: true })
  session.emit({ type: 'session_settled' })
  await vi.waitFor(() => { expect(runningAssignment(h.store.tickets.get('t1')!)?.report?.state).toBe('waiting') })
  const stored = h.store.tickets.get('t1')!
  // turnEnded records when the turn ended; the waiting report carries the worker's last words.
  expect(runningAssignment(stored)?.idleAt).toBeDefined()
  expect(runningAssignment(stored)?.report).toMatchObject({ state: 'waiting', summary: 'All done here' })
  // The worker session is parked: closed once, and no longer holding a slot.
  await vi.waitFor(() => { expect(h.sessions.state(workerSessionId('t1'))).toBe('absent') })
  expect(h.executor.activeCount()).toBe(0)
})

it('parks a worker that reported ready without taking a slot', async () => {
  pendingTicket(h)
  // The ticket follows an open thread, so the ready report is recorded but the ticket stays live.
  const following = h.store.tickets.get('t1')!
  following.follows = [{ thread: 'github:42', own: true }]
  h.store.tickets.save(following)
  const session = await launchWorker('t1')
  session.emit({ type: 'agent_start' })
  expect(h.executor.activeCount()).toBe(1)
  await session.callTool('orchestrator_report', { state: 'ready', summary: 'PR opened' })
  expect(h.store.tickets.get('t1')!.ended).toBeUndefined()
  session.emit({ type: 'agent_end', yielded: true, isTerminal: true })
  // The handed-off yield parks without a slot: turnEnded is recorded, no waiting report follows.
  await vi.waitFor(() => { expect(runningAssignment(h.store.tickets.get('t1')!)?.idleAt).toBeDefined() })
  expect(h.executor.activeCount()).toBe(0)
  expect(runningAssignment(h.store.tickets.get('t1')!)?.report?.state).toBe('ready')
  session.emit({ type: 'session_settled' })
  await vi.waitFor(() => { expect(h.sessions.state(workerSessionId('t1'))).toBe('absent') })
})

it('stops background work at the 30-minute limit and buffers the notice for the next turn', async () => {
  vi.useFakeTimers()
  try {
    pendingTicket(h)
    const session = await launchWorker('t1')
    const assignment = runningAssignment(h.store.tickets.get('t1')!)!
    const close = vi.spyOn(h.sessions, 'close')
    session.respond('get_last_assistant_text', { text: 'still working' })
    session.emit({ type: 'agent_end', yielded: true, isTerminal: true })
    // No settle arrives; the limit fires and closes the session with an abort.
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    await vi.waitFor(() => { expect(h.sessions.state(workerSessionId('t1'))).toBe('absent') })
    expect(close).toHaveBeenCalledWith(workerSessionId('t1'), { abort: true })
    const stored = h.store.tickets.get('t1')!
    expect(runningAssignment(stored)?.report).toMatchObject({ state: 'waiting',
      summary: expect.stringContaining('Background work ran 30 minutes after the worker\'s turn ended and was stopped.') })
    // The killed notice is buffered in notes since the session is gone.
    const notes = h.store.get(KV.sessions.notes(workerSessionId('t1')))!
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ key: key(`killed:${assignment.id}`), summary: 'Background work stopped' })
    expect(notes[0]!.text).toContain('Your background work ran 30 minutes after your turn ended and was stopped with the session.')
  } finally {
    vi.useRealTimers()
  }
})

it('interrupts the running assignment when its worker exits unexpectedly', async () => {
  pendingTicket(h)
  const session = await launchWorker('t1')
  const assignment = runningAssignment(h.store.tickets.get('t1')!)!
  session.exit(1)
  // The interrupt restarts the assignment with a recovery note; the relaunch then starts it again.
  await vi.waitFor(() => { expect(h.store.tickets.get('t1')!.assignments).toHaveLength(2) })
  const stored = h.store.tickets.get('t1')!
  expect(stored.assignments[0]).toMatchObject({ id: assignment.id, state: 'ended', endedReason: 'hostRestarted' })
  expect(stored.inputs.some(input => input.kind === 'text' && input.text.includes('host restarted'))).toBe(true)
  await vi.waitFor(() => { expect(runningAssignment(h.store.tickets.get('t1')!)?.id).toBe(stored.assignments[1]!.id) })
})

it('retries a failed turn after the backoff with the retry key', async () => {
  vi.useFakeTimers()
  try {
    pendingTicket(h)
    const session = await launchWorker('t1')
    const assignment = runningAssignment(h.store.tickets.get('t1')!)!
    session.emit({ type: 'prompt_result', status: 'error',
      error: { message: 'upstream overloaded, try again', retryable: true, httpStatus: 503 } })
    // Nothing is sent before the 15-second backoff elapses.
    expect(session.commands.filter(command => command.type === 'prompt')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(15_000)
    await vi.waitFor(() => {
      expect(session.commands.filter(command => command.type === 'prompt')).toHaveLength(2)
    })
    const retry = session.commands.filter(command => command.type === 'prompt')[1]!
    expect(retry.message).toContain(`[superagent:${key(`retry:${assignment.id}:1`)}]`)
    expect(retry.message).toContain('Your last turn failed for a passing reason')
  } finally {
    vi.useRealTimers()
  }
})

it('runs the prepare command with the worker shims and the ticket variables', async () => {
  const workerBin = `${h.directory}/worker-bin`
  // A prepare command that records the environment it ran with.
  const settings = h.store.settings()
  h.store.saveSettings({ ...settings, executor: { ...settings.executor,
    prepare: `echo "PATH=$PATH" > env.txt; echo "GIT=$GIT_CONFIG_GLOBAL" >> env.txt; echo "TICKET=$OMP_SUPERAGENT_TICKET" >> env.txt` } })
  pendingTicket(h)
  await launchWorker('t1')
  const envFile = join(h.directory, 'work', 'env.txt')
  expect(existsSync(envFile)).toBe(true)
  const text = readFileSync(envFile, 'utf8')
  expect(text).toContain(`PATH=${workerBin}:`)
  expect(text).toContain(`GIT=${h.directory}/worker-gitconfig`)
  expect(text).toContain('TICKET=t1')
})
