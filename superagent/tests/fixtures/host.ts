/**
 * Test host: a configured Runtime on a temp state dir with a FakeLauncher, scripted gh/lark-cli probe scripts,
 * and mocked Commands. Stop it with `stop()`.
 *
 * - Sources: GitHub (`acme/widgets`, agent `agent-bot`) and Feishu (bot `lark-bot`), allowed member Alice
 *   (`ou_alice`), listened chat `oc_team`, `auto` eval mode.
 * - Sessions: the launcher auto-answers `get_state` (`isStreaming: false`) and every `prompt` request, so
 *   deliveries never hang; tests script confirmations and turns with `session(id).emit(...)` / `.respond(...)`.
 * - `ompBin` points at a mock omp script answering `models --json` (providers `main-provider`,
 *   `worker-provider`) and `config get modelRoles --json`; override with `options.ompModels`.
 */
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi, type Mock } from 'vitest'
import { Runtime } from '../../src/app/runtime.ts'
import { createHandler } from '../../src/app/http.ts'
import { Store } from '../../src/app/store.ts'
import { SettingsSchema } from '../../src/policy.ts'
import { feishuTrigger } from '../../src/sources/feishu.ts'
import { Commands } from '../../src/infra/commands.ts'
import type { Ticket, Trigger } from '../../src/core/index.ts'
import { testMachine } from './deployment.ts'
import { FakeLauncher, fakeLauncher, type FakeSession } from './fake-omp.ts'

export const MEMBER = 'ou_alice'
export const CHAT = 'oc_team'

/** Build a Feishu mention trigger from Alice in `oc_team`, using the digits in `id` as the timestamp offset in seconds. */
export function feishu(id: string, text: string, overrides: Record<string, unknown> = {}): Trigger {
  const at = String(Date.parse('2026-09-09T00:00:00Z') + Number(id.replace(/\D/g, '') || 0) * 1000)
  return feishuTrigger({ message_id: `om_${id}`, chat_id: CHAT, chat_type: 'group', sender_id: MEMBER, sender_type: 'user', content: text, create_time: at,
    mentions: [{ id: 'ou_bot' }], ...overrides }, 'ou_bot', 'cli_bot')!
}

export type Delivery = { sessionId: string; mode: 'queue' | 'steer' | 'inject'; text: string }

const script = (path: string, body: string): string => { writeFileSync(path, `#!/bin/sh\n${body}\n`); chmodSync(path, 0o755); return path }

const OMP_MODELS = {
  models: [
    { provider: 'main-provider', kind: 'chat', id: 'main-model', name: 'Main Model', thinking: null, input: ['text'] },
    { provider: 'worker-provider', kind: 'chat', id: 'worker-model', name: 'Worker Model', thinking: ['low', 'high'], input: ['text', 'image'] },
  ],
}
const OMP_ROLES = { value: { default: 'worker-provider/worker-model' } }

export interface StartRuntimeOptions {
  /** Writes to the database before the Runtime opens it, such as records an earlier version stored. */
  seed?: (store: Store) => void
  /** Launcher double recording launches; defaults to a fresh FakeLauncher. */
  launcher?: FakeLauncher
  /** omp binary path handed to the Runtime; defaults to a mock script answering `models`/`config get`. */
  ompBin?: string
  /** `models --json` payload of the mock omp script. */
  ompModels?: unknown
}

export interface Host {
  readonly runtime: Runtime
  readonly directory: string
  readonly launcher: FakeLauncher
  /** A launched fake session by Superagent session id (such as `main` or `worker-<ticket>`). */
  readonly session: (id: string) => FakeSession
  readonly deliveries: Mock<(delivery: Delivery) => void>
  /** Parsed JSON payloads delivered to `sessionId` (steer/queue prompts plus decoded injects). */
  readonly relays: (sessionId: string) => Record<string, unknown>[]
  readonly candidates: () => unknown[]
  readonly runTool: (sessionId: string, name: string, args: unknown) => Promise<Record<string, unknown>>
  /** Route one decision with the main Session's orchestrator_route, answering its result; a refused one throws its reason. */
  readonly route: (item: Record<string, unknown>) => Promise<Record<string, unknown>>
  readonly acceptedTicket: (trigger: Trigger) => Promise<{ trigger: Trigger; ticket: Ticket; sessionId: string }>
  readonly api: (method: string, path: string, json?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>
  readonly logs: { level: 'info' | 'warn' | 'error'; message: string }[]
  readonly stop: () => Promise<void>
}

/** @param seed - shorthand for `{ seed }`; an options object selects the launcher, omp binary, or catalog. */
export function startRuntime(seed?: (store: Store) => void): Promise<Host>
export function startRuntime(options?: StartRuntimeOptions): Promise<Host>
export async function startRuntime(seedOrOptions?: ((store: Store) => void) | StartRuntimeOptions): Promise<Host> {
  const options: StartRuntimeOptions = typeof seedOrOptions === 'function' ? { seed: seedOrOptions } : seedOrOptions ?? {}
  const directory = mkdtempSync(join(tmpdir(), 'superagent-host-'))
  const AGENT = script(join(directory, 'agent-gh'), [
    'if [ "$1 $2" = "api user" ]; then echo \'{"login":"agent-bot","id":7}\'; exit 0; fi',
    'echo \'{"name":"acme/widgets","push":true}\'',
  ].join('\n'))
  const BOT = script(join(directory, 'lark-bot'), [
    'if [ "$1" = "auth" ]; then echo \'{"appId":"cli_bot","brand":"feishu","identities":{"bot":{"status":"ready"}}}\'; exit 0; fi',
    'if [ "$1" = "config" ]; then echo "strict-mode: bot (source: profile)"; exit 0; fi',
    'echo \'{"bot":{"open_id":"ou_bot","app_name":"Widgets Bot"},"code":0,"msg":"ok"}\'',
  ].join('\n'))
  const ompBin = options.ompBin ?? script(join(directory, 'mock-omp'), [
    `MODELS=${JSON.stringify(JSON.stringify(options.ompModels ?? OMP_MODELS)).replaceAll("'", "'\\''")}`,
    `ROLES='${JSON.stringify(OMP_ROLES)}'`,
    'if [ "$1" = "models" ]; then printf "%s" "$MODELS"; exit 0; fi',
    'printf "%s" "$ROLES"',
  ].join('\n'))
  const repository = { default_branch: 'master', permissions: { push: true } }
  vi.spyOn(Commands.prototype, 'gh').mockImplementation(async args => args[1] === 'user' ? { login: 'agent-bot' } : repository)
  vi.spyOn(Commands.prototype, 'lark').mockResolvedValue({ users: [{ member_id: MEMBER, name: 'Alice' }], has_more: false })
  vi.spyOn(Commands.prototype, 'git').mockResolvedValue('')
  const deliveries = vi.fn<(delivery: Delivery) => void>()
  const inner = options.launcher ?? fakeLauncher()
  const launcher = (async (spec: Parameters<FakeLauncher['launch']>[0], log: Parameters<FakeLauncher['launch']>[1]) => {
    const channel = await inner.launch(spec, log)
    const session = inner.sessions.at(-1)!
    const id = spec.env.OMP_SUPERAGENT_SESSION ?? 'unknown'
    session.respond('get_state', () => ({ sessionFile: join(directory, 'sessions', id, 'live.jsonl'), isStreaming: false }))
    session.respond('prompt', (command: Record<string, unknown>) =>
      String(command.message ?? '').startsWith('/superagent-inject ') ? { agentInvoked: false } : {})
    const request = channel.request.bind(channel)
    return { ...channel, request: (async <T>(command: { type: string; [key: string]: unknown }): Promise<T> => {
      const data = await request<T>(command)
      // Record only successful prompts, so a failing delivery stays invisible until its retry lands.
      if (command.type === 'prompt') {
        const message = String(command.message ?? '')
        if (message.startsWith('/superagent-inject ')) {
          const payload: unknown = JSON.parse(Buffer.from(message.slice('/superagent-inject '.length), 'base64url').toString('utf8'))
          if (typeof payload !== 'object' || payload === null || !('text' in payload) || typeof payload.text !== 'string') throw new Error('bad inject payload')
          deliveries({ sessionId: id, mode: 'inject', text: payload.text.replace(/^\[superagent:[^\]\s]+\]\n/, '') })
        } else {
          deliveries({ sessionId: id, mode: command.streamingBehavior === 'steer' ? 'steer' : 'queue',
            text: message.replace(/^\[superagent:[^\]\s]+\]\n/, '') })
          // Confirm the delivery as consumed, like a session taking the message: on a macrotask, because
          // `prompt()` registers its waiter only after this request resolves.
          setTimeout(() => session.emit({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: message }] } }), 0)
        }
      }
      return data
    }) }
  }) as unknown as FakeLauncher
  Object.defineProperties(launcher, { launches: { value: inner.launches }, sessions: { value: inner.sessions } })
  const logs: { level: 'info' | 'warn' | 'error'; message: string }[] = []
  const logger = { info: (message: string) => { logs.push({ level: 'info', message }) },
    warn: (message: string) => { logs.push({ level: 'warn', message }) }, error: (message: string) => { logs.push({ level: 'error', message }) } }
  const seeded = new Store(join(directory, 'superagent.sqlite'))
  const sources = { github: { enabled: true, config: { repository: 'acme/widgets', cli: AGENT } },
    feishu: { enabled: true, config: { cli: BOT, chats: [{ chatId: CHAT, listen: 'all' }], directMessages: true } } }
  const base = seeded.settings()
  seeded.saveSettings(SettingsSchema.parse({ ...base, sources, eval: { ...base.eval, mode: 'auto' },
    policy: { ...base.policy, sources: { feishu: { allowed: [{ id: MEMBER, name: 'Alice' }], syncChat: CHAT },
      github: { allowed: [{ id: 'alice' }] } } } }))
  options.seed?.(seeded)
  seeded.close()
  const runtime = new Runtime({ machine: testMachine({ stateDir: directory }), ompBin, launcher, logger, restart: vi.fn() })
  await runtime.ready
  deliveries.mockClear()

  /** A launched fake session by Superagent session id (such as `main` or `worker-<ticket>`). */
  const session = (id: string): FakeSession => {
    const found = inner.sessions.find(candidate => candidate.spec.env.OMP_SUPERAGENT_SESSION === id)
    if (!found) throw new Error(`Session ${id} has not launched`)
    return found
  }
  /** Parsed JSON payloads delivered to `sessionId` (steer/queue prompts plus decoded injects). */
  const relays = (sessionId: string) => deliveries.mock.calls.map(([call]) => call).filter(call => call.sessionId === sessionId)
    .map(call => JSON.parse(call.text) as Record<string, unknown>)
  const candidates = () => relays(runtime.masterId).filter(item => item.kind === 'candidate').map(item => item.trigger_id)
  const runTool = async (sessionId: string, name: string, args: unknown) => {
    await session(sessionId).callTool(name, args)
    const call = session(sessionId).toolCalls.at(-1)!
    const result = call.result as { content: { type: string; text?: string }[] }
    expectJSONSerializable(result)
    await runtime.idle()
    // An errored tool answers plain text, like the old fixture's rejection; surface it instead of JSON-parsing it.
    if (call.isError) throw new Error(result.content[0]?.text ?? `Tool ${name} failed`)
    return JSON.parse(result.content[0]!.text!) as Record<string, unknown>
  }
  /** Route one decision with the main Session's orchestrator_route, answering its result; a refused one throws its reason. */
  async function route(item: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { results } = await runTool(runtime.masterId, 'orchestrator_route', { decisions: [item] }) as { results: Record<string, unknown>[] }
    if (results[0]!.refused) throw new Error(String(results[0]!.refused))
    return results[0]!
  }
  async function acceptedTicket(trigger: Trigger) {
    runtime.receive(trigger)
    await runtime.idle()
    const result = await route({ kind: 'accept', trigger_id: trigger.id, title: `Fix ${trigger.id}`, worktree_name: 'fix-regression', acknowledgement: '收到，修复回归。' })
    await runtime.idle()
    const ticket = runtime.store.tickets.get((result.ticket as { ticket_id: string }).ticket_id)!
    return { trigger, ticket, sessionId: `worker-${ticket.id}` }
  }
  async function api(method: string, path: string, json?: unknown) {
    let status = 0, text = ''
    const chunks = json === undefined ? [] : [Buffer.from(JSON.stringify(json))]
    const req = { method, url: `/orchestrator/api/${path}`, headers: {}, async *[Symbol.asyncIterator]() { yield* chunks } }
    await createHandler(runtime.httpHost())(req as never, { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } } as never)
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  async function stop() { await runtime.stop(); vi.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }) }
  return { runtime, directory, launcher: inner, session, deliveries, relays, candidates, runTool, route, acceptedTicket, api, logs, stop }
}
/** Asserts a tool result round-trips through JSON (the RPC host-tool transport serializes it). */
const expectJSONSerializable = (value: unknown): void => { JSON.parse(JSON.stringify(value)) }
