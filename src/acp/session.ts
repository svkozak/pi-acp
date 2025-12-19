import type { AgentSideConnection, ContentBlock, McpServer, SessionUpdate, ToolCallContent, ToolKind } from "@agentclientprotocol/sdk"
import { RequestError } from "@agentclientprotocol/sdk"
import { PiRpcProcess, type PiRpcEvent } from "../pi-rpc/process.js"

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

  async create(params: SessionCreateParams): Promise<PiAcpSession> {
    const sessionId = crypto.randomUUID()
    const proc = await PiRpcProcess.spawn({ cwd: params.cwd })

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
}

class PiAcpSession {
  readonly sessionId: string
  readonly cwd: string
  readonly mcpServers: McpServer[]

  private readonly proc: PiRpcProcess
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

function toolResultToText(result: unknown): string {
  if (!result) return ""

  // pi tool results generally look like: { content: [{type:"text", text:"..."}], details: {...} }
  const content = (result as any).content
  if (Array.isArray(content)) {
    const texts = content
      .map((c: any) => (c?.type === "text" && typeof c.text === "string" ? c.text : ""))
      .filter(Boolean)
    if (texts.length) return texts.join("")
  }

  try {
    return JSON.stringify(result, null, 2)
  } catch {
    return String(result)
  }
}
