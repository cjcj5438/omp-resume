/** In-memory omp RPC launcher double: records launches and commands, scripts frames per session. */
import { RpcExited, type HostToolDefinition, type HostToolHandler, type LaunchSpec, type Launcher, type RpcChannel,
  type RpcFrame } from '../../src/omp/rpc.ts'

export { RpcExited }

type Responder = (command: Record<string, unknown>) => unknown
interface Session {
  readonly spec: LaunchSpec
  commands: Record<string, unknown>[]
  listeners: Set<(frame: RpcFrame) => void>
  responders: { type: string; respond: Responder }[]
  tools?: { definitions: HostToolDefinition[]; handler: HostToolHandler }
  pending: Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void }>
  results: { id: string; result: unknown; isError?: boolean }[]
  extensionUi: Record<string, unknown>[]
  exited: { code: number | null; signal: NodeJS.Signals | null; stderr: string } | undefined
  resolveExited?: (value: { code: number | null; signal: NodeJS.Signals | null; stderr: string }) => void
}

/** One fake session's scriptable handle, keyed by launch order. */
export class FakeSession {
  constructor(private readonly session: Session) {}
  get spec(): LaunchSpec { return this.session.spec }
  get commands(): Record<string, unknown>[] { return this.session.commands }
  get toolCalls(): { id: string; result: unknown; isError?: boolean }[] { return this.session.results }
  get extensionUi(): Record<string, unknown>[] { return this.session.extensionUi }
  emit(frame: RpcFrame): void {
    for (const listener of this.session.listeners) listener(frame)
  }
  respond(type: string, data: unknown | Responder): void {
    this.session.responders.push({ type, respond: typeof data === 'function' ? data as Responder : () => data })
  }
  async callTool(name: string, args: unknown): Promise<void> {
    const tools = this.session.tools
    if (!tools) throw new Error('No host tools registered')
    const id = `host_${this.session.results.length + 1}`
    const controller = new AbortController()
    const result = await tools.handler({ toolName: name, arguments: args, toolCallId: `toolu_${id}` }, controller.signal)
    this.session.results.push({ id, result: { content: result.content }, ...(result.isError ? { isError: true } : {}) })
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.session.exited = { code, signal, stderr: '' }
    for (const [, entry] of this.session.pending) entry.reject(new RpcExited('omp exited'))
    this.session.pending.clear()
    this.session.resolveExited?.(this.session.exited)
  }
}

export type FakeLauncher = Launcher & {
  readonly launches: LaunchSpec[]
  readonly sessions: FakeSession[]
  launch(spec: LaunchSpec, log: (line: string) => void): Promise<RpcChannel>
}
export const FakeLauncher: new () => FakeLauncher = class FakeLauncherImpl {
  readonly launches!: LaunchSpec[]
  readonly sessions!: FakeSession[]
  private readonly states!: Session[]
  constructor() {
    const self = (async (spec: LaunchSpec, log: (line: string) => void): Promise<RpcChannel> => self.launch(spec, log)) as unknown as FakeLauncher
    Object.setPrototypeOf(self, FakeLauncherImpl.prototype)
    Object.defineProperties(self, { launches: { value: [] }, sessions: { value: [] }, states: { value: [] } })
    return self as unknown as this
  }
  async launch(spec: LaunchSpec, _log: (line: string) => void): Promise<RpcChannel> {
    const listeners = new Set<(frame: RpcFrame) => void>()
    const session: Session = { spec, commands: [], listeners, responders: [], pending: new Map(), results: [], extensionUi: [],
      exited: undefined }
    this.launches.push(spec)
    this.states.push(session)
    const fake = new FakeSession(session)
    this.sessions.push(fake)
    const { promise: exited, resolve: resolveExited } = Promise.withResolvers<NonNullable<Session['exited']>>()
    session.resolveExited = resolveExited
    if (session.exited) resolveExited(session.exited)
    let closed = false
    return {
      pid: 1000 + this.launches.length,
      exited,
      request: <T>(command: { type: string; [key: string]: unknown }): Promise<T> => {
        const { promise, resolve, reject } = Promise.withResolvers<T>()
        const id = `r${session.commands.length + 1}`
        const entry = { ...command, id }
        session.commands.push(entry)
        if (session.exited) { reject(new RpcExited('omp exited')); return promise }
        const responder = [...session.responders].reverse().find(item => item.type === command.type)
        if (responder) {
          const answer = (): void => {
            try { resolve(responder.respond(entry) as T) }
            catch (error) { reject(error instanceof Error ? error : new Error(String(error))) }
          }
          if (typeof queueMicrotask === 'function') queueMicrotask(answer)
          else setTimeout(answer, 0)
          return promise
        }
        if (command.type === 'set_host_tools') {
          const answer = (): void => { resolve({ toolNames: (((entry as Record<string, unknown>).tools ?? []) as HostToolDefinition[]).map(tool => tool.name) } as T) }
          if (typeof queueMicrotask === 'function') queueMicrotask(answer)
          else setTimeout(answer, 0)
          return promise
        }
        session.pending.set(id, { resolve: resolve as (data: unknown) => void, reject })
        return promise
      },
      onEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
      setHostTools: async (definitions, handler) => {
        session.tools = { definitions, handler }
        session.commands.push({ type: 'set_host_tools', tools: definitions })
        return definitions.map(tool => tool.name)
      },
      close: async () => {
        if (!closed) {
          closed = true
          fake.exit(0)
        }
      },
    }
  }
  async [Symbol.asyncDispose](): Promise<void> {}
} as unknown as new () => FakeLauncher

export const fakeLauncher = (): FakeLauncher => new FakeLauncher()
export default FakeLauncher
