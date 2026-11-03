import { afterEach, expect, it, vi } from 'vitest'
import { RpcError, RpcExited, spawnLauncher } from '../src/omp/rpc.ts'

const script = new URL('./fixtures/fake-omp-process.mjs', import.meta.url).pathname
const launch = () => spawnLauncher({ bin: process.execPath, args: [script], cwd: process.cwd(), env: {} }, () => {})

afterEach(() => { vi.useRealTimers() })

it('queues requests sent before ready, then resolves them', async () => {
  const channel = await launch()
  try {
    const state = await channel.request<{ sessionFile: string }>({ type: 'get_state' })
    expect(state.sessionFile).toBe('/tmp/fake/session.jsonl')
  } finally { await channel.close() }
})

it('correlates responses by id and rejects RpcError on success:false', async () => {
  const channel = await launch()
  try {
    const [first, second] = await Promise.all([
      channel.request({ type: 'get_state' }),
      channel.request({ type: 'get_state' }),
    ])
    expect(first).toEqual(second)
    const failure = await channel.request({ type: 'bogus' }).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(RpcError)
    expect((failure as RpcError).message).toContain('Unknown command')
  } finally { await channel.close() }
})

it('delivers host_tool_call results back to the process', async () => {
  const channel = await launch()
  try {
    const seen = new Promise<unknown>(resolve => {
      const stop = channel.onEvent(frame => {
        if (frame.type === 'host_tool_result_seen') { stop(); resolve(frame) }
      })
    })
    const names = await channel.setHostTools(
      [{ name: 'probe', label: 'probe', description: 'probe', parameters: { type: 'object' }, loadMode: 'essential' }],
      async call => {
        expect(call.toolName).toBe('probe')
        expect(call.arguments).toEqual({ ping: true })
        return { content: [{ type: 'text', text: 'pong' }] }
      })
    expect(names).toEqual(['probe'])
    expect(await seen).toMatchObject({ id: 'host_1', result: { content: [{ type: 'text', text: 'pong' }] } })
  } finally { await channel.close() }
})

it('aborts the handler signal on host_tool_cancel', async () => {
  const channel = await launch()
  try {
    await channel.setHostTools(
      [{ name: 'probe', label: 'probe', description: 'probe', parameters: { type: 'object' }, loadMode: 'essential' }],
      async () => ({ content: [{ type: 'text', text: 'early' }] }))
    const aborted = Promise.withResolvers<void>()
    await channel.setHostTools(
      [{ name: 'slow', label: 'slow', description: 'slow', parameters: { type: 'object' }, loadMode: 'essential' }],
      (_call, signal) => {
        if (signal.aborted) aborted.resolve()
        else signal.addEventListener('abort', () => aborted.resolve(), { once: true })
        return new Promise(() => {})
      })
    await channel.request({ type: 'cancel_me', tool: 'slow' })
    await aborted.promise
  } finally { await channel.close() }
})

it('rejects pending requests with RpcExited when the process exits', async () => {
  const channel = await launch()
  const waiting = channel.request({ type: 'never' }, 30_000).then(() => 'resolved', (error: unknown) => error)
  await channel.close()
  expect(await waiting).toBeInstanceOf(RpcExited)
  const { code } = await channel.exited
  expect(code).toBe(0)
})

it('reassembles a multibyte char split across stdout chunks', async () => {
  const channel = await launch()
  try {
    const data = await channel.request<{ text: string }>({ type: 'split_utf8' })
    expect(data.text).toBe('中文 ok')
  } finally { await channel.close() }
})

it('logs unparsable stdout lines and keeps framing in sync', async () => {
  const lines: string[] = []
  const channel = await spawnLauncher({ bin: process.execPath, args: [script], cwd: process.cwd(), env: {} }, line => { lines.push(line) })
  try {
    // The fake answers, then emits a garbage line (extension console.log on stdout), then a second frame.
    await channel.request({ type: 'garbage' })
    await vi.waitFor(() => { expect(lines.some(line => line.startsWith('rpc: unparsable line this is not json'))).toBe(true) })
  } finally { await channel.close() }
})

it('rejects requests made after close() instead of hanging until timeout', async () => {
  const channel = await launch()
  await channel.close()
  const outcome = await channel.request({ type: 'get_state' }, 30_000).then(() => 'resolved', (error: unknown) => error)
  expect(outcome).toBeInstanceOf(RpcExited)
  expect((outcome as RpcExited).message).toBe('channel closed')
})

it('reports the spawn failure when the binary cannot start', async () => {
  const outcome = await spawnLauncher(
    { bin: '/nonexistent-dir/nonexistent-omp', args: [], cwd: process.cwd(), env: {} }, () => {}
  ).then(() => 'resolved', (error: unknown) => error)
  expect(outcome).toBeInstanceOf(RpcExited)
  expect((outcome as RpcExited).message).toMatch(/^omp failed to start: spawn .* ENOENT/)
})

it('kills the process group and rejects RpcError when ready never arrives', async () => {
  vi.useFakeTimers()
  try {
    const launching = spawnLauncher(
      { bin: process.execPath, args: [script, '--no-ready'], cwd: process.cwd(), env: {} }, () => {})
    const outcome = await Promise.race([
      launching.then(() => 'resolved', (error: unknown) => error),
      (async () => { await vi.advanceTimersByTimeAsync(60_000); return launching.then(() => 'resolved', (error: unknown) => error) })(),
    ])
    expect(outcome).toBeInstanceOf(RpcError)
    expect((outcome as RpcError).message).toMatch(/^omp did not send ready within 60s/)
  } finally {
    vi.useRealTimers()
  }
})
