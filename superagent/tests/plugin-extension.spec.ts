import { afterEach, describe, expect, it, vi } from 'vitest'
import extension from '../plugin/extension.ts'

type ToolCallEvent = { toolName: string; toolCallId: string; input: unknown }
type ToolCallListener = (event: ToolCallEvent) => { block: boolean; reason: string } | undefined
type CommandHandler = (args: string, ctx?: unknown) => Promise<void> | void

const savedRole = process.env.OMP_SUPERAGENT_ROLE

afterEach(() => {
  if (savedRole === undefined) delete process.env.OMP_SUPERAGENT_ROLE
  else process.env.OMP_SUPERAGENT_ROLE = savedRole
})

function load(role: string | undefined) {
  if (role === undefined) delete process.env.OMP_SUPERAGENT_ROLE
  else process.env.OMP_SUPERAGENT_ROLE = role
  const commands = new Map<string, { description: string; handler: CommandHandler }>()
  const listeners = new Map<string, ToolCallListener[]>()
  const sendMessage = vi.fn()
  extension({
    registerCommand: (name, definition) => { commands.set(name, definition) },
    sendMessage,
    on: (event, listener) => { listeners.set(event, [...(listeners.get(event) ?? []), listener as ToolCallListener]) },
  })
  return { commands, listeners, sendMessage }
}

describe('main session sleep guard', () => {
  it('blocks bash sleep but nothing else', () => {
    const { listeners } = load('main')
    const guard = listeners.get('tool_call')?.[0]
    expect(guard).toBeDefined()
    const blocked = guard!({ toolName: 'bash', toolCallId: 'c1', input: { command: 'sleep 30' } })
    expect(blocked?.block).toBe(true)
    expect(blocked?.reason).toContain('end the turn')
    expect(guard!({ toolName: 'bash', toolCallId: 'c2', input: { command: 'ls' } })).toBeUndefined()
    expect(guard!({ toolName: 'read', toolCallId: 'c3', input: { command: 'sleep 1' } })).toBeUndefined()
    expect(guard!({ toolName: 'bash', toolCallId: 'c4', input: { command: 42 } })).toBeUndefined()
  })

  it.each(['worker', undefined])('registers no tool_call listener for role %s', role => {
    expect(load(role).listeners.get('tool_call')).toBeUndefined()
  })
})

describe('superagent-inject', () => {
  it('delivers the notice as a next-turn custom message', async () => {
    const { commands, sendMessage } = load('main')
    const handler = commands.get('superagent-inject')?.handler
    expect(handler).toBeDefined()
    const payload = Buffer.from(JSON.stringify({ summary: 's', text: '[superagent:abc]\nhello' })).toString('base64url')
    await handler!(payload)
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage).toHaveBeenCalledWith(
      { customType: 'superagent-notice', content: '[superagent:abc]\nhello', display: true, details: { summary: 's' } },
      { deliverAs: 'nextTurn' },
    )
  })
})
