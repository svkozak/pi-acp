import type {
  AgentSideConnection,
  ContentBlock,
  McpServer,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolKind
} from '@agentclientprotocol/sdk'
import { RequestError } from '@agentclientprotocol/sdk'
import { maybeAuthRequiredError } from './auth-required.js'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { PiRpcProcess, PiRpcSpawnError, type PiRpcEvent } from '../pi-rpc/process.js'
import { SessionStore } from './session-store.js'
import { toolResultToText } from './translate/pi-tools.js'
import { expandSlashCommand, type FileSlashCommand } from './slash-commands.js'
import {
  addUsage,
  emptyUsage,
  formatUsageStatus,
  parsePiUsage,
  type PiUsage,
  type UsageSnapshot
} from './translate/usage.js'

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
  fileCommands?: import('./slash-commands.js').FileSlashCommand[]
  piCommand?: string
  /** Initial model context window, used to compute the context-fill %. */
  contextWindow?: number | null
  /** Initial model id (provider/model), used for the status line. */
  modelId?: string | null
  /**
   * Whether the ACP client is known to render `usage_update` natively (e.g. as a context ring
   * and/or cost chip). When `true`, the inline `agent_message_chunk` status-line fallback is
   * suppressed to avoid duplicating information already shown in the client UI. Decided by the
   * agent at `initialize` time from `clientInfo.name`.
   */
  clientRendersUsageNatively?: boolean
}

export type StopReason = 'end_turn' | 'cancelled' | 'error'

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

type QueuedTurn = {
  message: string
  images: unknown[]
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
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

function toToolCallLocations(args: unknown, cwd: string, line?: number): ToolCallLocation[] | undefined {
  const path = typeof (args as { path?: unknown } | null | undefined)?.path === 'string' ? (args as { path: string }).path : undefined
  if (!path) return undefined

  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path)
  return [{ path: resolvedPath, ...(typeof line === 'number' ? { line } : {}) }]
}

// Tools whose stdout we want the client to render in a fixed-width block. Pi's
// `bash` tool emits raw shell output that otherwise gets re-flowed by the
// markdown renderer in Zed / other clients.
const FENCED_OUTPUT_TOOLS = new Set(['bash'])

function fenceBashOutput(text: string): string {
  if (!text) return text
  // Use the longest run of backticks in `text` + 1 as the fence length so we
  // never terminate early on output that itself contains ``` sequences.
  const longestRun = (text.match(/`+/g) ?? []).reduce((n, s) => Math.max(n, s.length), 0)
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}shell\n${text.replace(/\n$/, '')}\n${fence}`
}

function formatToolOutputContent(toolName: string, text: string): ToolCallContent[] | undefined {
  if (!text) return undefined
  if (FENCED_OUTPUT_TOOLS.has(toolName)) {
    return [{ type: 'content', content: { type: 'text', text: fenceBashOutput(text) } }]
  }
  return [{ type: 'content', content: { type: 'text', text } }]
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store = new SessionStore()

  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll(): void {
    for (const [id] of this.sessions) this.close(id)
  }

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId: string): void {
    const s = this.sessions.get(sessionId)
    if (!s) return
    try {
      s.proc.dispose?.()
    } catch {
      // ignore
    }
    this.sessions.delete(sessionId)
  }

  /** Close all sessions except the one with `keepSessionId`. */
  closeAllExcept(keepSessionId: string): void {
    for (const [id] of this.sessions) {
      if (id === keepSessionId) continue
      this.close(id)
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
      fileCommands: params.fileCommands ?? [],
      contextWindow: params.contextWindow ?? null,
      modelId: params.modelId ?? null,
      clientRendersUsageNatively: params.clientRendersUsageNatively ?? false
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
      fileCommands: params.fileCommands ?? [],
      contextWindow: params.contextWindow ?? null,
      modelId: params.modelId ?? null,
      clientRendersUsageNatively: params.clientRendersUsageNatively ?? false
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
  private readonly turnQueue: QueuedTurn[] = []
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  //
  // Keeps `toolName` alongside the status so subsequent `tool_execution_update`
  // / `tool_execution_end` events (which only carry the toolCallId) can still
  // drive per-tool output formatting (e.g. fenced bash output, structured
  // diffs).
  private currentToolCalls = new Map<string, { status: 'pending' | 'in_progress'; toolName: string }>()

  // pi can emit multiple `turn_end` events for a single user prompt (e.g. after tool_use).
  // The overall agent loop completes when `agent_end` is emitted.
  private inAgentLoop = false

  // For ACP diff support: capture file contents before `edit` / `write`, then
  // emit ToolCallContent {type:"diff"} on completion. This is done because pi
  // sends its diff as a pre-formatted string rather than the structured shape
  // ACP expects. A compatible native format may land in pi in the future.
  //
  // For `write` against a new file we record oldText = '' so the client can
  // still render the creation as a diff against an empty file.
  private fileSnapshots = new Map<string, { path: string; oldText: string; toolName: 'edit' | 'write' }>()

  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  private lastEmit: Promise<void> = Promise.resolve()

  // Usage telemetry. Populated from pi `message_end` events on assistant messages.
  private sessionUsage: PiUsage = emptyUsage()
  private lastAssistantUsage: PiUsage | null = null
  private currentModelId: string | null
  private contextWindow: number | null
  private readonly clientRendersUsageNatively: boolean

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
    fileCommands?: FileSlashCommand[]
    contextWindow?: number | null
    modelId?: string | null
    clientRendersUsageNatively?: boolean
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn
    this.fileCommands = opts.fileCommands ?? []
    this.contextWindow = opts.contextWindow ?? null
    this.currentModelId = opts.modelId ?? null
    this.clientRendersUsageNatively = opts.clientRendersUsageNatively ?? false

    this.proc.onEvent(ev => this.handlePiEvent(ev))
  }

  /** Called by the agent layer when a client sets a new model via `unstable_setSessionModel`. */
  setCurrentModel(modelId: string | null, contextWindow: number | null): void {
    this.currentModelId = modelId
    if (contextWindow !== null) this.contextWindow = contextWindow
  }

  /** Snapshot of cumulative session usage, for attaching to a PromptResponse. */
  getCumulativeUsage() {
    return {
      inputTokens: this.sessionUsage.input,
      outputTokens: this.sessionUsage.output,
      totalTokens: this.sessionUsage.totalTokens,
      cachedReadTokens: this.sessionUsage.cacheRead,
      cachedWriteTokens: this.sessionUsage.cacheWrite
    }
  }

  /**
   * Decide whether to emit the inline status-line `agent_message_chunk` fallback.
   *
   * Order of precedence:
   *   1. `PI_ACP_USAGE_STATUS=never`     → false
   *   2. `PI_ACP_HIDE_USAGE_STATUS=1`    → false (legacy alias)
   *   3. `PI_ACP_USAGE_STATUS=always`    → true
   *   4. `PI_ACP_USAGE_STATUS=auto` (or unset) → !clientRendersUsageNatively
   */
  private shouldEmitUsageStatusText(): boolean {
    const mode = (process.env.PI_ACP_USAGE_STATUS ?? '').toLowerCase()
    if (mode === 'never') return false
    if (process.env.PI_ACP_HIDE_USAGE_STATUS === '1') return false
    if (mode === 'always') return true
    return !this.clientRendersUsageNatively
  }

  private snapshotUsage(): UsageSnapshot {
    const last = this.lastAssistantUsage
    const lastPromptTokens = last ? last.input + last.cacheRead + last.cacheWrite : 0
    const fill =
      last && this.contextWindow && this.contextWindow > 0
        ? Math.min(1, lastPromptTokens / this.contextWindow)
        : null

    return {
      lastTurnTokens: last?.totalTokens ?? 0,
      lastTurnCost: last?.cost.total ?? 0,
      sessionInputTokens: this.sessionUsage.input,
      sessionOutputTokens: this.sessionUsage.output,
      sessionCacheReadTokens: this.sessionUsage.cacheRead,
      sessionCacheWriteTokens: this.sessionUsage.cacheWrite,
      sessionTotalTokens: this.sessionUsage.totalTokens,
      sessionCost: this.sessionUsage.cost.total,
      contextWindow: this.contextWindow,
      contextFillRatio: fill
    }
  }

  setStartupInfo(text: string) {
    this.startupInfo = text
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
    await this.proc.abort()
  }

  wasCancelRequested(): boolean {
    return this.cancelRequested
  }

  private emit(update: SessionUpdate): void {
    // Serialize update delivery.
    this.lastEmit = this.lastEmit
      .then(() =>
        this.conn.sessionUpdate({
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

  private startTurn(t: QueuedTurn): void {
    this.cancelRequested = false
    this.inAgentLoop = false

    this.pendingTurn = { resolve: t.resolve, reject: t.reject }

    // Publish queue depth (0 because we're starting the turn now).
    this.emit({
      sessionUpdate: 'session_info_update',
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    })

    // Kick off pi, but completion is determined by pi events, not the RPC response.
    // Important: pi may emit multiple `turn_end` events (e.g. when the model requests tools).
    // The full prompt is finished when we see `agent_end`.
    this.proc.prompt(t.message, t.images).catch(err => {
      // If the subprocess errors before we get an `agent_end`, treat as error unless cancelled.
      // Also ensure we flush any already-enqueued updates first.
      void this.flushEmits().finally(() => {
        // If this looks like an auth/config issue, surface AUTH_REQUIRED so clients can offer terminal login.
        const authErr = maybeAuthRequiredError(err)
        if (authErr) {
          this.pendingTurn?.reject(authErr)
        } else {
          const reason: StopReason = this.cancelRequested ? 'cancelled' : 'error'
          this.pendingTurn?.resolve(reason)
        }

        this.pendingTurn = null
        this.inAgentLoop = false

        // If the prompt failed, do not automatically proceed—pi may be unhealthy.
        // But we still clear the queueDepth metadata.
        this.emit({
          sessionUpdate: 'session_info_update',
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } }
        })
      })
      void err
    })
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? '')

    switch (type) {
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
            const existing = this.currentToolCalls.get(toolCallId)
            // IMPORTANT: never downgrade status (e.g. if we already marked in_progress via tool_execution_start).
            const status = existing?.status ?? 'pending'

            if (!existing) {
              this.currentToolCalls.set(toolCallId, { status: 'pending', toolName })
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

        // Capture pre-edit file contents so we can emit a structured ACP diff on completion.
        // `edit`: snapshot must already exist. `write`: new file is allowed, oldText = ''.
        if (toolName === 'edit' || toolName === 'write') {
          const p = typeof args?.path === 'string' ? args.path : undefined
          if (p) {
            const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p)
            let oldText: string | null = null
            try {
              oldText = readFileSync(abs, 'utf8')
            } catch {
              // For `write`, treat a missing file as an empty pre-state so the client
              // still renders the creation as a diff. For `edit`, we skip diffing
              // if we can't snapshot.
              if (toolName === 'write') oldText = ''
            }

            if (oldText !== null) {
              this.fileSnapshots.set(toolCallId, { path: p, oldText, toolName })

              if (toolName === 'edit') {
                const needle = typeof args?.oldText === 'string' ? args.oldText : ''
                line = findUniqueLineNumber(oldText, needle)
              }
            }
          }
        }

        const locations = toToolCallLocations(args, this.cwd, line)

        // If we already surfaced the tool call while the model streamed it, just transition.
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, { status: 'in_progress', toolName })
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
          this.currentToolCalls.set(toolCallId, { status: 'in_progress', toolName })
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
        const text = toolResultToText(partial)
        const toolName = this.currentToolCalls.get(toolCallId)?.toolName ?? ''

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'in_progress',
          content: formatToolOutputContent(toolName, text),
          rawOutput: partial
        })
        break
      }

      case 'tool_execution_end': {
        const toolCallId = String((ev as any).toolCallId ?? '')
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        const text = toolResultToText(result)
        const toolName = this.currentToolCalls.get(toolCallId)?.toolName ?? ''

        // If this was an edit/write and we captured a snapshot, emit a structured ACP diff.
        // This enables clients like Zed to render an actual diff UI.
        const snapshot = this.fileSnapshots.get(toolCallId)
        let content: ToolCallContent[] | undefined

        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path)
            const newText = readFileSync(abs, 'utf8')
            if (newText !== snapshot.oldText) {
              const followupText = formatToolOutputContent(toolName, text) ?? []
              content = [
                {
                  type: 'diff',
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                },
                ...followupText
              ]
            }
          } catch {
            // ignore; fall back to text only
          }
        }

        // Fallback: just text content (fenced for bash so clients render a code block).
        if (!content) {
          content = formatToolOutputContent(toolName, text)
        }

        this.emit({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: isError ? 'failed' : 'completed',
          content,
          rawOutput: result
        })

        this.currentToolCalls.delete(toolCallId)
        this.fileSnapshots.delete(toolCallId)
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
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Retry finished, resuming.' } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_start': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Context nearing limit, running automatic compaction...' } satisfies ContentBlock
        })
        break
      }

      case 'auto_compaction_end': {
        this.emit({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: 'Automatic compaction finished; context was summarized to continue the session.'
          } satisfies ContentBlock
        })
        break
      }

      case 'agent_start': {
        this.inAgentLoop = true
        break
      }

      case 'message_end': {
        // Pi emits message_end for every role (user, assistant, toolResult).
        // Only assistant messages carry `usage`. Each agent loop may emit several
        // of these (one per model call), so we accumulate.
        const message = (ev as any).message
        if (message?.role === 'assistant') {
          const usage = parsePiUsage(message.usage)
          if (usage) {
            this.lastAssistantUsage = usage
            this.sessionUsage = addUsage(this.sessionUsage, usage)
          }
        }
        break
      }

      case 'turn_end': {
        // pi uses `turn_end` for sub-steps (e.g. tool_use) and will often start another turn.
        // Do NOT resolve the ACP `session/prompt` here; wait for `agent_end`.
        break
      }

      case 'agent_end': {
        // Before resolving the prompt turn, emit usage telemetry in three forms so any
        // client can show something useful:
        //
        //   1. `usage_update` (ACP ≥0.14, gated behind Zed's AcpBetaFeatureFlag) — drives
        //      the circular context-window ring and cost chip in Zed. `used`/`size` are
        //      based on the last assistant prompt (input + cacheRead + cacheWrite) vs the
        //      model's contextWindow.
        //   2. `session_info_update` with `_meta.piAcp.usage` — structured data other
        //      clients / tools can read even without the beta flag.
        //   3. An inline `agent_message_chunk` status line — visible in any client that only
        //      renders text. Suppressed automatically when the ACP client is known to render
        //      `usage_update` natively (e.g. Zed's context ring) to avoid duplicate display.
        //      Precedence for the gating decision:
        //        PI_ACP_USAGE_STATUS = 'never' | 'always' | 'auto' (default)
        //        legacy: PI_ACP_HIDE_USAGE_STATUS=1 → equivalent to 'never'
        const snap = this.snapshotUsage()
        const lastPromptTokens = this.lastAssistantUsage
          ? this.lastAssistantUsage.input +
            this.lastAssistantUsage.cacheRead +
            this.lastAssistantUsage.cacheWrite
          : 0

        if (this.contextWindow && this.contextWindow > 0) {
          this.emit({
            sessionUpdate: 'usage_update',
            used: Math.min(lastPromptTokens, this.contextWindow),
            size: this.contextWindow,
            cost:
              snap.sessionCost > 0
                ? { amount: snap.sessionCost, currency: 'USD' }
                : null
          })
        }

        this.emit({
          sessionUpdate: 'session_info_update',
          updatedAt: new Date().toISOString(),
          _meta: {
            piAcp: {
              usage: snap,
              model: this.currentModelId,
              queueDepth: this.turnQueue.length,
              running: false
            }
          }
        })

        if (this.shouldEmitUsageStatusText() && snap.sessionTotalTokens > 0) {
          const text = formatUsageStatus(snap, { includeSessionTotal: true })
          if (text) {
            this.emit({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `\n_${text}_\n` }
            })
          }
        }

        // Ensure all updates derived from pi events are delivered before we resolve
        // the ACP `session/prompt` request.
        void this.flushEmits().finally(() => {
          const reason: StopReason = this.cancelRequested ? 'cancelled' : 'end_turn'
          this.pendingTurn?.resolve(reason)
          this.pendingTurn = null
          this.inAgentLoop = false

          // Start next queued prompt, if any.
          const next = this.turnQueue.shift()
          if (next) {
            this.emit({
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `Starting queued message. (${this.turnQueue.length} remaining)` }
            })
            this.startTurn(next)
          } else {
            this.emit({
              sessionUpdate: 'session_info_update',
              _meta: { piAcp: { queueDepth: 0, running: false } }
            })
          }
        })
        break
      }

      default:
        break
    }
  }
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
      // Many ACP clients render `execute` tool calls only via the terminal APIs.
      // Since this adapter lets pi execute locally (no client terminal delegation),
      // we report bash as `other` so clients show inline text output blocks.
      return 'other'
    default:
      return 'other'
  }
}
