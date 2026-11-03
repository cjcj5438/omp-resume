/**
 * Executor test host: an OmpExecutor wired to a real OmpSessions, Store, Engine, and Effects on a temp
 * state dir, with a FakeLauncher for scripted worker sessions. Stop it with `stop()`.
 *
 * The launcher auto-answers `get_state` (`isStreaming: false`) and every `prompt` request, so launches
 * never hang; tests script confirmations and turns with `session(id).emit(...)` / `.respond(...)`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, type Assessor, type Policy, type Ticket, type Trigger } from '../../src/core/index.ts'
import { Effects } from '../../src/app/effects.ts'
import { Prompts } from '../../src/app/prompts.ts'
import { Store } from '../../src/app/store.ts'
import { OmpExecutor, type OmpExecutorHost } from '../../src/executor/omp.ts'
import { workerSessionId } from '../../src/executor/work.ts'
import { HealthBoard } from '../../src/infra/health.ts'
import { KV } from '../../src/kv.ts'
import { OmpSessions, type OmpSessionsHost } from '../../src/omp/sessions.ts'
import { SettingsSchema } from '../../src/policy.ts'
import { FakeLauncher, fakeLauncher, type FakeSession } from './fake-omp.ts'

export interface ExecutorHost {
  readonly directory: string
  readonly store: Store
  readonly effects: Effects
  readonly sessions: OmpSessions
  readonly executor: OmpExecutor
  readonly engine: Engine
  readonly launcher: FakeLauncher
  /** A launched fake session by Superagent session id (such as `worker-<ticket>`). */
  readonly session: (id: string) => FakeSession
  readonly stop: () => Promise<void>
}

const logger = { info: () => {}, warn: () => {}, error: () => {} }

const policy: Policy = {
  version: 'v1', paused: false, evalTimeoutMs: 60_000,
  gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }),
  revalidate: () => true,
  admitsInferred: () => false,
}
const assessor: Assessor = { request: () => {} }

/** Starts an executor host on a fresh temp dir; `effects.start()` is called so launch/delivery rows run. */
export function startExecutorHost(): ExecutorHost {
  const directory = mkdtempSync(join(tmpdir(), 'superagent-executor-'))
  const store = new Store(join(directory, 'superagent.sqlite'))
  store.saveSettings(SettingsSchema.parse({}))
  store.set(KV.runtime.masterId, 'main')
  const board = new HealthBoard()
  const effects = new Effects(store, board)
  const prompts = new Prompts(store, () => 100_000, () => undefined, () => false)
  const inner = fakeLauncher()
  const controller = new AbortController()
  // Auto-answer `get_state` and every `prompt` at launch time (responders must exist before the first
  // request, which `ensure` issues synchronously after `launcher()` resolves), and confirm each delivery
  // as consumed on a macrotask, mirroring a session taking the message.
  const launcher = (async (spec: Parameters<FakeLauncher['launch']>[0], log: Parameters<FakeLauncher['launch']>[1]) => {
    const channel = await inner.launch(spec, log)
    const launched = inner.sessions.at(-1)!
    const id = spec.env.OMP_SUPERAGENT_SESSION ?? 'unknown'
    launched.respond('get_state', () => ({ sessionFile: join(directory, 'sessions', id, 'live.jsonl'), isStreaming: false }))
    launched.respond('prompt', (command: Record<string, unknown>) =>
      String(command.message ?? '').startsWith('/superagent-inject ') ? { agentInvoked: false } : {})
    const request = channel.request.bind(channel)
    return { ...channel, request: (async <T>(command: { type: string; [key: string]: unknown }): Promise<T> => {
      const data = await request<T>(command)
      if (command.type === 'prompt' && !String(command.message ?? '').startsWith('/superagent-inject ')) {
        const message = String(command.message ?? '')
        setTimeout(() => launched.emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: message }] } }), 0)
      }
      return data
    }) }
  }) as unknown as FakeLauncher
  Object.defineProperties(launcher, { launches: { value: inner.launches }, sessions: { value: inner.sessions } })
  // The sessions, executor, and engine reference each other; both resolve lazily like runtime.ts does.
  let engine!: Engine
  let sessions!: OmpSessions
  const sessionsHost: OmpSessionsHost = {
    store, prompts, effects, health: board.claim('models'), machine: { stateDir: directory }, masterId: 'main',
    lifetime: controller.signal, ompBin: '/mock/omp', launcher, logger,
    closing: () => false,
    workerEnv: () => ({}),
    environment: () => [],
    toolHosts: () => ({
      main: { masterId: 'main', resources: { masterId: 'main' } } as never,
      // The worker tools run against the real engine so tests can report through the worker session.
      executor: { get engine() { return engine }, store, sessions, resources: { masterId: 'main' },
        github: { deployment: { github: { login: 'agent' } } }, sendReplies: async () => {} } as never,
    }),
  }
  sessions = new OmpSessions(sessionsHost)
  const executorHost: OmpExecutorHost = {
    get engine() { return engine }, store, effects, health: board.claim('worker'), machine: { stateDir: directory },
    lifetime: controller.signal, sessions, closing: () => false, paused: () => false,
    environment: ticket => [{ key: 'OMP_SUPERAGENT_TICKET', value: ticket.id, description: { zh: '', en: '' }, owner: 'test' }],
    sourceLink: async () => ({}), repliedTo: () => undefined,
    setup: { workerEnv: () => ({ PATH: [join(directory, 'worker-bin'), process.env.PATH ?? ''].join(':'),
      GIT_CONFIG_GLOBAL: join(directory, 'worker-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }) },
  }
  const executor = new OmpExecutor(executorHost)
  engine = new Engine({ repo: store, policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) },
    assessor, executor, outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  executor.install()
  effects.start()
  const session = (id: string): FakeSession => {
    const found = launcher.sessions.find(candidate => candidate.spec.env.OMP_SUPERAGENT_SESSION === id)
    if (!found) throw new Error(`No launched session ${id}`)
    return found
  }
  return {
    directory, store, effects, sessions, executor, engine, launcher, session,
    stop: async () => { executor.dispose(); await effects.drain(); store.close(); rmSync(directory, { recursive: true, force: true }) },
  }
}

/** Saves a ticket with one pending assignment and a workspace directory path, ready for `executor.start`. */
export function pendingTicket(host: ExecutorHost, id = 't1'): Ticket {
  const ticket = {
    id, title: 'Fix it', decisionId: 'd1', mandate: { strength: 'explicit', basis: { via: 'explicit' } },
    channels: [], assignments: [{ id: `a-${id}`, state: 'pending', createdAt: new Date().toISOString() }],
    inputs: [], undelivered: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    origin: { triggerId: 'tr1', triggerIds: ['tr1'] },
    execution: { name: `fix-${id}`, directory: join(host.directory, 'work', `fix-${id}`), assignment: 'do it' },
  } as unknown as Ticket
  host.store.tickets.save(ticket)
  return host.store.tickets.get(id)!
}

/** Saves a trigger input on `ticket`, returning the input id. */
export function triggerInput(host: ExecutorHost, ticket: Ticket, trigger: Trigger): string {
  const current = host.store.tickets.get(ticket.id)!
  const id = `input-${trigger.id}`
  current.inputs.push({ id, kind: 'trigger', triggerId: trigger.id, at: new Date().toISOString(), human: true })
  host.store.triggers.save(trigger)
  host.store.tickets.save(current)
  return id
}

export { workerSessionId }
