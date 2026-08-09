import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import * as readline from 'node:readline'
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

export class PiRpcTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`pi RPC request timed out after ${timeoutMs}ms: ${command}`)
    this.name = 'PiRpcTimeoutError'
  }
}

const ESC = String.fromCharCode(0x1b)
const CSI = String.fromCharCode(0x9b)

const ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  'g'
)
const RPC_REQUEST_TIMEOUT_MS = 30_000
const RPC_STATE_PROBE_TIMEOUT_MS = 5_000
const RPC_PROMPT_IDLE_TIMEOUT_MS = 120_000
const RPC_LONG_REQUEST_TIMEOUT_MS = 10 * 60_000
const RPC_KILL_GRACE_MS = 1_000

function stripAnsi(s: string): string {
  // Basic ANSI escape stripping (colors, cursor movement, etc.)
  return s.replace(ANSI_ESCAPE_REGEX, '')
}

type PiRpcCommand =
  | { type: 'prompt'; id?: string; message: string; images?: unknown[] }
  | { type: 'abort'; id?: string }
  | { type: 'get_state'; id?: string }
  // Model
  | { type: 'get_available_models'; id?: string }
  | { type: 'set_model'; id?: string; provider: string; modelId: string }
  // Thinking
  | { type: 'set_thinking_level'; id?: string; level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' }
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

type SpawnParams = {
  cwd: string
  /** Optional override for `pi` executable name/path */
  piCommand?: string
  /** If set, pi will persist the session to this exact file (via `--session <path>`). */
  sessionPath?: string
}

export class PiRpcProcess {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, { resolve: (v: PiRpcResponse) => void; reject: (e: unknown) => void }>()
  private readonly pendingExtensionUiRequests = new Set<string>()
  private eventHandlers: Array<(ev: PiRpcEvent) => void> = []
  private readonly preludeLines: string[] = []
  private terminalError: Error | null = null
  private agentStartSequence = 0

  private constructor(
    child: ChildProcessWithoutNullStreams,
    private readonly requestTimeoutMs = RPC_REQUEST_TIMEOUT_MS,
    private readonly promptIdleTimeoutMs = RPC_PROMPT_IDLE_TIMEOUT_MS
  ) {
    this.child = child

    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', line => {
      if (!line.trim()) return
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        // pi may emit a human-readable prelude on stdout before NDJSON starts.
        // Capture it so the ACP adapter can surface it on session start.
        const cleaned = stripAnsi(String(line)).trimEnd()
        if (cleaned) this.preludeLines.push(cleaned)
        return
      }

      if (msg?.type === 'response') {
        const id = typeof msg.id === 'string' ? msg.id : undefined
        if (id) this.pending.get(id)?.resolve(msg as PiRpcResponse)
        return
      }

      if (msg?.type === 'extension_ui_request' && typeof msg.id === 'string') {
        this.pendingExtensionUiRequests.add(msg.id)
      }
      if (msg?.type === 'agent_start') this.agentStartSequence += 1

      for (const h of this.eventHandlers) h(msg as PiRpcEvent)
    })

    child.on('exit', (code, signal) => {
      this.terminalError ??= new Error(`pi process exited (code=${code}, signal=${signal})`)
      this.pendingExtensionUiRequests.clear()
      for (const p of [...this.pending.values()]) p.reject(this.terminalError)
      this.pending.clear()
    })

    child.on('error', err => {
      this.terminalError ??= err
      this.pendingExtensionUiRequests.clear()
      for (const p of [...this.pending.values()]) p.reject(this.terminalError)
      this.pending.clear()
    })
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    // On Windows, npm commonly creates pi.cmd / pi.bat launcher scripts.
    const cmd = getPiCommand(params.piCommand)

    // Speed/robustness for ACP:
    // - themes are irrelevant in rpc mode and can be noisy/slow to load.
    // Keep extensions + prompt templates enabled because ACP users may rely on them
    // (e.g. MCP extensions, prompt templates for workflows).
    const args = ['--mode', 'rpc', '--no-themes']
    if (params.sessionPath) args.push('--session', params.sessionPath)

    const child = spawn(cmd, args, {
      cwd: params.cwd,
      stdio: 'pipe',
      env: process.env,
      shell: shouldUseShellForPiCommand(cmd)
    })

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

    child.stderr.on('data', () => {
      // leave stderr untouched; ACP clients may capture it.
    })

    const proc = new PiRpcProcess(child)

    // Best-effort handshake.
    // Important: pi may emit a get_state response pointing at a sessionFile in a directory
    // that is created lazily. Create the parent dir up-front to avoid later parse errors
    // when we call commands like export_html.
    try {
      const state = (await proc.getState()) as any
      const sessionFile = typeof state?.sessionFile === 'string' ? state.sessionFile : null
      if (sessionFile) {
        const { mkdirSync } = await import('node:fs')
        const { dirname } = await import('node:path')
        mkdirSync(dirname(sessionFile), { recursive: true })
      }
    } catch {
      // ignore for now
    }

    return proc
  }

  onEvent(handler: (ev: PiRpcEvent) => void): () => void {
    this.eventHandlers.push(handler)
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler)
    }
  }

  dispose(signal: NodeJS.Signals | number = 'SIGTERM'): void {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    try {
      this.child.kill(signal as any)
    } catch {
      // ignore
    }
  }

  private terminate(): void {
    this.dispose()
    const timer = setTimeout(() => this.dispose('SIGKILL'), RPC_KILL_GRACE_MS)
    timer.unref()
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
    const res = await this.request({ type: 'prompt', message, images })
    if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async abort(): Promise<void> {
    const res = await this.request({ type: 'abort' })
    if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`)
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

  async setThinkingLevel(level: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'): Promise<void> {
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
    const res = await this.request({ type: 'compact', customInstructions }, RPC_LONG_REQUEST_TIMEOUT_MS)
    if (!res.success) throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const res = await this.request({ type: 'set_auto_compaction', enabled })
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getSessionStats(): Promise<unknown> {
    const res = await this.request({ type: 'get_session_stats' })
    if (!res.success) throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
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
    return res.data
  }

  async sendExtensionUiResponse(response: PiExtensionUiResponse): Promise<void> {
    this.pendingExtensionUiRequests.delete(response.id)
    await this.writeLine(`${JSON.stringify({ type: 'extension_ui_response', ...response })}\n`)
  }

  private request(cmd: PiRpcCommand, timeoutMs = this.requestTimeoutMs): Promise<PiRpcResponse> {
    if (this.terminalError) return Promise.reject(this.terminalError)

    const id = crypto.randomUUID()
    const withId = { ...cmd, id }
    const line = `${JSON.stringify(withId)}\n`
    const startedAt = Date.now()
    const agentStartSequence = this.agentStartSequence

    return new Promise<PiRpcResponse>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined

      const finish = (settle: () => void) => {
        if (!this.pending.delete(id)) return
        if (timer) clearTimeout(timer)
        settle()
      }
      const finishResolve = (response: PiRpcResponse) => finish(() => resolve(response))
      const finishReject = (error: unknown) => finish(() => reject(error))
      const timeoutError = () =>
        new PiRpcTimeoutError(cmd.type, cmd.type === 'prompt' ? Date.now() - startedAt : timeoutMs)

      const armTimeout = () => {
        timer = setTimeout(() => void handleTimeout(), timeoutMs)
      }

      const handleTimeout = async () => {
        timer = undefined
        if (!this.pending.has(id)) return

        if (cmd.type === 'prompt') {
          if (this.agentStartSequence !== agentStartSequence) {
            finishResolve({ type: 'response', id, command: 'prompt', success: true })
            return
          }

          if (this.pendingExtensionUiRequests.size > 0 && Date.now() - startedAt < RPC_LONG_REQUEST_TIMEOUT_MS) {
            armTimeout()
            return
          }

          try {
            const probe = await this.request(
              { type: 'get_state' },
              Math.min(this.requestTimeoutMs, RPC_STATE_PROBE_TIMEOUT_MS)
            )
            if (!this.pending.has(id)) return

            const state = probe.success && probe.data && typeof probe.data === 'object' ? probe.data : null
            if (
              (state as { isStreaming?: unknown } | null)?.isStreaming === true ||
              this.agentStartSequence !== agentStartSequence
            ) {
              finishResolve({ type: 'response', id, command: 'prompt', success: true })
              return
            }

            const elapsedMs = Date.now() - startedAt
            if (
              ((state as { isCompacting?: unknown } | null)?.isCompacting === true &&
                elapsedMs < RPC_LONG_REQUEST_TIMEOUT_MS) ||
              elapsedMs < this.promptIdleTimeoutMs
            ) {
              armTimeout()
              return
            }
          } catch {
            if (!this.pending.has(id)) return
            if (this.agentStartSequence !== agentStartSequence) {
              finishResolve({ type: 'response', id, command: 'prompt', success: true })
              return
            }
            if (Date.now() - startedAt < this.promptIdleTimeoutMs) {
              armTimeout()
              return
            }
          }

          const error = timeoutError()
          this.terminalError = error
          finishReject(error)
          this.terminate()
          return
        }

        finishReject(timeoutError())
      }

      this.pending.set(id, { resolve: finishResolve, reject: finishReject })
      armTimeout()
      void this.writeLine(line).catch(finishReject)
    })
  }

  private writeLine(line: string): Promise<void> {
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
