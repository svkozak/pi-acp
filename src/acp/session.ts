import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  PermissionOption,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import type { BackgroundJob, BackgroundMessage } from '../pi-rpc/background-protocol.js'
import {
  PiRpcProcess,
  PiRpcSpawnError,
  SESSION_STATS_TIMEOUT_MS,
  type PiRpcEvent,
  type PiSessionStats
} from '../pi-rpc/process.js'
import { toPromptError } from './prompt-error.js'
import { maybeAuthRequiredError } from './auth-required.js'
import { SessionStore } from './session-store.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import {
  bashCommand,
  bashExitCode,
  bashOutputDelta,
  bashResultText,
  bashTerminalContent,
  bashTerminalExitMeta,
  bashTerminalInfoMeta,
  bashTerminalOutputMeta,
  isBashTool
} from './translate/bash.js'
import { toolResultToText } from './translate/pi-tools.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
}

export type StopReason = 'end_turn' | 'cancelled'

type PendingTurn = {
  error?: Error
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  message: string
  images: unknown[]
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type PermissionResponse = Awaited<ReturnType<AgentSideConnection['requestPermission']>>

const CONFIRM_PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no', name: 'No', kind: 'reject_once' }
]
const EXTENSION_UI_RAW_INPUT_KEYS = ['title', 'message', 'options', 'placeholder', 'prefill'] as const
const CHOICE_OPTION_PREFIX = 'choice-'

/**
 * Map pi's `stats.contextUsage` to an ACP `usage_update`. Returns null whenever pi
 * reports no trustworthy token count (e.g. `tokens: null` right after compaction) or
 * the values are not usable integers.
 */
function toUsageUpdate(stats: PiSessionStats | null | undefined): SessionUpdate | null {
  const used = stats?.contextUsage?.tokens
  const size = stats?.contextUsage?.contextWindow

  if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0) return null
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null

  return { sessionUpdate: 'usage_update', used, size }
}

function findUniqueLineNumber(text: string, needle: string): number | undefined {
  if (!needle) return undefined

  const first = text.indexOf(needle)
  if (first < 0) return undefined

  const second = text.indexOf(needle, first + needle.length)
  if (second >= 0) return undefined

  let line = 1
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

function getToolPath(args: unknown): string | undefined {
  const record = args as { path?: unknown; file_path?: unknown } | null | undefined
  if (typeof record?.path === 'string') return record.path
  if (typeof record?.file_path === 'string') return record.file_path
  return undefined
}

// Match pi's current edit schema: { path, edits: [{ oldText, newText }] }, with
// legacy top-level oldText/newText still accepted. Pi also normalizes stringified edits.
// https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/core/tools/edit.ts
function getParsedEdits(args: unknown): Array<{ oldText: string; newText: string }> {
  const record = args as { oldText?: unknown; newText?: unknown; edits?: unknown } | null | undefined
  const parsed: Array<{ oldText: string; newText: string }> = []

  if (typeof record?.oldText === 'string' && typeof record?.newText === 'string') {
    parsed.push({ oldText: record.oldText, newText: record.newText })
  }

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const item = edit as { oldText?: unknown; newText?: unknown } | null | undefined
      if (typeof item?.oldText === 'string' && typeof item?.newText === 'string') {
        parsed.push({ oldText: item.oldText, newText: item.newText })
      }
    }
  }

  return parsed
}

function getEditOldTexts(args: unknown): string[] {
  const record = args as { oldText?: unknown; edits?: unknown } | null | undefined
  const oldTexts = getParsedEdits(args).map(edit => edit.oldText)

  if (typeof record?.oldText === 'string' && !oldTexts.includes(record.oldText)) oldTexts.push(record.oldText)

  let edits = record?.edits
  if (typeof edits === 'string') {
    try {
      edits = JSON.parse(edits) as unknown
    } catch {
      edits = undefined
    }
  }

  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const oldText = (edit as { oldText?: unknown } | null | undefined)?.oldText
      if (typeof oldText === 'string' && !oldTexts.includes(oldText)) oldTexts.push(oldText)
    }
  }

  return oldTexts
}

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store = new SessionStore()

  /** Dispose all sessions and their underlying pi subprocesses. */
  async disposeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.close(id)))
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  async close(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    try {
      await session.dispose()
    } finally {
      if (this.sessions.get(sessionId) === session) this.sessions.delete(sessionId)
    }
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    let proc: PiRpcProcess
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand
      })
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError.internalError({ code: e.code }, e.message)
      }
      throw e
    }

    let state: any = null
    try {
      state = (await proc.getState()) as any
    } catch {
      state = null
    }

    const sessionId = typeof state?.sessionId === 'string' ? state.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? []
    })

    this.sessions.set(sessionId, session)
    return session
  }

  get(sessionId: string): PiAcpSession {
    const s = this.sessions.get(sessionId)
    if (!s) throw RequestError.invalidParams(`Unknown sessionId: ${sessionId}`)
    return s
  }

  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId: string, params: SessionCreateParams & { proc: PiRpcProcess }): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? []
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private startupInfo: string | null = null
  private startupInfoSent = false

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection
  private readonly fileCommands: FileSlashCommand[]

  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  private cancelRequested = false

  // Current in-flight turn (if any). Additional prompts are queued.
  private pendingTurn: PendingTurn | null = null
  private terminalError: Error | undefined
  private disposed = false
  private disposal: Promise<void> | undefined
  private unsubscribe: () => void = () => {}
  private unsubscribeExit: () => void = () => {}
  private parentSettled = false
  private backgroundIdle = true
  private backgroundSeen = false
  private cancellationPending = false
  private failingPrompt = false
  private activityRevision = 0
  private readonly backgroundJobs = new Map<string, BackgroundJob>()
  private readonly completedBackgroundJobs = new Set<string>()
  private readonly turnQueue: QueuedTurn[] = []
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  private currentToolCalls = new Map<string, 'pending' | 'in_progress'>()

  // pi can emit multiple `turn_end` and `agent_end` events for a single user prompt
  // when retry, compaction, or queued continuations run. The session-level prompt
  // completes only when `agent_settled` is emitted.
  private inAgentLoop = false

  // For ACP diff support: capture file contents before edit/write mutations,
  // then emit ToolCallContent {type:"diff"}. Compatible structured edit/write
  // events may need to be implemented in pi in the future.
  private fileSnapshots = new Map<string, { path: string; oldText: string | null }>()
  private fileMutationToolCallIds = new Set<string>()
  private bashToolCallIds = new Set<string>()
  private bashOutputSnapshots = new Map<string, string>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []

    this.unsubscribe = this.proc.onEvent(ev => this.handlePiEvent(ev))
    this.unsubscribeExit = this.proc.onExit?.(error => this.failOperation(error)) ?? (() => {})
  }

  dispose(): Promise<void> {
    return (this.disposal ??= this.disposeSession())
  }

  private async disposeSession(): Promise<void> {
    if (this.disposed) return
    this.cancelRequested = true
    this.cancellationPending = true
    ++this.activityRevision
    try {
      await this.proc.dispose?.()
      const turns = [...(this.pendingTurn ? [this.pendingTurn] : []), ...this.turnQueue.splice(0)]
      this.pendingTurn = null
      await this.flushEmits()
      for (const turn of turns) turn.resolve('cancelled')
    } catch (error) {
      this.failOperation(error instanceof Error ? error : new Error(String(error)))
      throw error
    } finally {
      this.disposed = true
      this.unsubscribe()
      this.unsubscribeExit()
    }
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
    this.startupInfoSent = false
  }

  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending(): void {
    if (this.startupInfoSent || !this.startupInfo) return
    this.startupInfoSent = true

    this.emit({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: this.startupInfo }
    })
  }

  async prompt(message: string, images: unknown[] = []): Promise<StopReason> {
    if (this.terminalError) throw this.terminalError
    if (this.disposed || this.disposal) throw RequestError.invalidParams(`Session is closed: ${this.sessionId}`)
    // pi RPC mode disables slash command expansion, so we do it here.
    const expandedMessage = expandSlashCommand(message, this.fileCommands)

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      const queued: QueuedTurn = { message: expandedMessage, images, resolve, reject }

      // If a turn is already running, enqueue.
      if (this.pendingTurn) {
        this.turnQueue.push(queued)

        // Best-effort: notify client that a prompt was queued.
        // This doesn't work in Zed yet, needs to be revisited
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        })

        // Also publish queue depth via session info metadata.
        // This also not visible in the client
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        })

        return
      }

      // No turn is running; start immediately.
      this.startTurn(queued)
    })

    return turnPromise
  }

  async cancel(): Promise<void> {
    // Cancel current and clear any queued prompts.
    this.cancelRequested = true
    this.cancellationPending = this.backgroundSeen || this.proc.backgroundLifecycleEnabled
    ++this.activityRevision

    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length)
      for (const t of queued) t.resolve('cancelled')

      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Cleared queued prompts.' }
      })
      this.emit({
        sessionUpdate: 'session_info_update',
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      })
    }

    // Abort the currently running turn (if any). If nothing is running, this is a no-op.
    const pendingTurn = this.pendingTurn
    try {
      await this.proc.abort()
    } catch (error) {
      this.failOperation(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
    if (this.pendingTurn !== pendingTurn || this.terminalError) return
    this.cancellationPending = false
    this.finishIfSettled()
  }

  private emit(update: SessionUpdate, isCurrent: () => boolean = () => true): void {
    if (this.disposed) return
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.disposed || !isCurrent()
          ? undefined
          : this.conn.sessionUpdate({
              sessionId: this.sessionId,
              update
            })
      )
      .catch(() => {
        // Ignore notification errors (client may have gone away). We still want
        // prompt completion.
      })
  }

  private async flushEmits(): Promise<void> {
    await this.lastEmit
  }

  async publishContextUsage(isCurrent: () => boolean = () => true): Promise<void> {
    try {
      if (typeof this.proc.getSessionStats === 'function') {
        const update = toUsageUpdate(await this.proc.getSessionStats(SESSION_STATS_TIMEOUT_MS))
        if (update) this.emit(update, isCurrent)
      }
    } catch {
      // Context usage is auxiliary and must not fail the turn.
    }

    await this.flushEmits()
  }

  private emitRunningStatus(running: boolean, isCurrent: () => boolean = () => true): void {
    this.emit(
      { sessionUpdate: 'session_info_update', _meta: { piAcp: { queueDepth: this.turnQueue.length, running } } },
      isCurrent
    )
  }

  private emitBashToolCall(params: {
    sessionUpdate: 'tool_call' | 'tool_call_update'
    toolCallId: string
    toolName: string
    args: unknown
    status: 'pending' | 'in_progress'
    locations?: ToolCallLocation[]
    includeTerminal: boolean
  }): void {
    this.bashToolCallIds.add(params.toolCallId)
    this.emit({
      sessionUpdate: params.sessionUpdate,
      toolCallId: params.toolCallId,
      title: bashCommand(params.args) ?? params.toolName,
      kind: 'execute',
      status: params.status,
      locations: params.locations,
      ...(params.includeTerminal ? { content: bashTerminalContent(params.toolCallId) } : {}),
      ...(params.includeTerminal ? { _meta: bashTerminalInfoMeta(params.toolCallId, this.cwd) } : {})
    })
  }

  private emitBashOutputUpdate(params: {
    toolCallId: string
    status: 'in_progress' | 'completed' | 'failed'
    result: unknown
    isError?: boolean
  }): void {
    const text = bashResultText(params.result)
    const previous = this.bashOutputSnapshots.get(params.toolCallId) ?? ''
    const delta = bashOutputDelta(previous, text)
    this.bashOutputSnapshots.set(params.toolCallId, text)

    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: params.toolCallId,
      status: params.status,
      _meta: {
        ...(delta ? bashTerminalOutputMeta(params.toolCallId, delta) : {}),
        ...(params.status === 'completed' || params.status === 'failed'
          ? bashTerminalExitMeta(params.toolCallId, bashExitCode(params.result, Boolean(params.isError)))
          : {})
      }
    })
  }

  private cleanupToolCall(toolCallId: string): void {
    this.currentToolCalls.delete(toolCallId)
    this.fileSnapshots.delete(toolCallId)
    this.fileMutationToolCallIds.delete(toolCallId)
    this.bashToolCallIds.delete(toolCallId)
    this.bashOutputSnapshots.delete(toolCallId)
  }

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false
    this.parentSettled = false
    this.backgroundIdle = true
    this.backgroundSeen = false
    this.cancellationPending = false
    this.failingPrompt = false
    ++this.activityRevision

    this.pendingTurn = { resolve: t.resolve, reject: t.reject }
    const pendingTurn = this.pendingTurn

    // Publish queue depth (0 because we're starting the turn now).
    this.emitRunningStatus(true)

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // The prompt RPC only acknowledges acceptance; retry, compaction, or queued
    // continuations may emit multiple `agent_end` events before `agent_settled`.
    this.proc.prompt(t.message, t.images).catch(err => {
      if (this.disposed || this.disposal || this.pendingTurn !== pendingTurn || this.terminalError) return
      void this.failPrompt(maybeAuthRequiredError(err) ?? toPromptError(err))
    })
  }

  private failOperation(error: Error): void {
    if (this.disposed || this.terminalError) return
    this.terminalError = maybeAuthRequiredError(error) ?? toPromptError(error)
    ++this.activityRevision
    const turns = [...(this.pendingTurn ? [this.pendingTurn] : []), ...this.turnQueue.splice(0)]
    this.pendingTurn = null
    for (const job of this.backgroundJobs.values()) this.finishBackgroundJob(job.id, 'failed', error.message)
    this.emit({ sessionUpdate: 'session_info_update', _meta: { piAcp: { queueDepth: 0, running: false } } })
    const delivered = this.flushEmits()
    for (const turn of turns) void delivered.then(() => turn.reject(this.terminalError))
  }

  private finishBackgroundJob(id: string, status: 'completed' | 'failed', text?: string): void {
    if (!this.backgroundJobs.delete(id)) return
    this.completedBackgroundJobs.add(id)
    this.emit({
      sessionUpdate: 'tool_call_update',
      toolCallId: `background:${id}`,
      status,
      ...(text ? { content: [{ type: 'content', content: { type: 'text', text } }] } : {})
    })
  }

  private updateBackground(message: Extract<BackgroundMessage, { type: 'snapshot' }>): void {
    ++this.activityRevision
    if (this.pendingTurn && (!message.idle || message.active.length)) this.emitRunningStatus(true)
    this.backgroundIdle = message.idle
    for (const job of message.active) {
      if (this.backgroundJobs.has(job.id) || this.completedBackgroundJobs.has(job.id)) continue
      this.backgroundSeen = true
      this.backgroundJobs.set(job.id, job)
      this.emit({
        sessionUpdate: 'tool_call',
        toolCallId: `background:${job.id}`,
        title: job.title,
        kind: 'other',
        status: 'in_progress'
      })
    }
    if (message.finished) {
      if (this.backgroundJobs.has(message.finished.id)) {
        this.finishBackgroundJob(message.finished.id, message.finished.status, message.finished.text)
      } else if (!this.completedBackgroundJobs.has(message.finished.id)) {
        this.backgroundSeen = true
        this.completedBackgroundJobs.add(message.finished.id)
        this.emit({
          sessionUpdate: 'tool_call',
          toolCallId: `background:${message.finished.id}`,
          title: message.finished.title,
          kind: 'other',
          status: message.finished.status,
          ...(message.finished.text
            ? { content: [{ type: 'content', content: { type: 'text', text: message.finished.text } }] }
            : {})
        })
      }
    }
    this.finishIfSettled()
  }

  private finishIfSettled(): void {
    const pendingTurn = this.pendingTurn
    if (
      pendingTurn &&
      this.parentSettled &&
      pendingTurn.error &&
      !this.cancelRequested &&
      !this.failingPrompt &&
      !this.disposal
    ) {
      void this.failPrompt(pendingTurn.error)
      return
    }
    const revision = this.activityRevision
    const canFinish = () =>
      this.pendingTurn === pendingTurn &&
      this.activityRevision === revision &&
      !this.disposal &&
      !this.terminalError &&
      !this.failingPrompt &&
      !this.cancellationPending &&
      this.parentSettled &&
      this.backgroundIdle &&
      this.backgroundJobs.size === 0
    if (!pendingTurn || !canFinish()) return
    void this.flushEmits().then(async () => {
      if (!canFinish()) return
      const reason: StopReason = this.cancelRequested ? 'cancelled' : 'end_turn'
      if (!this.cancelRequested || !this.proc.backgroundLifecycleEnabled) await this.publishContextUsage(canFinish)
      if (!canFinish()) return
      this.emitRunningStatus(false, canFinish)
      await this.flushEmits()
      if (!canFinish()) return
      this.pendingTurn = null
      this.inAgentLoop = false
      pendingTurn.resolve(reason)
      const next = this.turnQueue.shift()
      if (next) this.startTurn(next)
    })
  }

  private async failPrompt(error: Error): Promise<void> {
    const pendingTurn = this.pendingTurn
    if (!pendingTurn || this.failingPrompt) return
    this.failingPrompt = true
    ++this.activityRevision
    try {
      if (this.backgroundSeen || this.proc.backgroundLifecycleEnabled) await this.proc.abort()
    } catch (failure) {
      this.failOperation(new Error(`${error.message}; cleanup failed: ${String(failure)}`))
      return
    }
    if (this.pendingTurn !== pendingTurn || this.terminalError) return
    this.emit({ sessionUpdate: 'session_info_update', _meta: { piAcp: { queueDepth: 0, running: false } } })
    await this.flushEmits()
    if (this.pendingTurn !== pendingTurn || this.terminalError) return
    const queued = this.turnQueue.splice(0)
    this.pendingTurn = null
    this.inAgentLoop = false
    for (const turn of [pendingTurn, ...queued]) {
      if (this.cancelRequested) turn.resolve('cancelled')
      else turn.reject(error)
    }
  }

  private handlePiEvent(ev: PiRpcEvent) {
    if (this.disposed || this.terminalError) return
    const type = String((ev as any).type ?? '')

    switch (type) {
      case 'message_end': {
        const message = ev.message
        if (
          !this.pendingTurn ||
          !message ||
          typeof message !== 'object' ||
          !('role' in message) ||
          message.role !== 'assistant'
        )
          break
        const reason = stringProp(message, 'stopReason')
        if (reason === 'error') this.pendingTurn.error = toPromptError(stringProp(message, 'errorMessage'))
        else if (reason === 'aborted') this.cancelRequested = true
        else if (reason) this.pendingTurn.error = undefined
        break
      }

      case 'background_work': {
        this.updateBackground(ev as unknown as Extract<BackgroundMessage, { type: 'snapshot' }>)
        break
      }
      case 'background_cancelled': {
        for (const job of this.backgroundJobs.values()) this.finishBackgroundJob(job.id, 'failed', 'Cancelled')
        this.cancellationPending = false
        this.parentSettled = true
        this.backgroundIdle = true
        ++this.activityRevision
        this.finishIfSettled()
        break
      }
      case 'process_error': {
        this.failOperation(new Error(stringProp(ev, 'message') ?? 'pi process failed'))
        break
      }
      case 'message_update': {
        const ame = (ev as any).assistantMessageEvent

        // Stream assistant text.
        if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        if (ame?.type === 'thinking_delta' && typeof ame.delta === 'string') {
          this.emit({
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: ame.delta } satisfies ContentBlock
          })
          break
        }

        // Surface tool calls ASAP so clients (e.g. Zed) can show a tool-in-use/loading UI
        // while the model is still streaming tool call args.
        if (ame?.type === 'toolcall_start' || ame?.type === 'toolcall_delta' || ame?.type === 'toolcall_end') {
          const toolCall =
            // pi sometimes includes the tool call directly on the event
            (ame as any)?.toolCall ??
            // ...and always includes it in the partial assistant message at contentIndex
            (ame as any)?.partial?.content?.[(ame as any)?.contentIndex ?? 0]

          const toolCallId = String((toolCall as any)?.id ?? '')
          const toolName = String((toolCall as any)?.name ?? 'tool')

          if (toolCallId) {
            const rawInput =
              (toolCall as any)?.arguments && typeof (toolCall as any).arguments === 'object'
                ? (toolCall as any).arguments
                : (() => {
                    const s = String((toolCall as any)?.partialArgs ?? '')
                    if (!s) return undefined
                    try {
                      return JSON.parse(s)
                    } catch {
                      return { partialArgs: s }
                    }
                  })()

            const locations = toToolCallLocations(rawInput, this.cwd)
            const existingStatus = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existingStatus ?? 'pending'

            if (isBashTool(toolName)) {
              if (!existingStatus) this.currentToolCalls.set(toolCallId, 'pending')
              this.emitBashToolCall({
                sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
                toolCallId,
                toolName,
                args: rawInput,
                status,
                locations,
                includeTerminal: !existingStatus
              })
            } else if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, 'pending')
              this.emit({
                sessionUpdate: 'tool_call',
                toolCallId,
                title: toolName,
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput
              })
            } else {
              // Best-effort: keep rawInput updated while args are streaming.
              // Keep the existing status (pending or in_progress).
              this.emit({
                sessionUpdate: 'tool_call_update',
                toolCallId,
                status,
                locations,
                rawInput
              })
            }
          }

          break
        }

        // Ignore other delta/event types for now.
        break
      }

      case 'tool_execution_start': {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? 'tool')
        const args = (ev as any).args
        let line: number | undefined

        if (isBashTool(toolName)) {
          const locations = toToolCallLocations(args, this.cwd)
          const existingStatus = this.currentToolCalls.get(toolCallId)
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emitBashToolCall({
            sessionUpdate: existingStatus ? 'tool_call_update' : 'tool_call',
            toolCallId,
            toolName,
            args,
            status: 'in_progress',
            locations,
            includeTerminal: !existingStatus
          })
          break
        }

        // Capture pre-mutation file contents so we can emit a structured ACP diff.
        const isFileMutation = toolName === 'edit' || toolName === 'write'
        let snapshotOldText: string | null | undefined
        if (isFileMutation) {
          this.fileMutationToolCallIds.add(toolCallId)
          const p = getToolPath(args)
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
              snapshotOldText = readFileSync(abs, 'utf8')
              this.fileSnapshots.set(toolCallId, { path: p, oldText: snapshotOldText })

              if (toolName === 'edit') {
                for (const needle of getEditOldTexts(args)) {
                  line = findUniqueLineNumber(snapshotOldText, needle)
                  if (typeof line === 'number') break
                }
              }
            } catch {
              snapshotOldText = null
              this.fileSnapshots.set(toolCallId, { path: p, oldText: null })
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call',
            toolCallId,
            title: toolName,
            kind: toToolKind(toolName),
            status: 'in_progress',
            locations,
            rawInput: args
          })
        } else {
          this.currentToolCalls.set(toolCallId, 'in_progress')
          this.emit({
            sessionUpdate: 'tool_call_update',
            toolCallId,
            status: 'in_progress',
            locations,
            rawInput: args
          })
        }

        break
      }

      case 'tool_execution_update': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({ toolCallId, status: 'in_progress', result: partial })
          break
        }

        const text = this.fileMutationToolCallIds.has(toolCallId) ? '' : toolResultToText(partial)

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: text
            ? ([{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[])
            : undefined,
          ...(this.fileMutationToolCallIds.has(toolCallId) ? {} : { rawOutput: partial })
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        if (this.bashToolCallIds.has(toolCallId)) {
          this.emitBashOutputUpdate({
            toolCallId,
            status: isError ? 'failed' : 'completed',
            result,
            isError
          })
          this.cleanupToolCall(toolCallId)
          break
        }

        const text = toolResultToText(result)

        const snapshot = this.fileSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined
        let hasStructuredDiff = false

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (snapshot.oldText === null || newText !== snapshot.oldText) {
              hasStructuredDiff = true
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                }
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        if (!content && !hasStructuredDiff && text) {
          content = [{ type: 'content', content: { type: 'text', text } }] satisfies ToolCallContent[]
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          ...(hasStructuredDiff ? {} : { rawOutput: result })
        })

        this.cleanupToolCall(toolCallId)
        break
      }

      case 'extension_ui_request': {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, 'id')
          if (!id) {
            return
          }

          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {})
        })
        break
      }

      case 'auto_retry_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: formatAutoRetryMessage(ev) } satisfies ContentBlock
        })
        break
      }

      case 'auto_retry_end': {
        if (ev.success === false) {
          if (this.pendingTurn) {
            const reason = stringProp(ev, 'finalError')?.trim()
            this.pendingTurn.error = reason
              ? toPromptError(reason)
              : (this.pendingTurn.error ?? toPromptError(undefined))
          }
          break
        }
        if (ev.success !== true) break
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Retry finished, resuming.'
          } satisfies ContentBlock
        })
        break
      }

      case 'compaction_start':
      case 'auto_compaction_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text:
              ev.reason === 'manual'
                ? 'Compacting context...'
                : 'Context nearing limit, running automatic compaction...'
          } satisfies ContentBlock
        })
        break
      }

      case 'compaction_end':
      case 'auto_compaction_end': {
        if (ev.aborted === true) {
          if (this.pendingTurn) this.pendingTurn.error = toPromptError('Compaction was cancelled.')
          break
        }
        if (typeof ev.errorMessage === 'string' || ev.result === null) {
          if (this.pendingTurn) this.pendingTurn.error = toPromptError(ev.errorMessage)
          break
        }
        if (!ev.result) break
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text:
              ev.reason === 'manual'
                ? 'Compaction finished; context was summarized.'
                : 'Automatic compaction finished; context was summarized to continue the session.'
          } satisfies ContentBlock
        })
        break
      }

      case 'agent_start': {
        ++this.activityRevision
        if (this.pendingTurn) this.emitRunningStatus(true)
        this.parentSettled = false
        this.inAgentLoop = true
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_settled`.
        break
      }

      case 'agent_end': {
        // One low-level run ended. Pi may still retry, compact, or process a queued
        // continuation, so keep the ACP turn open until `agent_settled`.
        this.inAgentLoop = false
        break
      }

      case 'agent_settled': {
        this.parentSettled = true
        ++this.activityRevision
        this.finishIfSettled()
        break
      }

      default:
        break
    }
  }

  private async handleExtensionUiRequest(ev: PiRpcEvent): Promise<void> {
    const id = stringProp(ev, 'id')
    const method = stringProp(ev, 'method')
    if (!id) {
      return
    }

    if (method === 'select') {
      await this.handleExtensionSelect(ev, id)
      return
    }

    if (method === 'confirm') {
      await this.handleExtensionConfirm(ev, id)
      return
    }

    if (method === 'input' || method === 'editor') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Pi ${method} UI request is not supported in ACP yet; cancelling it.`
        } satisfies ContentBlock
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    if (method === 'notify') {
      this.emit({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: stringProp(ev, 'message') ?? 'Pi notification' } satisfies ContentBlock,
        _meta: { piAcp: { notify: { level: stringProp(ev, 'notifyType') ?? 'info' } } }
      })
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, cancelled: true })
  }

  private async handleExtensionSelect(ev: PiRpcEvent, id: string): Promise<void> {
    const rawOptions = ev.options
    const options = Array.isArray(rawOptions) ? rawOptions.map(option => String(option)) : []
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    const permissionOptions: PermissionOption[] = options.map((name, index) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index}`,
      name,
      kind: 'allow_once'
    }))

    const selected = await this.requestExtensionPermission(id, ev, permissionOptions)
    if (selected === null) {
      return
    }

    const selectedOptionId = selected.outcome.outcome === 'selected' ? selected.outcome.optionId : null
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId)
    const value = index === null ? null : (options.at(index) ?? null)
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value })
  }

  private async handleExtensionConfirm(ev: PiRpcEvent, id: string): Promise<void> {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS)
    if (selected === null) {
      return
    }

    if (selected.outcome.outcome === 'cancelled') {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return
    }

    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === 'yes' })
  }

  private async requestExtensionPermission(
    id: string,
    ev: PiRpcEvent,
    options: PermissionOption[]
  ): Promise<PermissionResponse | null> {
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      })
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true })
      return null
    }
  }
}

function extensionUiToolCall(id: string, ev: PiRpcEvent) {
  const method = stringProp(ev, 'method') ?? 'ui'
  const title = stringProp(ev, 'title') ?? `Pi ${method}`
  const rawInput: Record<string, unknown> = { method }

  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key]
  }

  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: 'other' as const,
    status: 'pending' as const,
    rawInput
  }
}

function stringProp(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

function optionIndex(optionId: string): number | null {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null
  }

  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length)
  if (!rawIndex) {
    return null
  }

  const index = Number(rawIndex)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null
}

function formatAutoRetryMessage(ev: PiRpcEvent): string {
  const attempt = Number((ev as any).attempt)
  const maxAttempts = Number((ev as any).maxAttempts)
  const delayMs = Number((ev as any).delayMs)

  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return 'Retrying...'
  }

  let delaySeconds = Math.round(delayMs / 1000)
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1

  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`
}

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case 'read':
      return 'read'
    case 'write':
    case 'edit':
      return 'edit'
    case 'bash':
      return 'execute'
    default:
      return 'other'
  }
}
