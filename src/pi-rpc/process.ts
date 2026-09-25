import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as readline from 'node:readline'
import crossSpawn from 'cross-spawn'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BACKGROUND_COMMAND,
  BACKGROUND_STATUS_KEY,
  parseBackgroundMessage,
  type BackgroundMessage
} from './background-protocol.js'
import { getPiCommand, shouldUseShellForPiCommand } from './command.js'

export class PiRpcSpawnError extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code?: string

  constructor(message: string, opts?: { code?: string; cause?: unknown }) {
    super(message)
    this.name = 'PiRpcSpawnError'
    this.code = opts?.code
    ;(this as any).cause = opts?.cause
  }
}

const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)

const ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  'g'
)

function stripAnsi(s: string): string {
  // Basic ANSI escape stripping (colors, cursor movement, etc.)
  return s.replace(ANSI_ESCAPE_REGEX, '')
}

type PiRpcCommand =
  | { type: 'prompt'; id?: string; message: string; images?: unknown[] }
  | { type: 'abort'; id?: string }
  | { type: 'clear_queue'; id?: string }
  | { type: 'get_state'; id?: string }
  // Model
  | { type: 'get_available_models'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  // Thinking
  | { type: 'get_available_thinking_levels'; id?: string }
  | { type: 'set_thinking_level'; id?: string; level: string }
  // Modes
  | { type: 'set_follow_up_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  | { type: 'set_steering_mode'; id?: string; mode: 'all' | 'one-at-a-time' }
  // Compaction
  | { type: 'compact'; id?: string; customInstructions?: string }
  | { type: 'set_auto_compaction'; id?: string; enabled: boolean }
  // Session
  | { type: 'get_session_stats'; id?: string }
  | { type: 'set_session_name'; id?: string; name: string }
  | { type: 'export_html'; id?: string; outputPath?: string }
  | { type: 'switch_session'; id?: string; sessionPath: string }
  // Messages
  | { type: 'get_messages'; id?: string }
  // Commands
  | { type: 'get_commands'; id?: string }

type PiRpcResponse = {
  type: 'response'
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

type PiExtensionUiResponse =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true }

export type PiRpcEvent = Record<string, unknown>

/** Maximum wait for an auxiliary context-usage update. */
export const SESSION_STATS_TIMEOUT_MS = 1_000

/**
 * Shape of `stats.contextUsage` in pi's `get_session_stats` response.
 * `tokens` is null while pi has no trustworthy token count (e.g. right after compaction).
 */
export type PiContextUsage = {
  tokens?: number | null
  contextWindow?: number | null
}

export type PiSessionStats = {
  sessionId?: string
  sessionFile?: string
  totalMessages?: number
  cost?: number
  tokens?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    total?: number
  }
  contextUsage?: PiContextUsage | null
}

type SpawnParams = {
  cwd: string
  /** Optional override for `pi` executable name/path */
  piCommand?: string
  /** If set, pi will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string
}

export class PiRpcProcess {
  private child!: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, { resolve: (v: PiRpcResponse) => void; reject: (e: unknown) => void }>()
  private eventHandlers: Array<(ev: PiRpcEvent) => void> = []
  private readonly preludeLines: string[] = []
  private exitHandlers: Array<(error: Error) => void> = []
  private generation = 0
  private bridgeReady = false
  private backgroundSeen = false
  private cancellationResult: Extract<BackgroundMessage, { type: 'cancelled' }> | undefined
  private cancelling: Promise<void> | undefined
  private needsRestart = false
  private restarting: Promise<void> | undefined
  private disposed = false
  private terminalError: Error | undefined
  private failureCleanup: Promise<void> | undefined
  private lastSnapshot: BackgroundMessage | undefined

  private constructor(private readonly params: SpawnParams) {}

  private emit(event: PiRpcEvent): void {
    for (const handler of this.eventHandlers) handler(event)
  }

  private fail(error: Error): void {
    if (this.terminalError || this.disposed) return
    this.terminalError = error
    for (const request of this.pending.values()) request.reject(error)
    this.pending.clear()
    const childAlive = this.child?.exitCode === null && this.child?.signalCode === null
    if (!childAlive && this.backgroundSeen)
      this.terminalError = new Error(
        `${error.message}; detached background cleanup could not be verified after parent exit`
      )
    const cleanup = this.cancelling ?? (childAlive && this.bridgeReady ? this.cancelBackground(false) : this.retire())
    this.failureCleanup = cleanup
      .catch(failure => {
        this.terminalError = new Error(`${error.message}; background cleanup failed: ${String(failure)}`)
      })
      .then(() => {
        const failure = this.terminalError ?? error
        this.emit({ type: 'process_error', message: failure.message })
        for (const handler of this.exitHandlers) handler(failure)
        this.exitHandlers = []
        this.eventHandlers = []
      })
  }

  private bindChild(child: ChildProcessWithoutNullStreams): void {
    this.child = child
    const generation = ++this.generation
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', line => {
      if (generation !== this.generation || this.disposed || !line.trim()) return
      let msg: PiRpcEvent
      try {
        const value: unknown = JSON.parse(line)
        if (!value || typeof value !== 'object' || Array.isArray(value)) return
        msg = value as PiRpcEvent
      } catch {
        const cleaned = stripAnsi(line).trimEnd()
        if (cleaned) this.preludeLines.push(cleaned)
        return
      }

      if (msg.type === 'response') {
        if (typeof msg.id === 'string') this.pending.get(msg.id)?.resolve(msg as PiRpcResponse)
        return
      }
      if (
        msg.type === 'extension_ui_request' &&
        msg.method === 'setStatus' &&
        msg.statusKey === BACKGROUND_STATUS_KEY
      ) {
        try {
          const message = parseBackgroundMessage(String(msg.statusText))
          if (message.type === 'ready') this.bridgeReady = true
          else if (message.type === 'cancelled') this.cancellationResult = message
          else if (message.type === 'error') this.fail(new Error(message.message))
          else if (message.type === 'snapshot') {
            if (
              this.lastSnapshot?.type === 'snapshot' &&
              this.lastSnapshot.active.some(
                job => !message.active.some(active => active.id === job.id) && message.finished?.id !== job.id
              )
            ) {
              throw new Error('Background lifecycle ownership was lost before completion')
            }
            this.lastSnapshot = message
            if (message.active.length) this.backgroundSeen = true
            if (!this.terminalError) this.emit({ ...message, type: 'background_work' })
          } else throw new Error('Unknown background bridge message')
        } catch (error) {
          this.fail(error instanceof Error ? error : new Error(String(error)))
        }
        return
      }
      if (!this.terminalError) this.emit(msg)
    })
    child.on('exit', (code, signal) => {
      rl.close()
      if (generation === this.generation) this.fail(new Error(`pi process exited (code=${code}, signal=${signal})`))
    })
    const onError = (error: Error) => {
      if (generation === this.generation) this.fail(error)
    }
    child.on('error', onError)
    child.stdin.on('error', onError)
    child.stderr.on('data', () => {})
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    const proc = new PiRpcProcess({ ...params })
    try {
      await proc.start()
      return proc
    } catch (error) {
      await proc.retire().catch(() => {})
      throw error
    }
  }

  private async start(): Promise<void> {
    const params = this.params
    this.needsRestart = false
    this.bridgeReady = false
    this.backgroundSeen = false
    this.lastSnapshot = undefined
    this.terminalError = undefined
    // On Windows, npm commonly creates pi.cmd / pi.bat launcher scripts.
    const cmd = getPiCommand(params.piCommand)

    // Speed/robustness for ACP:
    // - themes are irrelevant in rpc mode and can be noisy/slow to load.
    // Keep extensions + prompt templates enabled because ACP users may rely on them
    // (e.g. MCP extensions, prompt templates for workflows).
    const bundledExtension = new URL('./background-extension.js', import.meta.url)
    const extension = existsSync(bundledExtension)
      ? bundledExtension
      : new URL('./background-extension.ts', import.meta.url)
    const args = ['--mode', 'rpc', '--no-themes', '--extension', fileURLToPath(extension)]
    if (params.sessionPath) args.push('--session', params.sessionPath)

    // Windows cmd launchers need shell escaping; direct executables use native argv.
    const start = shouldUseShellForPiCommand(cmd) ? crossSpawn : spawn
    const child = start(cmd, args, {
      cwd: params.cwd,
      stdio: 'pipe',
      env: { ...process.env, PI_ACP_BACKGROUND_BRIDGE: '1' }
    }) as ChildProcessWithoutNullStreams

    this.bindChild(child)

    // Ensure spawn failures (e.g. ENOENT when pi isn't installed) are surfaced as a
    // deterministic error instead of later EPIPE/internal-error noise.
    try {
      await new Promise<void>((resolve, reject) => {
        const onSpawn = () => {
          cleanup()
          resolve()
        }
        const onError = (err: any) => {
          cleanup()
          reject(err)
        }
        const cleanup = () => {
          child.off('spawn', onSpawn)
          child.off('error', onError)
        }

        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (e: any) {
      const code = typeof e?.code === 'string' ? e.code : undefined
      if (code === 'ENOENT') {
        throw new PiRpcSpawnError(
          `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
          { code, cause: e }
        )
      }

      if (code === 'EACCES') {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: e })
      }

      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e })
    }

    const response = await this.request({ type: 'get_state' }, 30_000)
    if (!response.success) throw new Error(response.error ?? 'pi startup state request failed')
    const state = response.data as { sessionFile?: unknown }
    if (!this.bridgeReady)
      throw new Error('The pi background bridge did not initialize. Check pi extension loading errors.')
    if (typeof state?.sessionFile === 'string') {
      this.params.sessionPath = state.sessionFile
      const { mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')
      mkdirSync(dirname(state.sessionFile), { recursive: true })
    }
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.eventHandlers.push(handler)
    if (this.lastSnapshot) handler({ ...this.lastSnapshot, type: 'background_work' })
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
    }
  }

  onExit(handler: (error: Error) => void): () => void {
    this.exitHandlers.push(handler)
    if (this.terminalError) {
      void Promise.resolve(this.failureCleanup).then(() => {
        if (this.exitHandlers.includes(handler)) {
          this.exitHandlers = this.exitHandlers.filter(h => h !== handler)
          handler(this.terminalError!)
        }
      })
    }
    return () => {
      this.exitHandlers = this.exitHandlers.filter(h => h !== handler)
    }
  }

  get backgroundLifecycleEnabled(): boolean {
    return this.bridgeReady
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    try {
      if (this.failureCleanup) await this.failureCleanup
      else if (this.bridgeReady && !this.needsRestart) await this.abort()
    } finally {
      this.disposed = true
      await this.retire()
      this.exitHandlers = []
      this.eventHandlers = []
    }
  }

  private async retire(): Promise<void> {
    const child = this.child
    ++this.generation
    for (const request of this.pending.values()) request.reject(new Error('pi process was retired'))
    this.pending.clear()
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>((resolve, reject) => {
      let escalation: ReturnType<typeof setTimeout> | undefined
      const timeout = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
          return
        }
        escalation = setTimeout(() => finish(new Error('Timed out stopping the pi process')), 2_000)
      }, 5_000)
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        clearTimeout(escalation)
        child.off('exit', onExit)
        if (error) reject(error)
        else resolve()
      }
      const onExit = () => finish()
      child.once('exit', onExit)
      try {
        child.kill('SIGTERM')
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
   * Themes are typically noisy/less useful for ACP, so callers can filter as needed.
   */
  consumePreludeLines(): string[] {
    const lines = this.preludeLines.splice(0, this.preludeLines.length)
    return lines
  }

  async prompt(message: string, images: unknown[] = []): Promise<void> {
    await this.ensureRunning()
    this.backgroundSeen = false
    try {
      const res = await this.request({ type: 'prompt', message, images })
      if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`)
    } catch (error) {
      await this.failureCleanup
      throw this.terminalError ?? error
    }
  }

  async abort(): Promise<void> {
    if (this.cancelling) return this.cancelling
    if (this.needsRestart) return
    if (!this.bridgeReady) {
      const res = await this.request({ type: 'abort' })
      if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`)
      return
    }
    this.cancelling = this.cancelBackground()
    try {
      await this.cancelling
    } finally {
      this.cancelling = undefined
    }
  }

  private async cancelBackground(reportCancellation = true): Promise<void> {
    this.cancellationResult = undefined
    let error: Error | undefined
    try {
      const res = await this.request({ type: 'prompt', message: `/${BACKGROUND_COMMAND} cancel` }, 20_000, true)
      if (!res.success) throw new Error(res.error ?? 'Background cancellation failed')
      const cancellation = this.cancellationResult as Extract<BackgroundMessage, { type: 'cancelled' }> | undefined
      if (!cancellation) throw new Error('Background cancellation was not acknowledged')
      if (cancellation.error) throw new Error(cancellation.error)
    } catch (failure) {
      error = failure instanceof Error ? failure : new Error(String(failure))
    }
    try {
      await this.retire()
    } catch (failure) {
      error ??= failure instanceof Error ? failure : new Error(String(failure))
    }
    this.needsRestart = !error && !this.terminalError && Boolean(this.params.sessionPath)
    this.backgroundSeen = false
    this.lastSnapshot = undefined
    if (error) {
      this.fail(error)
      throw error
    }
    if (!reportCancellation || this.terminalError) return
    if (!this.needsRestart) {
      const failure = new Error('Cannot restore the pi session after cancellation: session path is missing')
      this.fail(failure)
      throw failure
    }
    this.emit({ type: 'background_cancelled' })
  }

  private async ensureRunning(): Promise<void> {
    if (this.disposed) throw new Error('pi process is disposed')
    if (this.terminalError) throw this.terminalError
    if (this.restarting) return this.restarting
    if (this.needsRestart) {
      this.restarting = this.start()
      try {
        await this.restarting
      } catch (error) {
        await this.retire().catch(() => {})
        this.fail(error instanceof Error ? error : new Error(String(error)))
        throw error
      } finally {
        this.restarting = undefined
      }
    }
  }

  async getState(): Promise<unknown> {
    const res = await this.request({ type: 'get_state' })
    if (!res.success) throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableModels(): Promise<unknown> {
    const res = await this.request({ type: 'get_available_models' })
    if (!res.success) throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const res = await this.request({ type: 'set_model', provider, modelId })
    if (!res.success) throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableThinkingLevels(): Promise<string[]> {
    const res = await this.request({ type: 'get_available_thinking_levels' })
    if (!res.success)
      throw new Error(`pi get_available_thinking_levels failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data = res.data
    const levels = data && typeof data === 'object' && 'levels' in data ? data.levels : undefined
    if (
      !Array.isArray(levels) ||
      levels.length === 0 ||
      !levels.every(level => typeof level === 'string' && level.length > 0)
    ) {
      throw new Error('pi get_available_thinking_levels returned invalid levels')
    }
    return levels
  }

  async setThinkingLevel(level: string): Promise<void> {
    const res = await this.request({ type: 'set_thinking_level', level })
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setFollowUpMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_follow_up_mode', mode })
    if (!res.success) throw new Error(`pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async setSteeringMode(mode: 'all' | 'one-at-a-time'): Promise<void> {
    const res = await this.request({ type: 'set_steering_mode', mode })
    if (!res.success) throw new Error(`pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async compact(customInstructions?: string): Promise<unknown> {
    const res = await this.request({ type: 'compact', customInstructions })
    if (!res.success) throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const res = await this.request({ type: 'set_auto_compaction', enabled })
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getSessionStats(timeoutMs?: number): Promise<PiSessionStats> {
    const res = await this.request({ type: 'get_session_stats' }, timeoutMs)
    if (!res.success) throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`)
    return (res.data ?? {}) as PiSessionStats
  }

  async setSessionName(name: string): Promise<void> {
    const res = await this.request({ type: 'set_session_name', name })
    if (!res.success) throw new Error(`pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const res = await this.request({ type: 'export_html', outputPath })
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data: any = res.data
    return { path: String(data?.path ?? '') }
  }

  async switchSession(sessionPath: string): Promise<void> {
    const res = await this.request({ type: 'switch_session', sessionPath })
    if (!res.success) throw new Error(`pi switch_session failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getMessages(): Promise<unknown> {
    const res = await this.request({ type: 'get_messages' })
    if (!res.success) throw new Error(`pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getCommands(): Promise<unknown> {
    const res = await this.request({ type: 'get_commands' })
    if (!res.success) throw new Error(`pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data = res.data
    if (data && typeof data === 'object' && 'commands' in data && Array.isArray(data.commands)) {
      return { ...data, commands: data.commands.filter(command => command?.name !== BACKGROUND_COMMAND) }
    }
    return data
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    await this.writeLine(`${JSON.stringify({ type: 'extension_ui_response', ...response })}\n`)
  }

  private request(cmd: PiRpcCommand, timeoutMs?: number, cleanup = false): Promise<PiRpcResponse> {
    if (this.disposed) return Promise.reject(new Error('pi process is disposed'))
    if (this.needsRestart) return this.ensureRunning().then(() => this.request(cmd, timeoutMs, cleanup))
    if (this.terminalError && !cleanup) return Promise.reject(this.terminalError)
    const id = crypto.randomUUID()
    const withId = { ...cmd, id }

    const line = `${JSON.stringify(withId)}\n`

    return new Promise<PiRpcResponse>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const drop = (): boolean => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        return this.pending.delete(id)
      }

      this.pending.set(id, {
        resolve: res => {
          drop()
          resolve(res)
        },
        reject: error => {
          drop()
          reject(error)
        }
      })

      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timer = undefined
          if (!this.pending.delete(id)) return
          reject(new Error(`pi ${cmd.type} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        timer.unref?.()
      }

      void this.writeLine(line, cleanup).catch(error => {
        if (!drop()) return
        reject(error)
      })
    })
  }

  private writeLine(line: string, cleanup = false): Promise<void> {
    if (this.terminalError && !cleanup) return Promise.reject(this.terminalError)
    return new Promise<void>((resolve, reject) => {
      try {
        this.child.stdin.write(line, error => {
          if (error) {
            reject(error)
            return
          }

          resolve()
        })
      } catch (error: unknown) {
        reject(error)
      }
    })
  }
}
