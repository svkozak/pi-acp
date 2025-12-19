import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import * as readline from "node:readline"

type PiRpcCommand =
  | { type: "prompt"; id?: string; message: string; attachments?: unknown[] }
  | { type: "abort"; id?: string }
  | { type: "get_state"; id?: string }
  // Model
  | { type: "get_available_models"; id?: string }
  | { type: "set_model"; id?: string; provider: string; modelId: string }
  // Thinking
  | { type: "set_thinking_level"; id?: string; level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" }
  // Compaction
  | { type: "compact"; id?: string; customInstructions?: string }
  | { type: "set_auto_compaction"; id?: string; enabled: boolean }
  // Session
  | { type: "export_html"; id?: string; outputPath?: string }
  | { type: "switch_session"; id?: string; sessionPath: string }
  // Messages
  | { type: "get_messages"; id?: string }

type PiRpcResponse = {
  type: "response"
  id?: string
  command: string
  success: boolean
  data?: unknown
  error?: string
}

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
  private eventHandlers: Array<(ev: PiRpcEvent) => void> = []

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child

    const rl = readline.createInterface({ input: child.stdout })
    rl.on("line", (line) => {
      if (!line.trim()) return
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        // ignore malformed lines for now
        return
      }

      if (msg?.type === "response") {
        const id = typeof msg.id === "string" ? msg.id : undefined
        if (id) {
          const pending = this.pending.get(id)
          if (pending) {
            this.pending.delete(id)
            pending.resolve(msg as PiRpcResponse)
            return
          }
        }
      }

      for (const h of this.eventHandlers) h(msg as PiRpcEvent)
    })

    child.on("exit", (code, signal) => {
      const err = new Error(`pi process exited (code=${code}, signal=${signal})`)
      for (const [, p] of this.pending) p.reject(err)
      this.pending.clear()
    })
  }

  static async spawn(params: SpawnParams): Promise<PiRpcProcess> {
    const cmd = params.piCommand ?? "pi"

    const args = ["--mode", "rpc"]
    if (params.sessionPath) args.push("--session", params.sessionPath)

    const child = spawn(cmd, args, {
      cwd: params.cwd,
      stdio: "pipe",
      env: process.env,
    })

    child.stderr.on("data", () => {
      // leave stderr untouched; ACP clients may capture it.
    })

    const proc = new PiRpcProcess(child)

    // Best-effort handshake.
    // Important: pi may emit a get_state response pointing at a sessionFile in a directory
    // that is created lazily. Create the parent dir up-front to avoid later parse errors
    // when we call commands like export_html.
    try {
      const state = (await proc.getState()) as any
      const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null
      if (sessionFile) {
        const { mkdirSync } = await import("node:fs")
        const { dirname } = await import("node:path")
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
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler)
    }
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<void> {
    const res = await this.request({ type: "prompt", message, attachments })
    if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async abort(): Promise<void> {
    const res = await this.request({ type: "abort" })
    if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getState(): Promise<unknown> {
    const res = await this.request({ type: "get_state" })
    if (!res.success) throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async getAvailableModels(): Promise<unknown> {
    const res = await this.request({ type: "get_available_models" })
    if (!res.success) throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    const res = await this.request({ type: "set_model", provider, modelId })
    if (!res.success) throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setThinkingLevel(level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"): Promise<void> {
    const res = await this.request({ type: "set_thinking_level", level })
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async compact(customInstructions?: string): Promise<unknown> {
    const res = await this.request({ type: "compact", customInstructions })
    if (!res.success) throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const res = await this.request({ type: "set_auto_compaction", enabled })
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async exportHtml(outputPath?: string): Promise<{ path: string }> {
    const res = await this.request({ type: "export_html", outputPath })
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`)
    const data: any = res.data
    return { path: String(data?.path ?? "") }
  }

  async switchSession(sessionPath: string): Promise<void> {
    const res = await this.request({ type: "switch_session", sessionPath })
    if (!res.success) throw new Error(`pi switch_session failed: ${res.error ?? JSON.stringify(res.data)}`)
  }

  async getMessages(): Promise<unknown> {
    const res = await this.request({ type: "get_messages" })
    if (!res.success) throw new Error(`pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`)
    return res.data
  }

  private request(cmd: PiRpcCommand): Promise<PiRpcResponse> {
    const id = crypto.randomUUID()
    const withId = { ...cmd, id }

    const line = JSON.stringify(withId) + "\n"

    return new Promise<PiRpcResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(line, (err) => {
        if (err) {
          this.pending.delete(id)
          reject(err)
        }
      })
    })
  }
}
