import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import * as readline from "node:readline"

type PiRpcCommand =
  | { type: "prompt"; id?: string; message: string; attachments?: unknown[] }
  | { type: "abort"; id?: string }
  | { type: "get_state"; id?: string }

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
  piCommand?: string
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
    const child = spawn(cmd, ["--mode", "rpc", "--no-session"], {
      cwd: params.cwd,
      stdio: "pipe",
      env: process.env,
    })

    child.stderr.on("data", () => {
      // leave stderr untouched; ACP clients may capture it.
    })

    const proc = new PiRpcProcess(child)

    // Best-effort handshake.
    try {
      await proc.getState()
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
