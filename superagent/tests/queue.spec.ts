/** Effect queue migration and notice deduplication on the Runtime. */
import { afterEach, expect, it, vi } from 'vitest'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host | undefined
afterEach(async () => { await h?.stop(); h = undefined })
const notices = (host: Host) => host.deliveries.mock.calls.map(([call]) => call).filter(call => call.mode === 'inject')
  .map(call => JSON.parse(call.text) as Record<string, unknown>)

it('delivers the relays, subscription changes and notifications that a version before the effect queue kept, once the migration queued them', async () => {
  h = await startRuntime(store => {
    // A schema 10 database, which the schema 11 migration brings up to date when the Runtime opens it.
    store.set('schema', 10)
    store.set('relay-queue', [{ id: 'report:old', text: JSON.stringify({ kind: 'worker_report', ticket_id: 't1', state: 'ready' }) }])
    store.set('subscription-results', ['github:7'])
    store.set('prompt-notification', 3)
    store.set('settings-notification', 5)
  })
  await h.runtime.idle()
  const steered = h.deliveries.mock.calls.map(([call]) => call).filter(call => call.mode === 'steer')
    .map(call => JSON.parse(call.text) as Record<string, unknown>)
  expect(steered).toEqual([{ kind: 'worker_report', ticket_id: 't1', state: 'ready' }])
  expect(notices(h)).toEqual(expect.arrayContaining([{ subscription_changes: [{ thread: 'github:7', removed: true }] },
    { prompt_config_saved: 3, effect: 'next-request', read: 'prompts/3' }, { settings_saved: true, read: 'settings' }]))
  for (const name of ['relay-queue', 'subscription-results', 'prompt-notification', 'settings-notification']) expect(h.runtime.store.get(name)).toBeUndefined()
  expect(h.runtime.effects.pending('relay') || h.runtime.effects.pending('notice')).toBe(false)
})

it('keeps only the latest settings notice while the main Session cannot take one', async () => {
  h = await startRuntime()
  h.session(h.runtime.masterId).respond('prompt', () => { throw new Error('session busy') })
  expect(await h.runtime.settings.pause(true, 'panel')).toEqual({ paused: true })
  await h.runtime.settings.pause(false, 'panel')
  expect(h.runtime.effects.pending('notice', 'settings:pause')).toBe(true)
  h.session(h.runtime.masterId).respond('prompt', () => ({}))
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2000 })
  try { await h.runtime.pump(); await h.runtime.idle() } finally { vi.useRealTimers() }
  expect(notices(h)).toEqual([{ settings_saved: 'pause', changed: ['paused'], read: 'settings/pause' }])
})
