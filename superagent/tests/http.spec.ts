import { expect, it } from 'vitest'
import { z } from 'zod'
import { createHandler, fail } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'

/** Mount management HTTP routes and return a request helper. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>) {
  const handler = createHandler({ ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown) => {
    let status = 0, text = ''
    const headers: Record<string, string> = {}
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const req = { method, url: `/orchestrator/api/${path}`, headers: {}, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req as never, { writeHead: (code: number, sent: Record<string, string>) => { status = code; Object.assign(headers, sent) },
      end: (data: string) => { text = data } } as never)
    return { status, headers, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, headers: expect.objectContaining({
    'content-type': 'application/json; charset=utf-8', 'connection': 'close' }), body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toMatchObject({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, headers: expect.objectContaining({
    'content-type': 'application/json; charset=utf-8', 'connection': 'close' }), body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toMatchObject({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toMatchObject({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, headers: expect.objectContaining({
    'content-type': 'application/json; charset=utf-8', 'connection': 'close' }), body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers paths outside /orchestrator/api/ with 404 and lists sessions', async () => {
  const handler = createHandler({ ready: Promise.resolve(),
    sessions: { list: () => [{ id: 'main', role: 'orchestrator', ticketId: null, title: 'main', sessionFile: null, state: 'idle' }] } } as unknown as HttpHost)
  const raw = async (url: string) => {
    let status = 0, text = ''
    await handler({ method: 'GET', url, headers: {}, async *[Symbol.asyncIterator]() {} } as never,
      { writeHead: (code: number) => { status = code }, end: (data: string) => { text = data } } as never)
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
  expect(await raw('/orchestrator/panel')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await raw('/orchestrator/api/sessions')).toMatchObject({ status: 200,
    body: { items: [{ id: 'main', role: 'orchestrator', state: 'idle' }] } })
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, headers: expect.objectContaining({ 'content-type': 'application/json; charset=utf-8' }),
      body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toMatchObject({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

it('ends the response with a 500 JSON body when a route throws', async () => {
  const call = serve({ engine: { unsubscribe: () => { throw new Error('engine gone') } } })
  expect(await call('POST', 'threads/k/unsubscribe')).toEqual({ status: 500, headers: expect.objectContaining({
    'content-type': 'application/json; charset=utf-8', 'connection': 'close' }), body: { error: 'engine gone' } })
})

it('fails a response outside any route with the same JSON error envelope', () => {
  let status = 0, text = ''
  const headers: Record<string, unknown> = {}
  fail({ writeHead: (code: number, sent: Record<string, unknown>) => { status = code; Object.assign(headers, sent) },
    end: (data: string) => { text = data } } as never, 500, 'not ready')
  expect(status).toBe(500)
  expect(headers).toEqual({ 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'connection': 'close' })
  expect(text).toBe('{"error":"not ready"}')
})
