/**
 * OmpSessions: one `omp --mode rpc` child process per session, idempotent delivery, notice injection, host tools.
 *
 * Public API for step 5 (OmpExecutor) — signatures only:
 * ```
 * type SessionState = 'absent' | 'starting' | 'running' | 'settling' | 'idle'
 * type SessionEvent =
 *   | { type: 'started'; sessionId: string }
 *   | { type: 'yielded'; sessionId: string }
 *   | { type: 'failed'; sessionId: string; message: string; retryable: boolean; httpStatus?: number; code?: string }
 *   | { type: 'settled'; sessionId: string }
 *   | { type: 'userMessage'; sessionId: string; key: string }
 *   | { type: 'exited'; sessionId: string; expected: boolean }
 * class OmpSessions {
 *   constructor(host: OmpSessionsHost)
 *   onSessionEvent(listener: (event: SessionEvent) => void): () => void
 *   state(id: string): SessionState
 *   holds(id: string, requestId: string): Promise<boolean> | boolean  // sync: scanSeen-cached
 *   prompt(id: string, requestId: string, text: string, mode: 'steer' | 'queue' | { inject: string },
 *     authorize?: () => void, accepted?: () => void): Promise<void>
 *   ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<void>
 *   relay(requestId: string, text: string): void
 *   notify(name: string, value: Record<string, unknown>, summary: string): void
 *   delivery(name: string): Promise<'injected' | 'pending'>
 *   promptVersion(sessionId: string): PromptVersion
 *   mayRead(sessionId: string, revision: number): boolean
 *   promptedId(requestId: string): string
 *   status(): { revision: number; sessions: { sessionId: string; revision: number }[]; notificationPending: boolean }
 *   modelRetry(sessionId: string | undefined): {} | { model_retry: { since: string; attempts: number } }
 *   close(id: string, options?: { abort?: boolean }): Promise<void>
 *   closeAll(graceMs?: number): Promise<void>
 *   lastAssistantText(id: string): Promise<string>
 *   list(): { id: string; role: 'orchestrator' | 'worker'; ticketId: string | null; title: string;
 *     sessionFile: string | null; state: SessionState }[]
 * }
 * ```
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { key, liveTicket, type Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Machine } from '../deployment.ts'
import { mandateInstructions, ticketOfSession } from '../executor/work.ts'
import type { Variable } from '../app/execution-environment.ts'
import type { Effects } from '../app/effects.ts'
import { Later } from '../app/effects.ts'
import type { HealthEntry } from '../infra/health.ts'
import { packagePath } from '../infra/paths.ts'
import { bundledSkills } from '../app/skill-files.ts'
import { SKILL_PREFIX, type PromptVersion, type Prompts } from '../app/prompts.ts'
import type { Store } from '../app/store.ts'
import type { ExecutorToolsHost } from '../app/tools/executor.ts'
import { executorTools } from '../app/tools/executor.ts'
import type { MainToolsHost } from '../app/tools/main.ts'
import { mainTools } from '../app/tools/main.ts'
import type { Tool } from '../app/tools/tool.ts'
import type { ImageAttachment } from '../sources/kind.ts'
import { RpcExited, type LaunchSpec, type Launcher, type RpcChannel, type RpcFrame } from './rpc.ts'

export type SessionState = 'absent' | 'starting' | 'running' | 'settling' | 'idle'
export type SessionEvent =
  | { type: 'started'; sessionId: string }
  | { type: 'yielded'; sessionId: string }
  | { type: 'failed'; sessionId: string; message: string; retryable: boolean; httpStatus?: number; code?: string }
  | { type: 'settled'; sessionId: string }
  | { type: 'userMessage'; sessionId: string; key: string }
  | { type: 'exited'; sessionId: string; expected: boolean }

export interface SessionListItem {
  id: string; role: 'orchestrator' | 'worker'; ticketId: string | null; title: string; sessionFile: string | null; state: SessionState
}
export interface OmpSessionsHost {
  readonly store: Pick<Store, 'tickets' | 'settings' | 'get' | 'set' | 'keys'>
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'compose' | 'skills'>
  readonly effects: Pick<Effects, 'enqueue' | 'handle' | 'idle' | 'pending'>
  /** The `models` health entry, which reports sessions stuck in a model-request retry. */
  readonly health: HealthEntry
  readonly machine: Pick<Machine, 'stateDir'>
  readonly masterId: string
  readonly lifetime: AbortSignal
  readonly ompBin: string
  readonly launcher: Launcher
  readonly logger: { info(message: string): void; warn(message: string): void; error(message: string): void }
  closing(): boolean
  /** Isolated git variables plus the shim `PATH` for worker children; the main session never receives these. */
  workerEnv(): Record<string, string | undefined>
  /** Execution environment variables for `ticket`, rendered into its worker's system prompt and process env. */
  environment(ticket: Ticket): Variable[]
  /** Hosts for the main session's and worker sessions' tool definitions. */
  toolHosts(): { main: MainToolsHost; executor: ExecutorToolsHost }
}

interface Live {
  channel: RpcChannel
  role: 'orchestrator' | 'worker'
  revision: number
  /** Exact `--append-system-prompt` file content the child launched with; staleness compares against a fresh compose. */
  promptBody: string
  state: SessionState
  title: string
  seen: Set<string>
  inFlight: Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>
  pendingInjects: { key: string; summary: string; text: string }[]
  expectedClose: boolean
  stopEvents: () => void
}

const MAIN_TOOLS = ['read', 'bash']
const WORKER_TOOLS = ['read', 'bash', 'edit', 'write', 'grep', 'glob', 'lsp', 'task', 'todo', 'web_search']
const DELIVERY_WAIT_MS = 15 * 60_000
const TAG = /^\[superagent:([^\]\s]+)\]/

const isImageAttachment = (value: unknown): value is ImageAttachment => {
  if (typeof value !== 'object' || value === null || !('data' in value) || !('mimeType' in value)) return false
  return typeof value.data === 'string' && typeof value.mimeType === 'string'
}

const textOf = (content: unknown): string => Array.isArray(content)
  ? content.filter((block): block is { type: string; text: string } => typeof block === 'object' && block !== null
    && (block as { type?: unknown }).type === 'text').map(block => block.text).join('')
  : typeof content === 'string' ? content : ''

/** Delivery keys already recorded in a session JSONL file: user message tags plus injected custom-message tags. */
export function scanSeen(file: string): Set<string> {
  const seen = new Set<string>()
  let text: string
  try { text = readFileSync(file, 'utf8') } catch { return seen }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let entry: { type?: unknown; message?: { role?: unknown; content?: unknown }; content?: unknown }
    try { entry = JSON.parse(line) as typeof entry } catch { continue }
    const body = entry.type === 'message' && (entry.message as { role?: unknown } | undefined)?.role === 'user'
      ? textOf((entry.message as { content?: unknown }).content)
      : entry.type === 'custom_message' ? textOf(entry.content) : undefined
    const match = body === undefined ? null : TAG.exec(body)
    if (match?.[1]) seen.add(match[1])
  }
  return seen
}

/** Launches and supervises one omp RPC child per session; delivers deduplicated messages and injections to them. */
export class OmpSessions {
  private readonly live = new Map<string, Live>()
  private readonly launching = new Map<string, Promise<Live>>()
  private readonly titles = new Map<string, string>()
  private readonly listeners = new Set<(event: SessionEvent) => void>()
  private readonly retries = new Map<string, { since: string; attempts: number }>()
  private readonly seenCache = new Map<string, Set<string>>()
  constructor(private readonly host: OmpSessionsHost) {
    host.effects.handle('relay', ({ text }, requestId) => this.prompt(host.masterId, requestId, text, 'steer'), { ordered: true })
    host.effects.handle('notice', ({ value, summary }, name) =>
      this.prompt(host.masterId, `notice:${name}:${key(JSON.stringify(value))}`, JSON.stringify(value), { inject: summary }), { ordered: true })
  }
  onSessionEvent(listener: (event: SessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) listener(event)
  }
  state(id: string): SessionState {
    return this.live.get(id)?.state ?? 'absent'
  }
  /** Whether session `id` already holds the message delivered under `requestId`. */
  holds(id: string, requestId: string): boolean {
    const wanted = key(requestId)
    const session = this.live.get(id)
    if (session) return session.seen.has(wanted) || session.inFlight.has(wanted)
    let seen = this.seenCache.get(id)
    if (!seen) {
      const file = this.host.store.get(KV.sessions.file(id))
      seen = file ? scanSeen(file) : new Set()
      this.seenCache.set(id, seen)
    }
    return seen.has(wanted)
  }
  /** The delivery key `prompt` tags the message delivered under `requestId` with. */
  promptedId(requestId: string): string { return key(requestId) }
  /** Ensures session `id` runs; records `title` for `list()`. */
  async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<void> {
    this.titles.set(id, title)
    if (!this.live.has(id)) await this.launch(id, cwd, role)
  }
  /** Enqueues a steering relay to the main session. */
  relay(requestId: string, text: string): void { this.host.effects.enqueue('relay', requestId, { text }) }
  /** Enqueues a durable background notice for injection into the main session. */
  notify(name: string, value: Record<string, unknown>, summary: string): void { this.host.effects.enqueue('notice', name, { value, summary }) }
  /** Waits for runnable `notice` effects to settle; `'injected'` when notice `name` reached the main session. */
  async delivery(name: string): Promise<'injected' | 'pending'> {
    await this.host.effects.idle('notice')
    return this.host.effects.pending('notice', name) ? 'pending' : 'injected'
  }
  /** The prompt version a session runs under (its latest recorded revision, else the current version). */
  promptVersion(sessionId: string): PromptVersion {
    const revision = this.host.store.get(KV.sessions.prompts(sessionId))?.at(-1)
    return revision === undefined ? this.host.prompts.current() : this.host.prompts.version(revision)
  }
  /** Whether a session may read `revision` (its active revision or any revision it ran under). */
  mayRead(sessionId: string, revision: number): boolean {
    return revision === this.promptVersion(sessionId).revision || (this.host.store.get(KV.sessions.prompts(sessionId)) ?? []).includes(revision)
  }
  /** Current prompt revision, live sessions with their launch revisions, and whether a `'prompts'` notice is pending. */
  status(): { revision: number; sessions: { sessionId: string; revision: number }[]; notificationPending: boolean } {
    return { revision: this.host.prompts.current().revision,
      sessions: [...this.live].map(([sessionId, session]) => ({ sessionId, revision: session.revision })),
      notificationPending: this.host.effects.pending('notice', 'prompts') }
  }
  /** Active model-retry wait of `sessionId` for status listings, or `{}` when none. */
  modelRetry(sessionId: string | undefined): {} | { model_retry: { since: string; attempts: number } } {
    const retry = sessionId ? this.retries.get(sessionId) : undefined
    return retry ? { model_retry: { ...retry } } : {}
  }
  /** Main session first, then workers with a recorded file or live process, newest tickets first. */
  list(): SessionListItem[] {
    const { store, masterId } = this.host
    const files = new Set(store.keys(KV.sessions.file).map(name => name.slice(KV.sessions.file.prefix.length)))
    const ids = new Set<string>([masterId, ...files, ...this.live.keys()])
    const items: SessionListItem[] = []
    for (const id of ids) {
      const ticketId = id === masterId ? null : ticketOfSession(id) ?? null
      const ticket = ticketId ? store.tickets.get(ticketId) : undefined
      if (ticketId && !ticket) continue
      items.push({ id, role: ticketId ? 'worker' : 'orchestrator', ticketId, title: this.titles.get(id) ?? (ticket?.title ?? id),
        sessionFile: store.get(KV.sessions.file(id)) ?? null, state: this.state(id), createdAt: ticket?.createdAt ?? '' } as SessionListItem & { createdAt: string })
    }
    const createdAt = new Map(items.map(item => [item.id, (item as unknown as { createdAt: string }).createdAt]))
    return items.map(({ ...item }) => {
      delete (item as unknown as { createdAt?: string }).createdAt
      return item
    }).sort((a, b) => a.id === masterId ? -1 : b.id === masterId ? 1 : (createdAt.get(b.id) ?? '').localeCompare(createdAt.get(a.id) ?? ''))
  }
  /** Latest assistant text of a live session. */
  async lastAssistantText(id: string): Promise<string> {
    const session = this.live.get(id) ?? await this.launching.get(id)
    if (!session) throw new Error(`Session ${id} is not running`)
    const data = await session.channel.request<{ text?: unknown }>({ type: 'get_last_assistant_text' })
    return typeof data.text === 'string' ? data.text : ''
  }
  /** Stops session `id` (`abort` interrupts a running turn first); no-op when absent. */
  async close(id: string, options?: { abort?: boolean }): Promise<void> {
    const session = this.live.get(id) ?? await this.launching.get(id)?.catch(() => undefined)
    if (!session || !this.live.has(id)) return
    session.expectedClose = true
    if (options?.abort && session.state === 'running') {
      await session.channel.request({ type: 'abort' }).catch(() => {})
    }
    await session.channel.close(10_000)
  }
  /** Stops all live sessions in parallel, aborting running turns. */
  async closeAll(graceMs?: number): Promise<void> {
    await Promise.all([...this.live.keys()].map(async id => {
      const session = this.live.get(id)
      if (!session) return
      session.expectedClose = true
      if (session.state === 'running') await session.channel.request({ type: 'abort' }).catch(() => {})
      await session.channel.close(graceMs ?? 10_000)
    }))
  }
  private get stateDir(): string { return this.host.machine.stateDir }
  /** Plugin directory for prompt revision `rev`, generated once from the packaged template plus revision skills. */
  private ensurePlugin(rev: number): string {
    const root = join(this.stateDir, 'plugin'), target = join(root, `r${rev}`)
    if (existsSync(target)) return target
    mkdirSync(root, { recursive: true })
    const tmp = join(root, `.r${rev}.${process.pid}.tmp`)
    rmSync(tmp, { recursive: true, force: true })
    mkdirSync(tmp, { recursive: true })
    const version = this.host.prompts.version(rev)
    writeFileSync(join(tmp, 'package.json'), readFileSync(packagePath('plugin', 'package.json'), 'utf8'))
    writeFileSync(join(tmp, 'extension.ts'), readFileSync(packagePath('plugin', 'extension.ts'), 'utf8'))
    for (const [name, content] of this.host.prompts.skills(version.config)) {
      const bundled = name === 'feishu' || name === 'github' ? bundledSkills[name] : undefined
      const body = version.config.skills[name] ?? ''
      const description = bundled?.description ?? (body.replace(/\s+/g, ' ').slice(0, 120) || 'Custom Superagent operational skill.')
      const dir = join(tmp, 'skills', `${SKILL_PREFIX}${name}`)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${SKILL_PREFIX}${name}\ndescription: ${description}\n---\n\n${content}`)
    }
    renameSync(tmp, target)
    return target
  }
  /** The `--append-system-prompt` content for session `id` as composed right now, without writing anything. */
  private composeBody(id: string, role: 'orchestrator' | 'worker', ticket?: Ticket): { revision: number; body: string } {
    const version = this.host.prompts.current()
    const composed = this.host.prompts.compose(version.config, role, ticket ? this.host.environment(ticket) : undefined)
    return { revision: version.revision,
      body: `[Superagent prompt revision ${version.revision}]\n${composed}\n${ticket ? mandateInstructions(ticket.mandate) : ''}` }
  }
  /** Writes the `--append-system-prompt` file for session `id` and records its revision. */
  private writePromptFile(id: string, role: 'orchestrator' | 'worker', ticket?: Ticket): { file: string; body: string } {
    const { revision, body } = this.composeBody(id, role, ticket)
    const dir = join(this.stateDir, 'prompts')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${id}.r${revision}.md`)
    writeFileSync(file, body)
    const revisions = this.host.store.get(KV.sessions.prompts(id)) ?? []
    if (revisions.at(-1) !== revision) {
      this.host.store.set(KV.sessions.prompts(id), [...revisions.filter(item => item !== revision), revision])
    }
    return { file, body }
  }
  /** Whether live `session`'s frozen prompt differs from a fresh compose (policy, env, or revision change). Never throws. */
  private isStale(id: string, session: Live): boolean {
    try {
      const { masterId, store } = this.host
      const ticketId = id === masterId ? undefined : ticketOfSession(id)
      const ticket = ticketId ? store.tickets.get(ticketId) : undefined
      if (ticketId && !ticket) return false
      return this.composeBody(id, session.role, ticket).body !== session.promptBody
    } catch { return false }
  }
  /** Launches (single-flight per id) and decorates the omp child for session `id`. */
  private launch(id: string, cwd?: string, role?: 'orchestrator' | 'worker'): Promise<Live> {
    const running = this.launching.get(id)
    if (running) return running
    const started = this.start(id, cwd, role).finally(() => { this.launching.delete(id) })
    this.launching.set(id, started)
    return started
  }
  private async start(id: string, cwd?: string, role?: 'orchestrator' | 'worker', attempt = 0): Promise<Live> {
    if (this.host.closing()) throw new Later('Superagent is stopping')
    const { store, masterId } = this.host
    const ticketId = id === masterId ? undefined : ticketOfSession(id)
    const ticket = ticketId ? store.tickets.get(ticketId) : undefined
    const resolved = id === masterId ? 'orchestrator' : ticket ? 'worker' : undefined
    if (!resolved || (role && role !== resolved)) throw new Error(`Unknown session ${id}`)
    const settings = store.settings()
    let model = store.get(KV.sessions.model(id))
    if (model === undefined) {
      model = resolved === 'orchestrator' ? settings.eval.model : settings.executor.model
      store.set(KV.sessions.model(id), model)
    }
    const revision = this.host.prompts.current().revision
    const plugin = this.ensurePlugin(revision)
    const { file: promptFile, body: promptBody } = this.writePromptFile(id, resolved, ticket)
    const sessionDir = join(this.stateDir, 'sessions', id)
    mkdirSync(sessionDir, { recursive: true })
    const continued = existsSync(sessionDir) && readdirSync(sessionDir).some(name => name.endsWith('.jsonl'))
    const overlay = join(this.stateDir, 'omp-overlay.yml')
    const args = [this.host.ompBin, '--mode', 'rpc', '--no-ui', '--no-title', '--no-extensions',
      '-e', plugin, '--config', overlay, '--session-dir', sessionDir,
      '--cwd', cwd ?? (resolved === 'worker' && ticket?.execution ? ticket.execution.directory : this.stateDir),
      '--approval-mode', 'yolo', '--tools', (resolved === 'orchestrator' ? MAIN_TOOLS : WORKER_TOOLS).join(','),
      '--append-system-prompt', promptFile,
      ...(model ? ['--model', `${model.provider}/${model.model}`,
        ...(model.reasoningEffort ? ['--thinking', model.reasoningEffort] : [])] : []),
      ...(continued ? ['--continue'] : [])]
    // Workers run under the agent account: the shim `PATH` and isolated git variables plus the ticket's execution
    // variables. The main session keeps the operator environment, per plan §0.4 (the prototype's process-wide
    // mutation was an in-process side effect, not a main-session requirement).
    const env: Record<string, string | undefined> = { ...process.env, OMP_SUPERAGENT_ROLE: resolved === 'orchestrator' ? 'main' : 'worker',
      OMP_SUPERAGENT_SESSION: id,
      ...(resolved === 'worker' && ticket ? { ...this.host.workerEnv(),
        ...Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value])) } : {}),
      BUN_BE_BUN: undefined }
    const spec: LaunchSpec = { bin: args[0]!, args: args.slice(1),
      cwd: cwd ?? (resolved === 'worker' && ticket?.execution ? ticket.execution.directory : this.stateDir), env }
    const channel = await this.host.launcher(spec, line => this.host.logger.info(line))
    const session: Live = { channel, role: resolved, revision, promptBody, state: 'starting', title: this.titles.get(id) ?? id,
      seen: new Set(), inFlight: new Map(), pendingInjects: [], expectedClose: false, stopEvents: () => {} }
    session.stopEvents = channel.onEvent(frame => this.onFrame(id, session, frame))
    this.live.set(id, session)
    void channel.exited.then(() => { void this.unlive(id, session, session.expectedClose) })
    this.seenCache.delete(id)
    const tools = resolved === 'orchestrator'
      ? mainTools(this.host.toolHosts().main)
      : executorTools(this.host.toolHosts().executor, ticket!)
    try {
      const names = await channel.setHostTools(tools.map(item => ({ name: item.name, label: item.name, description: item.description,
        parameters: z.toJSONSchema(item.schema), loadMode: 'essential' as const })), (call, signal) => this.runTool(tools, call, signal))
      this.host.logger.info(`superagent: ${id} host tools ${names.join(',')}`)
      const state = await channel.request<{ sessionFile?: unknown; isStreaming?: unknown }>({ type: 'get_state' })
      if (typeof state.sessionFile === 'string') {
        store.set(KV.sessions.file(id), state.sessionFile)
        session.seen = scanSeen(state.sessionFile)
      }
      for (const note of [...store.get(KV.sessions.notes(id)) ?? []]) {
        try {
          await this.inject(id, session, note.key, note.summary, note.text)
          store.set(KV.sessions.notes(id), (store.get(KV.sessions.notes(id)) ?? []).filter(item => item.key !== note.key))
        } catch { break }
      }
      session.state = state.isStreaming === true ? 'running' : 'idle'
    } catch (error) {
      // Tear down the half-launched child so a failed launch leaks neither the process nor the `live` entry.
      if (this.live.get(id) === session) this.live.delete(id)
      session.stopEvents()
      session.expectedClose = true
      await channel.close(10_000).catch(() => {})
      throw error
    }
    // A save that landed mid-launch left this child stale already; relaunch once instead of serving one stale turn.
    if (attempt === 0 && !session.expectedClose && this.live.get(id) === session && this.isStale(id, session)) {
      await this.close(id).catch(() => {})
      return this.start(id, cwd, role, 1)
    }
    return session
  }
  private async runTool(tools: Tool[], call: { toolName: string; arguments: unknown; toolCallId: string }, signal: AbortSignal) {
    const tool = tools.find(item => item.name === call.toolName)
    if (!tool) return { content: [{ type: 'text' as const, text: `Unknown tool ${call.toolName}` }], isError: true }
    const parsed = tool.schema.safeParse(call.arguments)
    if (!parsed.success) {
      return { content: [{ type: 'text' as const, text: parsed.error.issues[0]?.message ?? 'Invalid arguments' }], isError: true }
    }
    const value: unknown = await tool.execute(parsed.data, signal)
    const image = typeof value === 'object' && value !== null && 'image' in value && isImageAttachment(value.image)
      ? value.image : undefined
    const rest = typeof value === 'object' && value !== null ? (({ image: _dropped, ...kept }) => kept)(value as Record<string, unknown>) : value
    return { content: [{ type: 'text' as const, text: JSON.stringify(rest) },
      ...(image ? [{ type: 'image' as const, data: image.data, mimeType: image.mimeType }] : [])] }
  }
  /**
   * Delivers `text` once per `requestId`: steered into the live turn, queued behind it, or injected without
   * waking the session. Queues the injection in `KV.sessions.notes` when the session is not running.
   */
  async prompt(id: string, requestId: string, text: string, mode: 'steer' | 'queue' | { inject: string }, authorize?: () => void,
    accepted?: () => void): Promise<void> {
    const wanted = key(requestId)
    if (this.holds(id, requestId)) { accepted?.(); return }
    if (typeof mode === 'object' && !this.live.has(id)) {
      const message = `[superagent:${wanted}]\n${text}`
      const notes = this.host.store.get(KV.sessions.notes(id)) ?? []
      if (!notes.some(note => note.key === wanted)) {
        this.host.store.set(KV.sessions.notes(id), [...notes, { key: wanted, summary: mode.inject, text: message }])
      }
      accepted?.()
      return
    }
    // An idle session whose frozen prompt no longer matches a fresh compose (policy, env, or revision change)
    // relaunches before taking the delivery, so the delivery always lands on the current prompt. A running session
    // keeps its turn; its next settle relaunches it instead.
    const live = this.live.get(id)
    if (live && live.state === 'idle' && this.isStale(id, live)) await this.close(id)
    const session = this.live.get(id) ?? await this.launch(id)
    authorize?.()
    const message = `[superagent:${wanted}]\n${text}`
    if (typeof mode === 'object') {
      if (session.state === 'running' || session.state === 'starting') {
        session.pendingInjects.push({ key: wanted, summary: mode.inject, text: message })
        accepted?.()
        return
      }
      await this.inject(id, session, wanted, mode.inject, message)
      session.seen.add(wanted)
      accepted?.()
      return
    }
    // A request whose session dies mid-flight must reject: the real channel rejects pending requests on exit,
    // and the race extends that to responses held past the exit (a test double's deferred responder).
    await Promise.race([session.channel.request({ type: 'prompt', message, streamingBehavior: mode === 'steer' ? 'steer' : 'followUp' }),
      session.channel.exited.then(() => { throw new RpcExited(`Session ${id} exited`) })])
    session.inFlight.set(wanted, { resolve: () => {}, reject: () => {}, timer: setTimeout(() => {}, 0) })
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const timer = setTimeout(() => {
      session.inFlight.delete(wanted)
      this.host.logger.warn(`superagent: ${id} delivery ${wanted} not confirmed within 15 minutes; treating as delivered`)
      resolve()
    }, DELIVERY_WAIT_MS)
    timer.unref?.()
    session.inFlight.set(wanted, { resolve, reject, timer })
    accepted?.()
    await promise
  }
  private async inject(id: string, session: Live, deliveryKey: string, summary: string, text: string): Promise<void> {
    const payload = Buffer.from(JSON.stringify({ summary, text }), 'utf8').toString('base64url')
    const data = await Promise.race([session.channel.request<{ agentInvoked?: unknown } | undefined>({ type: 'prompt',
      message: `/superagent-inject ${payload}` }),
      session.channel.exited.then((): undefined => { throw new RpcExited('Session exited during inject') })])
    if (data?.agentInvoked === true) this.host.logger.warn(`superagent: inject woke ${id} (agentInvoked: true)`)
    session.seen.add(deliveryKey)
  }
  private onFrame(id: string, session: Live, frame: RpcFrame): void {
    switch (frame.type) {
      case 'agent_start': {
        session.state = 'running'
        this.emit({ type: 'started', sessionId: id })
        return
      }
      case 'agent_end': {
        this.retries.delete(id)
        this.updateModelHealth()
        const yielded = frame.yielded === true || (frame.yielded === undefined && frame.isTerminal !== false)
        if (!yielded) return
        session.state = 'settling'
        this.emit({ type: 'yielded', sessionId: id })
        void this.flushInjects(id, session).catch(() => {})
        return
      }
      case 'prompt_result': {
        if (frame.status === 'error') {
          const error = (frame.error ?? {}) as { message?: unknown; retryable?: unknown; httpStatus?: unknown; code?: unknown }
          this.emit({ type: 'failed', sessionId: id, message: typeof error.message === 'string' ? error.message : 'Model request failed',
            retryable: error.retryable === true,
            ...(typeof error.httpStatus === 'number' ? { httpStatus: error.httpStatus } : {}),
            ...(typeof error.code === 'string' ? { code: error.code } : {}) })
        }
        if (frame.sessionSettled === true) this.settle(id, session)
        return
      }
      case 'session_settled': {
        this.settle(id, session)
        return
      }
      case 'message_end': {
        const message = frame.message as { role?: unknown; content?: unknown } | undefined
        if (message?.role !== 'user') return
        const match = TAG.exec(textOf(message.content))
        if (!match?.[1]) return
        session.seen.add(match[1])
        const waiting = session.inFlight.get(match[1])
        if (waiting) {
          session.inFlight.delete(match[1])
          clearTimeout(waiting.timer)
          waiting.resolve()
        }
        this.emit({ type: 'userMessage', sessionId: id, key: match[1] })
        return
      }
      case 'auto_retry_start': {
        // Wire shape: `{ attempt, maxAttempts, delayMs, errorMessage, errorId? }` (attempt is 1-based).
        // `since` stamps the first start of a streak; later starts of the same streak keep it.
        const attempts = typeof frame.attempt === 'number' ? frame.attempt : (this.retries.get(id)?.attempts ?? 0) + 1
        this.retries.set(id, { since: this.retries.get(id)?.since ?? new Date().toISOString(), attempts })
        this.updateModelHealth()
        return
      }
      case 'auto_retry_end': {
        this.retries.delete(id)
        this.updateModelHealth()
        return
      }
      default:
        return
    }
  }
  private settle(id: string, session: Live): void {
    const wasIdle = session.state === 'idle'
    session.state = 'idle'
    if (!wasIdle) this.emit({ type: 'settled', sessionId: id })
    // A turn that ended on a stale prompt relaunches its session: the revision line is part of the compared body,
    // so prompt-config saves are covered too. Workers are excluded: the executor reads the worker's last words
    // right after `settled`, and closing here would race that read; their next delivery relaunches them instead.
    if (id === this.host.masterId && this.isStale(id, session)) {
      void this.close(id).catch(() => {})
    }
  }
  private async flushInjects(id: string, session: Live): Promise<void> {
    while (session.pendingInjects.length) {
      const next = session.pendingInjects.shift()!
      await this.inject(id, session, next.key, next.summary, next.text)
    }
  }
  private updateModelHealth(): void {
    const now = Date.now()
    const stale = [...this.retries].find(([, retry]) => now - Date.parse(retry.since) > 60_000)
    this.host.health.set(stale
      ? { state: 'error', detail: `${stale[0]}: model request retrying since ${stale[1].since} (${stale[1].attempts} attempts)` }
      : { state: 'ready', detail: 'No session is retrying a model request' })
  }
  /** Stops event routing for `session` after its process exited; rejects its waiters and emits `exited`. */
  private async unlive(id: string, session: Live, expected: boolean): Promise<void> {
    if (this.live.get(id) !== session) return
    this.live.delete(id)
    session.stopEvents()
    // Injects queued while the session ran were already accepted by the effect queue; spill them to notes so the
    // next launch flushes them instead of dropping them with the dead process.
    if (session.pendingInjects.length) {
      const notes = this.host.store.get(KV.sessions.notes(id)) ?? []
      const keys = new Set(notes.map(note => note.key))
      const spilled = session.pendingInjects.filter(item => !keys.has(item.key))
      session.pendingInjects.length = 0
      if (spilled.length) this.host.store.set(KV.sessions.notes(id), [...notes, ...spilled])
    }
    for (const [, waiting] of session.inFlight) {
      clearTimeout(waiting.timer)
      waiting.reject(new RpcExited(`Session ${id} exited`))
    }
    session.inFlight.clear()
    this.emit({ type: 'exited', sessionId: id, expected })
  }
}

/** Removes generated plugin revisions other than `rev`; run once at daemon startup when no session runs. */
export function prunePlugins(stateDir: string, rev: number): void {
  const root = join(stateDir, 'plugin')
  if (!existsSync(root)) return
  for (const name of readdirSync(root)) {
    if (/^r\d+$/.test(name) && name !== `r${rev}`) rmSync(join(root, name), { recursive: true, force: true })
  }
}
