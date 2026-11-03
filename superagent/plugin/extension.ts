/** Superagent omp plugin: non-waking notice injection plus the main session's no-wait guard. */
interface Pi {
  registerCommand(name: string, definition: { description: string; handler: (args: string, ctx?: unknown) => Promise<void> | void }): void
  sendMessage(message: { customType: string; content: string; display: boolean; details: { summary: string } },
    options: { deliverAs: 'nextTurn' }): Promise<void> | void
  on(event: 'tool_call', listener: (event: { toolName: string; toolCallId: string; input: unknown }) => { block: boolean; reason: string } | undefined): void
}

/** What the main session is told when it would wait: what it waits for comes to it, and a waiting step holds back the next. */
const NO_WAIT = 'Reports, follow_up notices, new candidates and a background job\'s end with its output arrive by themselves as messages; '
  + 'end the turn instead of waiting for them.'
/** `sleep` at a command position: the start, after ; & | ( { ! ` or a newline, or after a keyword or a command that runs it. */
const SLEEP = /(?:^|[;&|({!`\n]|\b(?:do|then|else|elif|if|while|until|time|exec|nohup|command|env)\s)\s*(?:\S*\/)?sleep\b/

export default function (pi: Pi): void {
  pi.registerCommand('superagent-inject', {
    description: 'Deliver a Superagent notice without waking the session.',
    handler: async args => {
      const { summary, text } = JSON.parse(Buffer.from(args.trim(), 'base64url').toString('utf8')) as { summary: string; text: string }
      await pi.sendMessage({ customType: 'superagent-notice', content: text, display: true, details: { summary } }, { deliverAs: 'nextTurn' })
    },
  })
  if (process.env.OMP_SUPERAGENT_ROLE === 'main') {
    pi.on('tool_call', event => {
      if (event.toolName !== 'bash') return undefined
      const command = (event.input as { command?: unknown } | undefined)?.command
      if (typeof command === 'string' && SLEEP.test(command)) return { block: true, reason: NO_WAIT }
      return undefined
    })
  }
}
