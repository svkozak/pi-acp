import type { AgentSideConnection, ContentBlock, McpServer, SessionUpdate, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk"
import { RequestError } from "@agentclientprotocol/sdk"
import { PiRpcProcess, type PiRpcEvent } from "../pi-rpc/process.js"
import { SessionStore } from "./session-store.js"
import { toolResultToText } from "./translate/pi-tools.js"

type SessionCreateParams = {
  cwd: string
  mcpServers: McpServer[]
  conn: AgentSideConnection
}

export type StopReason = "end_turn" | "cancelled" | "error"

type PendingTurn = {
  resolve: (reason: StopReason) => void
  reject: (err: unknown) => void
}

export class SessionManager {
  private sessions = new Map<string, PiAcpSession>()
  private readonly store = new SessionStore()

  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId: string): PiAcpSession | undefined {
    return this.sessions.get(sessionId)
  }

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    // Let pi manage session persistence in its default location (~/.pi/agent/sessions/...)
    // so sessions are visible to the regular `pi` CLI.
    const proc = await PiRpcProcess.spawn({
      cwd: params.cwd,
    })

    const state = (await proc.getState()) as any
    const sessionId = typeof state?.sessionId === "string" ? state.sessionId : crypto.randomUUID()
    const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null

    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile })
    }

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
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
  getOrCreate(
    sessionId: string,
    params: SessionCreateParams & { proc: PiRpcProcess },
  ): PiAcpSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing

    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
    })

    this.sessions.set(sessionId, session)
    return session
  }
}

export class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  readonly proc: PiRpcProcess
  private readonly conn: AgentSideConnection

  // Used to map abort semantics to ACP stopReason.
  private cancelRequested = false
  private pendingTurn: PendingTurn | null = null
  private currentToolCalls = new Set<string>()

  constructor(opts: {
    sessionId: string
    cwd: string
    mcpServers: McpServer[]
    proc: PiRpcProcess
    conn: AgentSideConnection
  }) {
    this.sessionId = opts.sessionId
    this.cwd = opts.cwd
    this.mcpServers = opts.mcpServers
    this.proc = opts.proc
    this.conn = opts.conn

    this.proc.onEvent((ev) => this.handlePiEvent(ev))
  }

  async prompt(message: string, attachments: unknown[] = []): Promise<StopReason> {
    if (this.pendingTurn) throw RequestError.invalidRequest("A prompt is already in progress")

    this.cancelRequested = false

    const turnPromise = new Promise<StopReason>((resolve, reject) => {
      this.pendingTurn = { resolve, reject }
    })

    // Kick off pi, but completion is determined by pi events (`turn_end`) not the RPC response.
    this.proc.prompt(message, attachments).catch((err) => {
      // If the subprocess errors before we get a `turn_end`, treat as error unless cancelled.
      const reason: StopReason = this.cancelRequested ? "cancelled" : "error"
      this.pendingTurn?.resolve(reason)
      this.pendingTurn = null
      void err
    })

    return turnPromise
  }

  async cancel(): Promise<void> {
    this.cancelRequested = true
    await this.proc.abort()
  }

  private async emit(update: SessionUpdate): Promise<void> {
    await this.conn.sessionUpdate({
      sessionId: this.sessionId,
      update,
    })
  }

  private handlePiEvent(ev: PiRpcEvent) {
    const type = String((ev as any).type ?? "")

    switch (type) {
      case "message_update": {
        const ame = (ev as any).assistantMessageEvent
        if (ame?.type === "text_delta" && typeof ame.delta === "string") {
          void this.emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: ame.delta } satisfies ContentBlock,
          })
        }
        // (MVP) ignore thinking/toolcall deltas here.
        break
      }

      case "tool_execution_start": {
        const toolCallId = String((ev as any).toolCallId ?? crypto.randomUUID())
        const toolName = String((ev as any).toolName ?? "tool")
        const args = (ev as any).args

        this.currentToolCalls.add(toolCallId)

        void this.emit({
          sessionUpdate: "tool_call",
          toolCallId,
          title: toolName,
          kind: toToolKind(toolName),
          status: "in_progress",
          rawInput: args,
        })
        break
      }

      case "tool_execution_update": {
        const toolCallId = String((ev as any).toolCallId ?? "")
        if (!toolCallId) break

        const partial = (ev as any).partialResult
        const text = toolResultToText(partial)

        void this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
          content: text
            ? ([{ type: "content", content: { type: "text", text } }] satisfies ToolCallContent[])
            : undefined,
          rawOutput: partial,
        })
        break
      }

      case "tool_execution_end": {
        const toolCallId = String((ev as any).toolCallId ?? "")
        if (!toolCallId) break

        const result = (ev as any).result
        const isError = Boolean((ev as any).isError)
        const text = toolResultToText(result)

        void this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: isError ? "failed" : "completed",
          content: text
            ? ([{ type: "content", content: { type: "text", text } }] satisfies ToolCallContent[])
            : undefined,
          rawOutput: result,
        })

        this.currentToolCalls.delete(toolCallId)
        break
      }

      case "turn_end": {
        const reason: StopReason = this.cancelRequested ? "cancelled" : "end_turn"
        this.pendingTurn?.resolve(reason)
        this.pendingTurn = null
        break
      }

      default:
        break
    }
  }
}

function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case "read":
      return "read"
    case "write":
    case "edit":
      return "edit"
    case "bash":
      return "execute"
    default:
      return "other"
  }
}

