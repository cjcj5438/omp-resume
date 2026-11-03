/** omp `--mode rpc` client: newline-delimited JSON commands over a child process's stdio. */
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export type RpcFrame = { type: string; [key: string]: unknown }
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }
export interface HostToolDefinition { name: string; label: string; description: string; parameters: object; loadMode: 'essential' }
export interface HostToolResult { content: ToolContent[]; isError?: boolean }
export type HostToolHandler = (call: { toolName: string; arguments: unknown; toolCallId: string }, signal: AbortSignal) => Promise<HostToolResult>
export class RpcError extends Error { constructor(message: string, readonly code?: string) { super(message) } }
export class RpcExited extends Error {}
export interface RpcChannel {
  request<T = unknown>(command: { type: string; [key: string]: unknown }, timeoutMs?: number): Promise<T>
  onEvent(listener: (frame: RpcFrame) => void): () => void
  setHostTools(tools: HostToolDefinition[], handler: HostToolHandler): Promise<string[]>
  close(graceMs?: number): Promise<void>
  readonly pid: number | undefined
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>
}
export interface LaunchSpec { bin: string; args: string[]; cwd: string; env: Record<string, string | undefined> }
export type Launcher = (spec: LaunchSpec, log: (line: string) => void) => Promise<RpcChannel>

const READY_TIMEOUT_MS = 60_000, REQUEST_TIMEOUT_MS = 120_000, STDERR_KEEP_BYTES = 64 * 1024

/** Launches an omp RPC child and resolves once it emits `{type:'ready'}` (protocol v1; no `negotiate_protocol`). */
export const spawnLauncher: Launcher = async (spec, log) => {
  const environment = { ...spec.env }
  for (const [name, value] of Object.entries(environment)) if (value === undefined) delete environment[name]
  const child = spawn(spec.bin, spec.args, { cwd: spec.cwd, env: environment as Record<string, string>, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
  const listeners = new Set<(frame: RpcFrame) => void>()
  const pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  const calls = new Map<string, AbortController>()
  let tools: { handler: HostToolHandler } | undefined
  let stderr = '', stderrLogged = 0, seq = 0, closed = false
  const { promise: exited, resolve: resolveExited } = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>()
  const tail = (): string => Buffer.from(stderr, 'utf8').subarray(-4096).toString('utf8')
  const write = (frame: Record<string, unknown>): void => {
    if (!closed) child.stdin.write(`${JSON.stringify(frame)}\n`)
  }
  const finish = (id: string, error: Error): void => {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.reject(error)
  }
  const onLine = (line: string): void => {
    if (!line.trim()) return
    let frame: RpcFrame
    try { frame = JSON.parse(line) as RpcFrame } catch { log(`rpc: unparsable line ${line.slice(0, 200)}`); return }
    if (typeof frame.type !== 'string') { log(`rpc: unparsable line ${line.slice(0, 200)}`); return }
    if (frame.type === 'response' && typeof frame.id === 'string') {
      const entry = pending.get(frame.id)
      if (!entry) return
      pending.delete(frame.id)
      clearTimeout(entry.timer)
      if (frame.success === false) entry.reject(new RpcError(typeof frame.error === 'string' ? frame.error : 'omp request failed',
        typeof frame.code === 'string' ? frame.code : undefined))
      else entry.resolve(frame.data)
      return
    }
    if (frame.type === 'host_tool_call' && typeof frame.id === 'string') {
      const handler = tools?.handler
      if (!handler) return
      const controller = new AbortController()
      calls.set(frame.id, controller)
      const call = { toolName: String(frame.toolName ?? ''), arguments: frame.arguments, toolCallId: String(frame.toolCallId ?? '') }
      handler(call, controller.signal).then(result => {
        write({ type: 'host_tool_result', id: frame.id, ...(result.isError ? { isError: true } : {}), result: { content: result.content } })
      }, (error: unknown) => {
        write({ type: 'host_tool_result', id: frame.id, isError: true,
          result: { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] } })
      }).finally(() => { calls.delete(frame.id as string) })
      return
    }
    if (frame.type === 'host_tool_cancel' && typeof frame.targetId === 'string') {
      calls.get(frame.targetId)?.abort()
      return
    }
    if (frame.type === 'extension_ui_request' && typeof frame.id === 'string') {
      if (frame.method === 'confirm') write({ type: 'extension_ui_response', id: frame.id, confirmed: false })
      else if (frame.method === 'select' || frame.method === 'input' || frame.method === 'editor' || frame.method === 'ask') {
        write({ type: 'extension_ui_response', id: frame.id, cancelled: true })
      }
      return
    }
    for (const listener of listeners) listener(frame)
  }
  let buffered = ''
  const stdoutDecoder = new StringDecoder('utf8')
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += stdoutDecoder.write(chunk)
    let end = buffered.indexOf('\n')
    while (end >= 0) {
      const line = buffered.slice(0, end)
      buffered = buffered.slice(end + 1)
      end = buffered.indexOf('\n')
      onLine(line)
    }
  })
  const stderrDecoder = new StringDecoder('utf8')
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += stderrDecoder.write(chunk)
    if (stderr.length > STDERR_KEEP_BYTES * 2) stderr = stderr.slice(-STDERR_KEEP_BYTES)
    const lines = stderr.slice(stderrLogged).split('\n')
    stderrLogged = stderr.length - lines.pop()!.length
    for (const line of lines) if (line) log(`omp[${child.pid}] ${line}`)
  })
  let spawnError = ''
  child.on('error', (error: Error) => {
    spawnError = error.message
    for (const id of [...pending.keys()]) finish(id, new RpcExited(error.message))
    resolveExited({ code: null, signal: null, stderr: tail() })
  })
  child.on('close', (code, signal) => {
    for (const id of [...pending.keys()]) finish(id, new RpcExited(`omp exited with ${code ?? signal}`))
    resolveExited({ code, signal, stderr: tail() })
  })
  const channel: RpcChannel = {
    pid: child.pid,
    exited,
    request: <T>(command: { type: string; [key: string]: unknown }, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> => {
      if (closed) return Promise.reject(new RpcExited('channel closed'))
      const { promise, resolve, reject } = Promise.withResolvers<T>()
      const id = `r${++seq}`
      const timer = setTimeout(() => { pending.delete(id); reject(new RpcError('timeout')) }, timeoutMs)
      timer.unref?.()
      pending.set(id, { resolve: resolve as (data: unknown) => void, reject, timer })
      write({ ...command, id })
      return promise
    },
    onEvent: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    setHostTools: async (definitions, handler) => {
      tools = { handler }
      const data = await channel.request<{ toolNames?: unknown }>({ type: 'set_host_tools', tools: definitions })
      return Array.isArray(data.toolNames) ? data.toolNames.filter((name): name is string => typeof name === 'string') : []
    },
    close: async (graceMs = 10_000) => {
      closed = true
      child.stdin.end()
      const done = (async () => { await exited })()
      const timer = setTimeout(() => {
        try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL') } catch { /* Already exited. */ }
      }, graceMs)
      timer.unref?.()
      await done
      clearTimeout(timer)
    },
  }
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL') } catch { /* Already exited. */ }
      reject(new RpcError(`omp did not send ready within 60s: ${tail()}`))
    }, READY_TIMEOUT_MS)
    timer.unref?.()
    const stop = channel.onEvent(frame => {
      if (frame.type !== 'ready') return
      clearTimeout(timer)
      stop()
      resolve()
    })
    void exited.then(({ code, signal }) => {
      clearTimeout(timer)
      stop()
      reject(new RpcExited(spawnError ? `omp failed to start: ${spawnError}` : `omp exited with ${code ?? signal} before ready: ${tail()}`))
    })
  })
  await ready
  return channel
}
