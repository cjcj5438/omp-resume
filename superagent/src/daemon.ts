/** Superagent daemon entry: owns the state dir, runs one Runtime, serves the panel API on a unix socket. */
import { chmodSync, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { machineFor } from './deployment.ts'
import { spawnLauncher } from './omp/rpc.ts'
import { prunePlugins } from './omp/sessions.ts'
import { Runtime } from './app/runtime.ts'
import { createHandler, fail } from './app/http.ts'

const OVERLAY = `# Written by omp-superagent; applies only to omp processes started by Superagent.
memory:
  backend: "off"
advisor:
  enabled: false
bash:
  autoBackground:
    enabled: true
    thresholdMs: 5000
`

const log = (level: 'info' | 'warn' | 'error', message: string): void => {
  process.stdout.write(`${new Date().toISOString()} ${level} ${message}\n`)
}
const logger = { info: (message: string) => log('info', message), warn: (message: string) => log('warn', message),
  error: (message: string) => log('error', message) }

const args = (argv: string[]): { stateDir: string; socket: string; omp: string } => {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag)
    return at >= 0 && at + 1 < argv.length ? argv[at + 1] : undefined
  }
  const stateDir = value('--state-dir'), socket = value('--socket'), omp = value('--omp')
  if (!stateDir || !socket || !omp) {
    process.stderr.write('usage: daemon.js --state-dir <dir> --socket <path> --omp <omp-bin>\n')
    process.exit(2)
  }
  return { stateDir, socket, omp }
}

/** Rejects when another daemon answers on `socket`, unlinks it when the listener is gone. */
const claimSocket = (socket: string): Promise<void> => {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  if (!existsSync(socket)) { resolve(); return promise }
  const probe = connect(socket)
  probe.on('connect', () => { probe.destroy(); reject(new Error(`another Superagent daemon is listening on ${socket}`)) })
  probe.on('error', (error: NodeJS.ErrnoException) => {
    probe.destroy()
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') {
      try { unlinkSync(socket) } catch { /* Raced with another starter; listen decides. */ }
      resolve()
    } else reject(error)
  })
  return promise
}

async function main(): Promise<void> {
  // The one sanctioned environment mutation: `BUN_BE_BUN=1` is only the `omp run` launch trampoline.
  // Every omp/gh/git/worker child breaks when it inherits the flag (Bun reinterprets their argv), so it dies here.
  delete process.env.BUN_BE_BUN
  logger.info('BUN_BE_BUN removed from the daemon environment')
  const { stateDir, socket, omp } = args(process.argv.slice(2))
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  writeFileSync(`${stateDir}/omp-overlay.yml`, OVERLAY)
  const boot = (): Runtime => {
    let runtime: Runtime
    try {
      runtime = new Runtime({ machine: machineFor(stateDir), ompBin: omp, launcher: spawnLauncher, logger, restart })
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ELOCKED') {
        logger.error(`another Superagent daemon holds ${stateDir}`)
        process.exit(3)
      }
      throw error
    }
    // No session can have launched yet: Runtime only launches after its first await yields.
    prunePlugins(stateDir, runtime.prompts.current().revision)
    return runtime
  }
  let current = boot()
  let chain: Promise<void> = Promise.resolve()
  function restart(): void {
    chain = chain.then(async () => {
      logger.info('restarting Superagent')
      await current.stop().catch((error: unknown) => logger.warn(`restart stop failed: ${String(error)}`))
      current = boot()
      await current.ready
      logger.info('Superagent restarted')
    }).catch((error: unknown) => logger.error(`restart failed: ${String(error)}`))
  }
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const runtime = current
    runtime.ready.then(() => createHandler(runtime.httpHost())(req, res)).catch((error: unknown) => {
      logger.error(`request failed: ${String(error)}`)
      if (!res.headersSent) fail(res, 500, error instanceof Error ? error.message : String(error))
      else res.destroy()
    })
  })
  await claimSocket(socket).catch((error: unknown) => { logger.error(String((error as Error)?.message ?? error)); process.exit(3) })
  await new Promise<void>((resolve, reject) => { server.on('error', reject); server.listen(socket, () => resolve()) })
    .catch((error: unknown) => { logger.error(`listen failed: ${String(error)}`); process.exit(1) })
  chmodSync(socket, 0o600)
  logger.info(`listening on ${socket}`)
  // The lock is held and the socket is ours: a leftover pid file can only be from a crashed daemon.
  const pidFile = `${stateDir}/daemon.pid`
  try { unlinkSync(pidFile) } catch { /* No stale pid file. */ }
  writeFileSync(pidFile, `${process.pid}\n`, { mode: 0o600 })
  logger.info(`pid file written ${pidFile}`)
  await current.ready
  logger.info('Superagent is ready')
  let stopping: Promise<void> | undefined
  const shutdown = (signal: string): void => {
    stopping ??= (async () => {
      logger.info(`received ${signal}, stopping`)
      // Watchdog: graceful shutdown should take well under 20 s (15 s stop race
      // plus socket cleanup). If anything hangs past 25 s — a wedged session close,
      // a stuck server.close — SIGKILL ourselves so the supervisor's reclaim/stop
      // never times out waiting for a process that already decided to die.
      // SIGKILL cannot be caught or ignored; the supervisor deletes the pid file.
      const watchdog = setTimeout(() => {
        logger.warn('shutdown timed out after 25 s, self SIGKILL')
        process.kill(process.pid, 'SIGKILL')
      }, 25_000)
      watchdog.unref?.()
      // A rejecting stop must not skip server close, socket unlink, and exit: contain it before the race.
      await Promise.race([current.stop().catch((error: unknown) => logger.warn(`stop failed: ${String(error)}`)),
        new Promise(resolve => setTimeout(resolve, 15_000))])
      await chain.catch(() => {})
      await new Promise<void>(resolve => server.close(() => resolve()))
      try { unlinkSync(pidFile) } catch { /* Already gone. */ }
      try { unlinkSync(socket) } catch { /* Already gone. */ }
      clearTimeout(watchdog)
      logger.info('stopped')
      process.exit(0)
    })()
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((error: unknown) => { logger.error(String(error instanceof Error ? error.stack ?? error.message : error)); process.exit(1) })
