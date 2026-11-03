/** Daemon pid file: written on boot, removed on graceful shutdown, reclaimed after a crash. */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'

let directory = ''
let children: ChildProcess[] = []
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'superagent-pidfile-')); children = [] })
afterEach(() => {
  for (const child of children) try { child.kill('SIGKILL') } catch { /* Already exited. */ }
  children = []
  rmSync(directory, { recursive: true, force: true })
})

const OMP = `${process.env.HOME}/.local/bin/omp`
const daemonOf = (dir: string): { stateDir: string; socket: string; pidFile: string } =>
  ({ stateDir: join(dir, 's'), socket: join(dir, 'd.sock'), pidFile: join(dir, 's', 'daemon.pid') })
/** Spawn the built daemon the way the supervisor does; skip when no build or launcher is present. */
const spawnDaemon = (dir: string): ChildProcess => {
  const { stateDir, socket } = daemonOf(dir)
  const child = spawn(OMP, ['run', join(import.meta.dirname, '../dist/daemon.js'),
    '--state-dir', stateDir, '--socket', socket, '--omp', OMP],
    { env: { ...process.env, BUN_BE_BUN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  child.stdout?.resume()
  child.stderr?.resume()
  return child
}
const haveDaemon = (): boolean => existsSync(OMP) && existsSync(join(import.meta.dirname, '../dist/daemon.js'))
/** Wait until `ready` returns true, failing after `timeoutMs` (default 20 s). */
async function until(ready: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
const exitOf = (child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> =>
  new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })))

it('writes the pid file on boot with mode 0600 and removes it on SIGTERM', async () => {
  if (!haveDaemon()) return
  const { pidFile } = daemonOf(directory)
  const child = spawnDaemon(directory)
  await until(() => existsSync(pidFile))
  expect(readFileSync(pidFile, 'utf8')).toBe(`${child.pid}\n`)
  expect(statSync(pidFile).mode & 0o777).toBe(0o600)
  child.kill('SIGTERM')
  const { code } = await exitOf(child)
  expect(code).toBe(0)
  expect(existsSync(pidFile)).toBe(false)
  expect(existsSync(daemonOf(directory).socket)).toBe(false)
}, 30_000)

it('exits 3 without touching the pid file when another daemon holds the lock', async () => {
  if (!haveDaemon()) return
  const { pidFile } = daemonOf(directory)
  const first = spawnDaemon(directory)
  await until(() => existsSync(pidFile))
  const second = spawnDaemon(directory)
  const { code } = await exitOf(second)
  expect(code).toBe(3)
  expect(readFileSync(pidFile, 'utf8')).toBe(`${first.pid}\n`)
  first.kill('SIGTERM')
  await exitOf(first)
}, 30_000)

it('replaces a stale pid file left by a crashed daemon', async () => {
  if (!haveDaemon()) return
  const { pidFile } = daemonOf(directory)
  const crashed = spawnDaemon(directory)
  await until(() => existsSync(pidFile))
  const stalePid = crashed.pid!
  crashed.kill('SIGKILL')
  await exitOf(crashed)
  expect(readFileSync(pidFile, 'utf8')).toBe(`${stalePid}\n`)
  // The crashed daemon's lock goes stale after 30 s; a starter before then must fail, not steal.
  const early = spawnDaemon(directory)
  const { code } = await exitOf(early)
  expect(code).toBe(3)
  expect(readFileSync(pidFile, 'utf8')).toBe(`${stalePid}\n`)
  // Simulate the supervisor reclaiming after the lock expires: clear the stale lock, keep the pid file.
  rmSync(`${daemonOf(directory).stateDir}.lock`, { recursive: true, force: true })
  writeFileSync(pidFile, `${stalePid}\n`)
  const next = spawnDaemon(directory)
  await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8') === `${next.pid}\n`)
  next.kill('SIGTERM')
  await exitOf(next)
}, 60_000)
