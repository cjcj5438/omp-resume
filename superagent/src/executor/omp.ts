/** omp executor: manages one worker session process and workspace directory per ticket. */
import { mkdir, rmdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { latestAssignment, latestReport, liveTicket, runningAssignment, waitsForPerson } from '../core/index.ts'
import type { AssessmentOutcome, Assignment, EngineForExecutor, Executor, Ticket, TicketInput, Trigger } from '../core/index.ts'
import type { Machine } from '../deployment.ts'
import { runAsWorker, verifyDirectory } from '../infra/environment.ts'
import type { Store } from '../app/store.ts'
import type { Effects } from '../app/effects.ts'
import type { Variable } from '../app/execution-environment.ts'
import type { Setup } from '../app/setup.ts'
import { resultRelay } from '../app/notices.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { OmpSessions, SessionEvent } from '../omp/sessions.ts'
import { ASSIGNMENT_CHARS, BACKGROUND_LIMIT_MS, batchLine, batchOf, inputMessage, inputResource, Later, PREPARE_TIMEOUT_MS,
  PrepareFailed, RETRIED, SLOT_WAIT_MS, sourceTrigger, ticketExecution, ticketOfSession, TRANSIENT_BACKOFF_MS, TRANSIENT_TRIES,
  transient, triggerMessage, WorkerSlots, workerSessionId } from './work.ts'

const now = (): string => new Date().toISOString()
/** True when an input comes from a person (a non-context human trigger or a direct text input such as a status request). */
const fromPerson = (input?: TicketInput): boolean => input?.kind === 'trigger' ? !!input.human && !input.context : input?.kind === 'text'
/** Returns `text` up to `limit` characters, or a truncated preview with total character count and the resource path to read the full text. */
const capped = (text: string, limit: number, read: string) =>
  text.length <= limit ? { text } : { text: `${text.slice(0, limit)}…`, chars: text.length, read }

/** Host dependencies used by `OmpExecutor`. */
export interface OmpExecutorHost {
  /** Where the Executor reports what happened to Assignments and Inputs. */
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'inputsRead' | 'turnEnded' | 'deliveryFailed' | 'report'
    | 'assignmentInterrupted'>
  readonly store: Pick<Store, 'tickets' | 'triggers' | 'set' | 'settings' | 'atomic' | 'afterCommit'>
  /** Durable effect queue through which launches and input deliveries run. */
  readonly effects: Pick<Effects, 'enqueue' | 'handle'>
  /** The `worker` health entry, which reports whether background worker event handling failed. */
  readonly health: HealthEntry
  readonly machine: Pick<Machine, 'stateDir'>
  readonly lifetime: AbortSignal
  /** Session manager for worker sessions and for relaying worker reports to the main Session. */
  readonly sessions: OmpSessions
  closing(): boolean
  /** Whether processing is paused, which holds launches and input deliveries. */
  paused(): boolean
  /** Execution environment variables for `ticket`, passed to its workspace prepare command. */
  environment(ticket: Ticket): Variable[]
  sourceLink(trigger: Trigger, signal?: AbortSignal): Promise<{ source_url?: string; source_url_read?: string }>
  /** Stored Trigger of the message `trigger` replies to, when it replies to one. */
  repliedTo(trigger: Trigger): Trigger | undefined
  /** Setup state; the executor reads `workerEnv()` for worker subprocesses. */
  readonly setup: Pick<Setup, 'workerEnv'>
}

/**
 * Executes ticket assignments in per-ticket omp worker sessions and isolated workspace directories.
 * Queues launches and input deliveries through Effects, manages concurrency with WorkerSlots, listens for worker
 * session events from OmpSessions, and reports status transitions back to Engine.
 * Runtime, Engine, worker tools, and management routes use this class to prepare, launch, deliver to, stop, and resume ticket assignments.
 */
export class OmpExecutor implements Executor {
  private readonly disposers: (() => void)[] = []
  private readonly slots: WorkerSlots
  /** Transient failure counts tried so far: keyed by `assignment.id` for worker turns and `launch:<assignment.id>` for launches. */
  private readonly transient = new Map<string, number>()
  /** Assignment IDs currently waiting on a transient-failure backoff timer before resuming their worker turn. */
  private readonly resuming = new Set<string>()
  /**
   * The looks at background work of workers that yielded, by ticket, which hold their slots; a look ends when its worker
   * runs again or its Assignment ends.
   */
  private readonly settling = new Map<string, AbortController>()
  /** The parks of handed-off workers waiting for their session to settle before it is closed, by ticket; parks hold no slot. */
  private readonly parking = new Map<string, AbortController>()
  /** Tickets whose worker failure was already handled for the current turn; `started` resets. */
  private readonly failureSeen = new Set<string>()
  /** The timers of workers that go on after a passing failure, which dispose clears. */
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** Registers the `launch` and `delivery` effect handlers; both are held (concurrency limit 0) while processing is paused. */
  constructor(private readonly host: OmpExecutorHost) {
    this.slots = new WorkerSlots(() => host.store.tickets.open().filter(ticket => this.running(ticket)).map(ticket => ticket.id),
      () => host.store.settings().executor.maxWorkers)
    // Each launch reserves a worker slot so launches run concurrently while slots are free.
    host.effects.handle('launch', payload => this.launchQueued(payload), { limit: () => host.paused() ? 0 : this.slots.launches(),
      retry: [5000, 300_000] })
    // Failed input deliveries are recorded on the ticket itself rather than reported through the `delivery` effect health entry (`quiet: true`).
    host.effects.handle('delivery', payload => this.deliverQueued(payload.ticketId), { limit: () => host.paused() ? 0 : 4, quiet: true })
  }
  /** Populates a newly accepted ticket's `execution` attributes (worktree name, workspace directory, and assignment text). */
  prepare(ticket: Ticket, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    return { ...ticket, execution: ticketExecution(ticket, outcome, this.host.store.settings(), this.host.machine.stateDir) }
  }
  /**
   * Runs the configured `executor.prepare` command for a new ticket workspace in its parent directory with the ticket's
   * execution environment variables, then verifies the directory as the worker sees it.
   * A failed prepare command throws `PrepareFailed`, which is not retried automatically; an empty directory it left is removed, a non-empty one kept.
   * @throws PrepareFailed with the command's output when the prepare command fails.
   */
  private async prepareDirectory(ticket: Ticket): Promise<void> {
    const directory = ticket.execution?.directory ?? ''
    await mkdir(dirname(directory), { recursive: true })
    const command = this.host.store.settings().executor.prepare.trim()
    // The prepare command runs as the worker would: shim PATH and isolated git config plus the ticket's variables.
    const env = { ...this.host.setup.workerEnv(),
      ...Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value])) }
    // Enforce a timeout so a hung prepare command (such as on a credential prompt) fails the ticket instead of holding a worker slot indefinitely.
    const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])
    if (command) await runAsWorker(['sh', '-c', command], dirname(directory), signal, env)
      .catch(async (error: unknown) => {
        // Remove an empty directory left by a failed prepare command so a later retry does not treat it as already prepared.
        await rmdir(directory).catch(() => { /* Absent, or holding what the command wrote, which the output explains. */ })
        throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    await mkdir(directory, { recursive: true })
    await verifyDirectory(directory, this.host.lifetime)
  }
  /** Enqueues a `launch` effect for an accepted or resumed assignment; launches start in queue order as worker slots free up. */
  start(ticket: Ticket, assignment: Assignment): void {
    this.host.effects.enqueue('launch', assignment.id, { ticketId: ticket.id, assignmentId: assignment.id })
  }
  /** Enqueues a `delivery` effect to steer pending inputs into `ticket`'s running worker session. */
  deliver(ticket: Ticket, _assignment: Assignment): void { this.host.effects.enqueue('delivery', ticket.id, { ticketId: ticket.id }) }
  /** Launches a queued assignment unless its ticket ended or a newer assignment replaced it meanwhile. */
  private async launchQueued({ ticketId, assignmentId }: { ticketId: string; assignmentId: string }): Promise<void> {
    const ticket = this.host.store.tickets.get(ticketId)
    const assignment = ticket && latestAssignment(ticket)
    if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId || assignment.state !== 'pending') return
    this.slots.reserve(ticketId, 'launch')
    try { await this.launch(ticket, assignment); this.transient.delete(`launch:${assignmentId}`) }
    catch (error) {
      // Shutdown or pause re-queues the launch for resume, and transient network/provider errors retry with backoff.
      // A failed prepare command is not retried automatically because an existing directory counts as prepared, so retrying
      // would treat whatever a failed prepare command left behind in the directory as a prepared workspace; instead the
      // ticket is marked failed and waits until new human input or an explicit retry arrives.
      if (this.host.closing() || error instanceof Later) throw error
      if (!(error instanceof PrepareFailed) && this.retries(`launch:${assignmentId}`, error)) throw error
      this.launchFailed(ticketId, assignmentId, error)
    } finally { this.slots.free(ticketId) }
  }
  /**
   * Delivers queued inputs to a running assignment one by one, re-reading ticket state before each delivery so delivery
   * stops immediately if the ticket ended or another assignment took over.
   */
  private async deliverQueued(ticketId: string): Promise<void> {
    const first = this.host.store.tickets.get(ticketId)
    const target = first && liveTicket(first) ? runningAssignment(first) : undefined
    if (!first || !target || !first.undelivered.length) return
    let woken = false
    try {
      for (;;) {
        const ticket = this.host.store.tickets.get(ticketId)
        const assignment = ticket && liveTicket(ticket) ? runningAssignment(ticket) : undefined
        const inputId = ticket?.undelivered[0]
        if (!ticket || !assignment || inputId === undefined) return
        // Waking an idle worker reserves a slot (including the extra slot reserved for human follow-ups).
        if (!woken && !this.running(ticket)) {
          // A person's message wakes its worker ahead of new launches, in the slot kept for it.
          const person = ticket.undelivered.some(id => fromPerson(ticket.inputs.find(item => item.id === id)))
          this.slots.reserve(ticketId, person ? 'person' : 'wake')
          woken = true
        }
        const input = ticket.inputs.find(item => item.id === inputId)
        try {
          if (input) await this.deliverInput(ticket, assignment, input)
        } catch (error) {
          if (this.host.closing() || error instanceof Later) throw error
          const current = this.host.store.tickets.get(ticketId)
          if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) return
          this.host.engine.deliveryFailed(ticketId, assignment.id, String(error))
          throw error
        }
        this.host.engine.inputsDelivered(ticketId, assignment.id, [inputId])
      }
    } finally { if (woken) this.slots.free(ticketId) }
  }
  private async deliverInput(ticket: Ticket, assignment: Assignment, input: TicketInput): Promise<void> {
    // Re-check right before session delivery because the ticket may have ended while awaiting `sourceLink`.
    const live = () => {
      const current = this.host.store.tickets.get(ticket.id)
      if (!current || !liveTicket(current) || runningAssignment(current)?.id !== assignment.id) throw new Error('The ticket ended or another Assignment took it over')
    }
    live()
    const trigger = input.kind === 'trigger' ? await this.triggerCard(ticket, input.triggerId, input.note) : undefined
    const message = inputMessage(input, trigger)
    if (message === undefined) return
    const text = message.length > ASSIGNMENT_CHARS ? JSON.stringify(capped(message, ASSIGNMENT_CHARS, inputResource(ticket.id, input.id))) : message
    await this.host.sessions.prompt(workerSessionId(ticket.id), input.id, text, 'steer', live)
  }
  /** Formats a trigger on `ticket` for the worker, including a preview of the replied-to message when the worker has not yet seen it. */
  private async triggerCard(ticket: Ticket, triggerId: string, note?: string): Promise<object | undefined> {
    const trigger = this.host.store.triggers.get(triggerId)
    if (!trigger) return undefined
    const parent = this.host.repliedTo(trigger)
    const seen = parent && (parent.id === ticket.origin.triggerId || ticket.inputs.some(item => item.kind === 'trigger' && item.triggerId === parent.id))
    return triggerMessage(trigger, await this.host.sourceLink(trigger), note, seen ? undefined : parent)
  }
  /**
   * After the ending transaction commits (so a rollback leaves the worker working, and a launch the same transaction queued
   * starts after it): ends the look at its background work and any park, then closes its session, interrupting its turn
   * unless its last word was a `ready` or `dropped` report with no Input delivered since.
   */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    void reason
    this.transient.delete(assignment.id); this.transient.delete(`launch:${assignment.id}`)
    const report = assignment.report
    const busy = !!assignment.deliveredAt && !!report && assignment.deliveredAt >= report.at
    const ownTurn = (report?.state === 'ready' || report?.state === 'dropped') && !busy
    const sessionId = workerSessionId(ticket.id)
    this.host.store.afterCommit(() => {
      this.settling.get(ticket.id)?.abort()
      this.parking.get(ticket.id)?.abort()
      void this.background(this.host.sessions.close(sessionId, { abort: !ownTurn }))
    })
  }
  /** Number of open tickets whose worker holds a worker slot: its turn runs, or its background work still runs after its turn ended. */
  activeCount(): number { return this.host.store.tickets.open().filter(ticket => this.running(ticket)).length }
  /** Whether a ticket's worker holds a worker slot: its turn runs, or its background work does after its turn ended. A parked (handed-off) worker holds none. */
  private running(ticket: Ticket): boolean {
    if (!runningAssignment(ticket) || this.parking.has(ticket.id)) return false
    const state = this.host.sessions.state(workerSessionId(ticket.id))
    return state === 'starting' || state === 'running' || state === 'settling' || this.settling.has(ticket.id)
  }
  /** Marks a ticket failed after its launch fails; the ticket waits until new human input or an explicit retry arrives. */
  private launchFailed(ticketId: string, assignmentId: string, error: unknown): void {
    const ticket = this.host.store.tickets.get(ticketId)
    if (!ticket || !liveTicket(ticket) || latestAssignment(ticket)?.id !== assignmentId) return
    this.failed(ticketId, String(error))
  }
  /** Records a `failed` report on the ticket and relays the failure to the main Session in one transaction. */
  private failed(ticketId: string, summary: string): void {
    this.host.store.atomic(() => {
      const updated = this.host.engine.report(ticketId, { state: 'failed', summary })
      this.relay(resultRelay(updated, 'failed', summary))
    })
  }
  private relay({ id, text }: { id: string; text: string }): void { this.host.sessions.relay(id, text) }
  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const current = () => {
      if (this.host.closing()) throw new Error('Superagent is stopping')
      if (this.host.paused()) throw new Later('Processing is paused')
      const stored = this.host.store.tickets.get(ticket.id)
      return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
    }
    const source = sourceTrigger(this.host, ticket)
    const workspace = ticket.execution?.directory ?? ''
    if (!current()) return
    // Prepare the workspace directory once; an existing directory counts as already prepared, including worktrees created before `prepare` commands existed.
    if (!await stat(workspace).then(() => true, () => false)) {
      await this.prepareDirectory(ticket)
      if (!current()) return
    }
    if (!current()) return
    const sessionId = workerSessionId(ticket.id)
    await this.host.sessions.ensure(sessionId, workspace, ticket.title, 'worker')
    if (!current()) return
    // The first message holds the assignment and the source Trigger; a later Assignment's says only what is new, unless the
    // Session lost the first, such as when someone deleted it.
    const first = `assignment:${ticket.id}`
    const later = ticket.assignments.length > 1
    const told = later && this.host.sessions.holds(sessionId, first)
    if (!current()) return
    const retried = ticket.assignments.at(-2)?.endedReason === 'retried' ? { note: RETRIED } : {}
    const assignmentText = ticket.execution?.assignment ?? ''
    const { text: brief, chars, read } = capped(assignmentText, ASSIGNMENT_CHARS, `ticket/${ticket.id}/assignment`)
    const card = told || !source ? undefined : await this.triggerCard(ticket, source.id)
    if (!current()) return
    const batch = told ? [] : batchOf(this.host, ticket).map(batchLine)
    const text = told ? JSON.stringify({ ticket_id: ticket.id, assignment: ticket.assignments.length, ...retried })
      : JSON.stringify({ ticket_id: ticket.id, title: ticket.title, ...(brief ? { assignment: brief } : {}),
        ...(read ? { assignment_chars: chars, assignment_read: read } : {}), ...(card ? { trigger: card } : {}),
        ...(batch.length ? { batch } : {}), ...retried })
    const requestId = later ? `assignment:${ticket.id}:${assignment.id}` : first
    await this.host.sessions.prompt(sessionId, requestId, text, 'queue',
      () => { if (!current()) throw new Error('Launch authorization changed before worker delivery') },
      () => { this.host.engine.assignmentStarted(ticket.id, assignment.id) })
    this.host.engine.assignmentStarted(ticket.id, assignment.id)
  }
  /** Subscribes to worker session events from OmpSessions. Call once at startup. */
  install(): void {
    this.disposers.push(this.host.sessions.onSessionEvent(event => { this.onEvent(event) }))
  }
  private onEvent(event: SessionEvent): void {
    const ticketId = ticketOfSession(event.sessionId)
    if (ticketId === undefined || this.host.closing()) return
    if (event.type === 'started') {
      // A turn that starts ends the look at its worker's background work and any park; the turn's own yield looks afresh.
      this.settling.get(ticketId)?.abort()
      this.parking.get(ticketId)?.abort()
      this.failureSeen.delete(ticketId)
      return
    }
    if (event.type === 'yielded') {
      const ticket = this.host.store.tickets.get(ticketId)
      const assignment = ticket && runningAssignment(ticket)
      if (ticket && assignment && liveTicket(ticket)) void this.background(this.workerYielded(ticket, assignment))
      return
    }
    if (event.type === 'userMessage') {
      // The Inputs a message of Superagent's carries, which its worker reads once the Session took the message into its
      // history: a turn that ends before may drop it.
      void this.background(Promise.resolve().then(() => {
        const read = this.host.store.tickets.get(ticketId)?.inputs.filter(input => input.kind === 'trigger' && !input.readAt
          && this.host.sessions.promptedId(input.id) === event.key).map(input => input.id) ?? []
        if (read.length) this.host.engine.inputsRead(ticketId, read)
      }))
      return
    }
    if (event.type === 'failed') {
      // One turn may fail repeatedly (such as across auto-retries); only the first failure of the turn resumes or fails it.
      if (this.failureSeen.has(ticketId)) return
      this.failureSeen.add(ticketId)
      const ticket = this.host.store.tickets.get(ticketId)
      const assignment = ticket && runningAssignment(ticket)
      if (!ticket || !assignment || !liveTicket(ticket)) return
      const error = Object.assign(new Error(event.message), { status: event.httpStatus, code: event.code })
      if (this.retries(assignment.id, error)) { this.resumeAfter(ticket.id, assignment.id, error); return }
      void this.background(Promise.resolve().then(() => { this.failed(ticket.id, String(error)) }))
      return
    }
    if (event.type === 'exited' && !event.expected) {
      // An unexpected exit interrupts the running assignment; core restarts it with a recovery note, or leaves its inputs for the next one.
      const ticket = this.host.store.tickets.get(ticketId)
      const assignment = ticket && runningAssignment(ticket)
      if (ticket && assignment && liveTicket(ticket)) this.host.engine.assignmentInterrupted(ticket.id, assignment.id)
    }
  }
  /**
   * Reconciles running and pending assignments across open tickets after a host restart: notifies Engine of interrupted
   * running assignments and re-queues pending launches (which earlier versions may have kept outside the effect queue),
   * while failed launches (`waitsForPerson`) wait for a person's message or a retry.
   */
  resume(): void {
    // Launch pending tickets oldest first (in acceptance order).
    for (const ticket of this.host.store.tickets.open().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const running = runningAssignment(ticket), latest = latestAssignment(ticket)
      if (running) this.host.engine.assignmentInterrupted(ticket.id, running.id)
      else if (latest?.state === 'pending' && !waitsForPerson(ticket)) this.start(ticket, latest)
    }
  }
  /** Runs background worker event handling and updates the `worker` health entry on failure or recovery. */
  private background(work: Promise<void>): Promise<void> {
    const { health } = this.host
    return work.then(() => { if (health.get()?.state === 'error') health.set({ state: 'ready', detail: 'Worker events are handled', at: now() }) },
      (error: unknown) => { health.set({ state: 'error', detail: String(error), at: now() }) })
  }
  /**
   * Checks whether `error` is a transient failure with retry attempts remaining under `key`, mutating `this.transient`:
   * increments the attempt counter and returns `true` when retrying, or deletes `key` from `this.transient` and returns `false` when non-transient or out of tries.
   */
  private retries(key: string, error: unknown): boolean {
    const tries = this.transient.get(key) ?? 0
    if (!transient(error) || tries >= TRANSIENT_TRIES) { this.transient.delete(key); return false }
    this.transient.set(key, tries + 1)
    return true
  }
  /** Schedules a worker turn retry with exponential backoff after a transient provider or network error. */
  private resumeAfter(ticketId: string, assignmentId: string, error: unknown): void {
    const tries = this.transient.get(assignmentId)!
    const text = `Your last turn failed for a passing reason (${String(error).slice(0, 200)}). Continue the assignment where it stopped.`
    this.resuming.add(assignmentId)
    const go = () => {
      if (this.host.closing()) return
      const ticket = this.host.store.tickets.get(ticketId)
      if (!ticket || !liveTicket(ticket) || runningAssignment(ticket)?.id !== assignmentId) { this.resuming.delete(assignmentId); return }
      // Wait while processing is paused or no wake slot is free.
      if (this.host.paused()) { this.after(SLOT_WAIT_MS, go); return }
      const sessionId = workerSessionId(ticketId)
      const waking = !this.running(ticket)
      try { if (waking) this.slots.reserve(ticketId, 'wake') } catch (failure) {
        if (!(failure instanceof Later)) throw failure
        this.after(SLOT_WAIT_MS, go); return
      }
      const sent = this.host.sessions.prompt(sessionId, `retry:${assignmentId}:${tries}`, text, 'queue')
      void this.background(sent.finally(() => { if (waking) this.slots.free(ticketId); this.resuming.delete(assignmentId) })
        .catch(failure => { this.failed(ticketId, String(failure)) }))
    }
    this.after(TRANSIENT_BACKOFF_MS * 2 ** (tries - 1), go)
  }
  /** Schedules `then` to run after `ms` milliseconds unless `dispose()` is called first. */
  private after(ms: number, then: () => void): void {
    const timer = setTimeout(() => { this.timers.delete(timer); then() }, ms)
    timer.unref?.()
    this.timers.add(timer)
  }
  /** Waits for one worker session's `settled` event, or false once `signal` aborts first. */
  private settled(sessionId: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
    const { promise, resolve } = Promise.withResolvers<boolean>()
    const stop = this.host.sessions.onSessionEvent(event => {
      if (event.sessionId !== sessionId) return
      if (event.type === 'settled' || (event.type === 'exited' && event.expected)) { stop(); resolve(true) }
    })
    signal.addEventListener('abort', () => { stop(); resolve(false) }, { once: true })
    return promise
  }
  /**
   * A worker that handed off frees its slot at once; its session is closed once it settles (or after the background
   * limit), ending its background bash and subagents with it. The park holds no slot.
   */
  private async park(ticketId: string): Promise<void> {
    const sessionId = workerSessionId(ticketId)
    this.parking.get(ticketId)?.abort()
    const parked = new AbortController()
    this.parking.set(ticketId, parked)
    let expired = false
    const timer = setTimeout(() => { expired = true; parked.abort() }, BACKGROUND_LIMIT_MS)
    timer.unref?.()
    try {
      const settled = await this.settled(sessionId, AbortSignal.any([this.host.lifetime, parked.signal]))
      // A new turn (`started`), a stop, or dispose aborts the park without closing; only a settle or the limit does.
      if (!settled && !expired) return
    } finally { clearTimeout(timer); if (this.parking.get(ticketId) === parked) this.parking.delete(ticketId) }
    await this.host.sessions.close(sessionId, { abort: true })
  }
  private async workerYielded(ticket: Ticket, idle: Assignment): Promise<void> {
    // A turn that failed for a passing reason goes on after its backoff, which is no end of the turn.
    if (this.resuming.has(idle.id)) return
    // A turn that ended as turns do starts the count of passing failures again.
    this.transient.delete(idle.id)
    // The ticket while the Assignment that yielded runs it.
    const live = () => {
      const stored = this.host.store.tickets.get(ticket.id)
      return stored && liveTicket(stored) && runningAssignment(stored)?.id === idle.id ? stored : undefined
    }
    // A worker whose last word was its result, a question for a person, or a blocked or failed report handed off to a person;
    // an Input delivered after its result or question is new work.
    const handedOff = (stored: Ticket) => {
      const assignment = runningAssignment(stored), report = assignment?.report
      const since = !!assignment?.deliveredAt && !!report && assignment.deliveredAt >= report.at
      return ((report?.state === 'ready' || !!stored.attention) && !since) || waitsForPerson(stored)
    }
    const before = live()
    if (!before || this.host.closing()) return
    // The worker read what reached it before a turn that ended handed off.
    if (handedOff(before)) {
      this.host.engine.turnEnded(ticket.id, idle.id)
      await this.park(ticket.id)
      return
    }
    // Its turn ends once nothing runs for it in the background, which holds its slot meanwhile: at most for the limit from
    // this yield, and until the worker runs again or the Assignment ends.
    this.settling.get(ticket.id)?.abort()
    const look = new AbortController(), limit = new AbortController()
    this.settling.set(ticket.id, look)
    const timer = setTimeout(() => { limit.abort() }, BACKGROUND_LIMIT_MS)
    timer.unref?.()
    let quiet: boolean
    try { quiet = await this.settled(workerSessionId(ticket.id), AbortSignal.any([this.host.lifetime, look.signal, limit.signal])) }
    finally { clearTimeout(timer); if (this.settling.get(ticket.id) === look) this.settling.delete(ticket.id) }
    const current = live()
    if (this.host.closing() || look.signal.aborted || (!quiet && !limit.signal.aborted) || !current || this.resuming.has(idle.id)) return
    const sessionId = workerSessionId(ticket.id)
    const text = (await this.host.sessions.lastAssistantText(sessionId).catch(() => '')).trim()
    if (quiet) this.host.engine.turnEnded(ticket.id, idle.id)
    let stopped = ''
    if (!quiet) {
      // Its background work that ran past the limit is stopped with the session, which it is told at its next turn.
      await this.host.sessions.close(sessionId, { abort: true })
      const note = `Your background work ran ${BACKGROUND_LIMIT_MS / 60_000} minutes after your turn ended and was stopped with the session.`
      void this.background(this.host.sessions.prompt(sessionId, `killed:${idle.id}`, note, { inject: 'Background work stopped' }))
      stopped = `Background work ran ${BACKGROUND_LIMIT_MS / 60_000} minutes after the worker's turn ended and was stopped.`
    }
    // The worker may have reported while its turn ended; a blocked or failed report a person's message has lifted is stale.
    if (handedOff(current)) return
    const said = [text, stopped].filter(Boolean).join('\n\n')
    this.host.store.atomic(() => {
      const before = latestReport(current)?.summary ?? ''
      const updated = this.host.engine.report(ticket.id, { state: 'waiting', summary: said || before })
      // A quiet final after orchestrator_report is not a new status or an empty handoff.
      if (said) this.relay(resultRelay(updated, 'waiting', said))
      else if (!before.trim()) {
        this.relay(resultRelay(updated, 'waiting', 'Worker ended without a status report. Use orchestrator_ticket_request_status to request one.'))
      }
    })
    if (quiet) await this.host.sessions.close(sessionId, { abort: false })
  }
  /** Unsubscribes from session events, aborts outstanding settling/parking waits, and clears pending transient-retry timers. */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    for (const [, look] of this.settling) look.abort()
    this.settling.clear()
    for (const [, parked] of this.parking) parked.abort()
    this.parking.clear()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
}
