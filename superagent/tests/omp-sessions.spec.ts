import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Effects } from '../src/app/effects.ts'
import { Prompts } from '../src/app/prompts.ts'
import { Store } from '../src/app/store.ts'
import { key } from '../src/core/index.ts'
import { workerSessionId } from '../src/executor/work.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { Ticket } from '../src/core/index.ts'
import { OmpSessions, scanSeen, type OmpSessionsHost } from '../src/omp/sessions.ts'
import { FakeLauncher } from './fixtures/fake-omp.ts'

let dir: string
let store: Store
let effects: Effects
let launcher: FakeLauncher
let sessions: OmpSessions
const logger = { info: () => {}, warn: () => {}, error: () => {} }

const ticket = (id = 't1'): Ticket => ({
  id, title: 'Fix it', decisionId: 'd1', mandate: { strength: 'explicit', basis: { via: 'explicit' } },
  channels: [], assignments: [], inputs: [], createdAt: '2026-11-02T00:00:00.000Z',
  origin: { triggerId: 'tr1', triggerIds: ['tr1'] }, execution: { name: 'fix-it', directory: join(dir, 'work', 'fix-it'), assignment: 'do it' },
}) as unknown as Ticket

function setup() {
  dir = mkdtempSync(join(tmpdir(), 'omp-sessions-'))
  store = new Store(join(dir, 'superagent.sqlite'))
  store.saveSettings(SettingsSchema.parse({}))
  store.set(KV.runtime.masterId, 'main')
  const board = new HealthBoard()
  effects = new Effects(store, board)
  const prompts = new Prompts(store, () => 100_000, () => undefined, () => false)
  launcher = new FakeLauncher()
  const host: OmpSessionsHost = {
    store, prompts, effects, health: board.claim('models'), machine: { stateDir: dir }, masterId: 'main',
    lifetime: new AbortController().signal, ompBin: '/mock/omp', launcher, logger,
    closing: () => false,
    workerEnv: () => ({ PATH: [join(dir, 'worker-bin'), process.env.PATH ?? ''].join(':'), GIT_CONFIG_GLOBAL: join(dir, 'worker-gitconfig') }),
    environment: () => [],
    toolHosts: () => ({
      main: { masterId: 'main', resources: { masterId: 'main' } } as never,
      executor: { resources: { masterId: 'main' }, github: { deployment: { github: { login: 'agent' } } } } as never,
    }),
  }
  sessions = new OmpSessions(host)
  return { store, effects, prompts, board }
}

beforeEach(setup)
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }) })

const stateFile = (id: string, lines: string[]): string => {
  const sessionDir = join(dir, 'sessions', id)
  mkdirSync(sessionDir, { recursive: true })
  const file = join(sessionDir, 's.jsonl')
  writeFileSync(file, `${lines.join('\n')}\n`)
  store.set(KV.sessions.file(id), file)
  return file
}

it('treats a delivered tag found in the session file as holding after restart, without re-prompting', async () => {
  const tag = key('req-1')
  stateFile('main', [
    JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `[superagent:${tag}]\nhello` }] } }),
    JSON.stringify({ type: 'custom_message', content: 'no tag here' }),
  ])
  expect(sessions.holds('main', 'req-1')).toBe(true)
  expect(sessions.holds('main', 'req-2')).toBe(false)
  expect(scanSeen(join(dir, 'sessions', 'main', 's.jsonl'))).toEqual(new Set([tag]))
  expect(sessions.holds('worker-x', 'req-1')).toBe(false)
  void workerSessionId
})

it('buffers main-session notices in KV when absent, and flushes them as /superagent-inject on launch', async () => {
  const events: string[] = []
  sessions.onSessionEvent(event => { events.push(event.type) })
  await sessions.prompt('main', 'notice:prompts:abc', '{"rev":2}', { inject: 'Prompts updated' })
  const notes = store.get(KV.sessions.notes('main'))!
  expect(notes).toHaveLength(1)
  expect(notes[0]!.text.startsWith(`[superagent:${key('notice:prompts:abc')}]\n`)).toBe(true)
  // Launch flushes the buffered note.
  const first = launcher.sessions[0]
  expect(first).toBeUndefined()
  const launching = sessions.ensure('main', dir, 'main', 'orchestrator')
  await vi.waitFor(() => { expect(launcher.sessions[0]).toBeDefined() })
  const session = launcher.sessions[0]!
  session.respond('get_state', { sessionFile: join(dir, 'sessions', 'main', 'live.jsonl'), isStreaming: false })
  session.respond('prompt', { agentInvoked: false })
  await launching
  expect(launcher.launches).toHaveLength(1)
  const inject = session.commands.find(command => typeof command.message === 'string' && (command.message as string).startsWith('/superagent-inject '))
  expect(inject).toBeDefined()
  expect(store.get(KV.sessions.notes('main'))).toEqual([])
  expect(events).not.toContain('started')
})

it('queues injections received while running until the next yield', async () => {
  const launching = sessions.ensure('main', dir, 'main', 'orchestrator')
  await vi.waitFor(() => { expect(launcher.sessions[0]).toBeDefined() })
  const session = launcher.sessions[0]!
  session.respond('get_state', { sessionFile: join(dir, 'sessions', 'main', 'live.jsonl'), isStreaming: false })
  session.respond('prompt', { agentInvoked: false })
  await launching
  session.emit({ type: 'agent_start' })
  expect(sessions.state('main')).toBe('running')
  let accepted = false
  const sent = sessions.prompt('main', 'notice:a:1', 'note-a', { inject: 'A' }, undefined, () => { accepted = true })
  await sent
  expect(accepted).toBe(true)
  expect(session.commands.filter(command => typeof command.message === 'string'
    && (command.message as string).startsWith('/superagent-inject '))).toHaveLength(0)
  session.emit({ type: 'agent_end', yielded: true, isTerminal: true })
  await vi.waitFor(() => {
    expect(session.commands.filter(command => typeof command.message === 'string'
      && (command.message as string).startsWith('/superagent-inject '))).toHaveLength(1)
  })
  expect(sessions.state('main')).toBe('settling')
})

it('warns on inject only when the response says the agent ran', async () => {
  const launching = sessions.ensure('main', dir, 'main', 'orchestrator')
  await vi.waitFor(() => { expect(launcher.sessions[0]).toBeDefined() })
  const session = launcher.sessions[0]!
  session.respond('get_state', { sessionFile: join(dir, 'sessions', 'main', 'live.jsonl'), isStreaming: false })
  await launching
  const warn = vi.spyOn(logger, 'warn')
  try {
    const answers: unknown[] = [undefined, { agentInvoked: false }, { agentInvoked: true }]
    session.respond('prompt', () => answers.shift())
    await sessions.prompt('main', 'notice:a:1', 'note-a', { inject: 'A' })
    expect(warn).not.toHaveBeenCalled()
    await sessions.prompt('main', 'notice:b:2', 'note-b', { inject: 'B' })
    expect(warn).not.toHaveBeenCalled()
    await sessions.prompt('main', 'notice:c:3', 'note-c', { inject: 'C' })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('main'))
  } finally { warn.mockRestore() }
})

it('resolves prompt only when a user message_end carries its tag', async () => {
  const launching = sessions.ensure('main', dir, 'main', 'orchestrator')
  await vi.waitFor(() => { expect(launcher.sessions[0]).toBeDefined() })
  const session = launcher.sessions[0]!
  session.respond('get_state', { sessionFile: join(dir, 'sessions', 'main', 'live.jsonl'), isStreaming: false })
  session.respond('prompt', {})
  await launching
  const tag = key('req-9')
  let done = false
  const sent = sessions.prompt('main', 'req-9', 'do the thing', 'steer').then(() => { done = true })
  await vi.waitFor(() => {
    expect(session.commands.some(command => command.type === 'prompt'
      && typeof command.message === 'string' && (command.message as string).includes(tag))).toBe(true)
  })
  expect(done).toBe(false)
  session.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'working' }] } })
  await new Promise(resolve => setTimeout(resolve, 20))
  expect(done).toBe(false)
  session.emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: `[superagent:${tag}]\ndo the thing` }] } })
  await sent
  expect(done).toBe(true)
  expect(sessions.holds('main', 'req-9')).toBe(true)
})

it('builds launch args exactly like the 0.4 template', async () => {
  store.tickets.save(ticket('t1'))
  const launching = sessions.ensure('worker-t1', join(dir, 'work', 'fix-it'), 'worker', 'worker')
  await vi.waitFor(() => { expect(launcher.sessions[0]).toBeDefined() })
  const session = launcher.sessions[0]!
  session.respond('get_state', { sessionFile: join(dir, 'sessions', 'worker-t1', 'live.jsonl'), isStreaming: true })
  await launching
  const spec = launcher.launches[0]!
  expect(spec.bin).toBe('/mock/omp')
  const promptFile = join(dir, 'prompts', 'worker-t1.r0.md')
  expect(spec.args).toEqual(['--mode', 'rpc', '--no-ui', '--no-title', '--no-extensions',
    '-e', join(dir, 'plugin', 'r0'), '--config', join(dir, 'omp-overlay.yml'),
    '--session-dir', join(dir, 'sessions', 'worker-t1'), '--cwd', join(dir, 'work', 'fix-it'),
    '--approval-mode', 'yolo', '--tools', 'read,bash,edit,write,grep,glob,lsp,task,todo,web_search',
    '--append-system-prompt', promptFile])
  expect(spec.env.OMP_SUPERAGENT_ROLE).toBe('worker')
  expect(spec.env.OMP_SUPERAGENT_SESSION).toBe('worker-t1')
  expect(spec.cwd).toBe(join(dir, 'work', 'fix-it'))
  expect(sessions.state('worker-t1')).toBe('running')
  void session
})

it('strips BUN_BE_BUN from the launch env even when the daemon inherited it', async () => {
  process.env.BUN_BE_BUN = '1'
  try {
    const launching = sessions.ensure('main', dir, 'main', 'orchestrator')
    await vi.waitFor(() => { expect(launcher.sessions[0]).toBeDefined() })
    launcher.sessions[0]!.respond('get_state', { sessionFile: join(dir, 'sessions', 'main', 'live.jsonl'), isStreaming: false })
    await launching
    expect(launcher.launches[0]!.env.BUN_BE_BUN).toBeUndefined()
  } finally { delete process.env.BUN_BE_BUN }
})

it('tracks model retries from real auto_retry wire payloads', async () => {
  const launching = sessions.ensure('main', dir, 'main', 'orchestrator')
  await vi.waitFor(() => { expect(launcher.sessions[0]).toBeDefined() })
  const session = launcher.sessions[0]!
  session.respond('get_state', { sessionFile: join(dir, 'sessions', 'main', 'live.jsonl'), isStreaming: false })
  await launching
  expect(sessions.modelRetry('main')).toEqual({})
  session.emit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 10, delayMs: 500, errorMessage: 'overloaded' })
  session.emit({ type: 'auto_retry_start', attempt: 2, maxAttempts: 10, delayMs: 1000, errorMessage: 'overloaded' })
  const retry = sessions.modelRetry('main')
  if (!('model_retry' in retry)) throw new Error('expected an active model retry')
  expect(retry).toEqual({ model_retry: { since: expect.any(String), attempts: 2 } })
  expect(Date.parse(retry.model_retry.since)).toBeLessThanOrEqual(Date.now())
  session.emit({ type: 'auto_retry_end', success: true, attempt: 2 })
  expect(sessions.modelRetry('main')).toEqual({})
})

it('launches workers under the agent account env and the main session under the operator env', async () => {
  process.env.BUN_BE_BUN = '1'
  try {
    store.tickets.save(ticket('t1'))
    const launching = sessions.ensure('worker-t1', join(dir, 'work', 'fix-it'), 'worker', 'worker')
    await vi.waitFor(() => { expect(launcher.sessions[0]).toBeDefined() })
    launcher.sessions[0]!.respond('get_state', { sessionFile: join(dir, 'sessions', 'worker-t1', 'live.jsonl'), isStreaming: false })
    await launching
    const env = launcher.launches[0]!.env
    expect(env.PATH?.split(':')[0]).toBe(join(dir, 'worker-bin'))
    expect(env.GIT_CONFIG_GLOBAL).toBe(join(dir, 'worker-gitconfig'))
    expect(env.BUN_BE_BUN).toBeUndefined()
    const main = sessions.ensure('main', dir, 'main', 'orchestrator')
    await vi.waitFor(() => { expect(launcher.sessions[1]).toBeDefined() })
    launcher.sessions[1]!.respond('get_state', { sessionFile: join(dir, 'sessions', 'main', 'live.jsonl'), isStreaming: false })
    await main
    const mainEnv = launcher.launches[1]!.env
    expect(mainEnv.PATH?.split(':')[0]).not.toBe(join(dir, 'worker-bin'))
    expect(mainEnv.GIT_CONFIG_GLOBAL).toBe(process.env.GIT_CONFIG_GLOBAL)
    expect(mainEnv.BUN_BE_BUN).toBeUndefined()
  } finally { delete process.env.BUN_BE_BUN }
})

it('relaunches the idle main session when a policy save changes its composed prompt', async () => {
  const launching = sessions.ensure('main', dir, 'main', 'orchestrator')
  await vi.waitFor(() => { expect(launcher.sessions[0]).toBeDefined() })
  launcher.sessions[0]!.respond('get_state', { sessionFile: join(dir, 'sessions', 'main', 'live.jsonl'), isStreaming: false })
  await launching
  expect(launcher.launches).toHaveLength(1)
  // A policy-only save changes the composed orchestrator prompt without touching prompt revisions.
  const settings = store.settings()
  store.saveSettings({ ...settings, policy: { ...settings.policy,
    rules: [...settings.policy.rules, { id: 'extra', name: 'Extra', enabled: true, instruction: 'Mind the gap.' }] } })
  // The next delivery relaunches first, so it lands on the new policy; the prompt carries it.
  // Responders attach synchronously at launch: attaching after the session appears races the get_state request.
  const launched = launcher.launch.bind(launcher)
  launcher.launch = (async (spec, log) => {
    const channel = await launched(spec, log)
    const fresh = launcher.sessions.at(-1)!
    fresh.respond('get_state', { sessionFile: join(dir, 'sessions', 'main', 'live.jsonl'), isStreaming: false })
    fresh.respond('prompt', {})
    return channel
  }) as typeof launcher.launch
  const delivered = sessions.prompt('main', 'req-policy', 'hello', 'steer')
  await vi.waitFor(() => { expect(launcher.sessions[1]).toBeDefined() })
  const tag = key('req-policy')
  await vi.waitFor(() => { expect(launcher.sessions[1]!.commands.some(command => command.type === 'prompt')).toBe(true) })
  launcher.sessions[1]!.emit({ type: 'message_end',
    message: { role: 'user', content: [{ type: 'text', text: `[superagent:${tag}]\nhello` }] } })
  await delivered
  expect(launcher.launches).toHaveLength(2)
  expect(launcher.launches[1]!.args).toContain(join(dir, 'prompts', 'main.r0.md'))
})
