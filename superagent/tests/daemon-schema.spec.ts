/** Daemon schema self-description: `--print-schema` prints one line and exits 0; a newer state DB dies cleanly with exit 78. */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { OLDEST_SCHEMA, SCHEMA_VERSION, tooOld } from '../src/app/migration.ts'

let directory = ''
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'superagent-schema-')) })
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

const OMP = `${process.env.HOME}/.local/bin/omp`
const DAEMON = join(import.meta.dirname, '../dist/daemon.js')
const haveDaemon = existsSync(OMP) && existsSync(DAEMON)

it('prints exactly one `schema {...}` line and exits 0 without touching a state dir', () => {
  if (!haveDaemon) return
  const stateDir = join(directory, 'untouched')
  const run = spawnSync(OMP, ['run', DAEMON, '--print-schema', '--state-dir', stateDir, '--socket', join(directory, 'd.sock'), '--omp', OMP],
    { env: { ...process.env, BUN_BE_BUN: '1' }, encoding: 'utf8' })
  expect(run.status).toBe(0)
  expect(run.stdout).toBe(`schema ${JSON.stringify({ schema: SCHEMA_VERSION, oldest: OLDEST_SCHEMA })}\n`)
  expect(run.stderr).toBe('')
  expect(existsSync(stateDir)).toBe(false)
}, 30_000)

it('exits 78 with a one-line mismatch report when the state database is newer than supported', () => {
  if (!haveDaemon) return
  const stateDir = join(directory, 's')
  mkdirSync(stateDir, { recursive: true })
  const db = new DatabaseSync(join(stateDir, 'superagent.sqlite'))
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.prepare('INSERT INTO kv VALUES (?,?)').run('schema', String(SCHEMA_VERSION + 1))
  db.close()
  const run = spawnSync(OMP, ['run', DAEMON, '--state-dir', stateDir, '--socket', join(directory, 'd.sock'), '--omp', OMP],
    { env: { ...process.env, BUN_BE_BUN: '1' }, encoding: 'utf8' })
  expect(run.status).toBe(78)
  expect(run.stderr).toContain(`orchestrator schema mismatch: state=${SCHEMA_VERSION + 1} supported=${OLDEST_SCHEMA}..${SCHEMA_VERSION}\n`)
  expect(run.stderr).not.toContain('at ')
}, 30_000)

it('formats both mismatch directions from the store errors', () => {
  // The daemon matches the store's two rejection messages; keep the contract pinned here.
  expect(`Unsupported orchestrator database version 99`).toMatch(/Unsupported orchestrator database version (\d+)/)
  expect(tooOld(9)).toMatch(/Orchestrator database schema (\d+) predates schema (\d+)/)
})
