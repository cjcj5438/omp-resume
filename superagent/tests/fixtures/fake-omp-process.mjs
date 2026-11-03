#!/usr/bin/env node
// Fake omp --mode rpc process for rpc.spec.ts: ready, get_state, prompt, set_host_tools.
import { createInterface } from 'node:readline'

const send = frame => { process.stdout.write(`${JSON.stringify(frame)}\n`) }
if (process.argv.includes('--no-ready')) {
  // Never send ready or respond: exercises the launcher's 60 s ready timeout (under fake timers).
  createInterface({ input: process.stdin }).on('line', () => {})
} else {
send({ type: 'ready', protocolVersion: 1 })

createInterface({ input: process.stdin }).on('line', line => {
  if (!line.trim()) return
  const command = JSON.parse(line)
  const { id, type } = command
  if (type === 'get_state') {
    send({ type: 'response', id, command: type, success: true, data: { sessionFile: '/tmp/fake/session.jsonl', isStreaming: false } })
  } else if (type === 'prompt') {
    send({ type: 'response', id, command: type, success: true, data: {} })
    send({ type: 'agent_start' })
    send({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: command.message }] } })
    send({ type: 'agent_end', yielded: true, isTerminal: true })
    send({ type: 'prompt_result', id, agentInvoked: true, status: 'completed', sessionSettled: true })
    send({ type: 'session_settled' })
  } else if (type === 'set_host_tools') {
    send({ type: 'response', id, command: type, success: true, data: { toolNames: command.tools.map(tool => tool.name) } })
    send({ type: 'host_tool_call', id: 'host_1', toolCallId: 'toolu_1', toolName: command.tools[0].name, arguments: { ping: true } })
  } else if (type === 'cancel_me') {
    send({ type: 'response', id, command: type, success: true, data: {} })
    send({ type: 'host_tool_call', id: 'cancel_1', toolCallId: 'toolu_cancel', toolName: command.tool ?? 'slow', arguments: {} })
    setTimeout(() => send({ type: 'host_tool_cancel', id: 'cancel_req', targetId: 'cancel_1' }), 20)
  } else if (type === 'host_tool_result') {
    send({ type: 'host_tool_result_seen', id, result: command.result, ...(command.isError ? { isError: true } : {}) })
  } else if (type === 'extension_ui_response') {
    send({ type: 'extension_ui_response_seen', id })
  } else if (type === 'never') {
    // No response: used to test request timeouts and exit rejection.
  } else if (type === 'split_utf8') {
    // Emit one frame with a multibyte char split across two writes, like a chunked pipe.
    const frame = `${JSON.stringify({ type: 'response', id, command: type, success: true, data: { text: '中文 ok' } })}\n`
    const bytes = Buffer.from(frame, 'utf8')
    const cut = bytes.indexOf(Buffer.from('中', 'utf8')) + 1
    process.stdout.write(bytes.subarray(0, cut))
    setTimeout(() => process.stdout.write(bytes.subarray(cut)), 20)
  } else if (type === 'garbage') {
    send({ type: 'response', id, command: type, success: true, data: {} })
    process.stdout.write('this is not json [\n')
    send({ type: 'response', id: `${id}-second`, command: type, success: true, data: {} })
  } else {
    send({ type: 'response', id, command: type, success: false, error: `Unknown command ${type}` })
  }
})
}
