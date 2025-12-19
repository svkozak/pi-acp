import {
  RequestError,
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type StopReason,
} from "@agentclientprotocol/sdk"
import { SessionManager } from "./session.js"

export class PiAcpAgent implements ACPAgent {
  private readonly conn: AgentSideConnection
  private readonly sessions = new SessionManager()

  constructor(conn: AgentSideConnection) {
    this.conn = conn
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    // Keep capabilities conservative for MVP.
    return {
      protocolVersion: 1,
      agentInfo: {
        name: "pi-acp",
        version: "0.0.0",
      },
      agentCapabilities: {
        loadSession: false,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: {},
      },
    }
  }

  async newSession(params: NewSessionRequest) {
    // For MVP we ignore mcpServers, but accept and store.
    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
    })

    return {
      sessionId: session.sessionId,
      // Be explicit to satisfy clients that expect these fields.
      models: {
        availableModels: [],
        currentModelId: "default",
      },
      modes: {
        availableModes: [],
        currentModeId: "default",
      },
      _meta: {},
    }
  }

  async authenticate(_params: AuthenticateRequest) {
    // MVP: no auth.
    return
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId)

    // MVP: concatenate text blocks only.
    const message = params.prompt
      .map((b) => (b.type === "text" ? b.text : b.type === "resource_link" ? `\n[Context] ${b.uri}` : ""))
      .join("")

    const result = await session.prompt(message)
    const stopReason: StopReason = result === "error" ? "end_turn" : result
    return { stopReason }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId)
    await session.cancel()
  }

  // Optional ACP methods we don't support yet.
  async loadSession(): Promise<never> {
    throw RequestError.methodNotFound("loadSession")
  }

  async unstable_setSessionModel(): Promise<never> {
    throw RequestError.methodNotFound("unstable_setSessionModel")
  }

  async setSessionMode(): Promise<never> {
    throw RequestError.methodNotFound("setSessionMode")
  }
}
