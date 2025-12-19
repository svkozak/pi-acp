import {
  RequestError,
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type ModelInfo,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { SessionManager } from "./session.js";
import { SessionStore } from "./session-store.js";
import { PiRpcProcess } from "../pi-rpc/process.js";
import { normalizePiAssistantText, normalizePiMessageText } from "./translate/pi-messages.js";
import { promptToPiMessage } from "./translate/prompt.js";
import { isAbsolute } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = readNearestPackageJson(import.meta.url);

export class PiAcpAgent implements ACPAgent {
  private readonly conn: AgentSideConnection;
  private readonly sessions = new SessionManager();
  private readonly store = new SessionStore();

  constructor(conn: AgentSideConnection) {
    this.conn = conn;
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    // We currently only support ACP protocol version 1.
    const supportedVersion = 1;
    const requested = params.protocolVersion;

    return {
      protocolVersion:
        requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: pkg.name ?? "pi-acp",
        title: "pi ACP adapter",
        version: pkg.version ?? "0.0.0",
      },
      authMethods: [],
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: false,
        },
        sessionCapabilities: {},
      },
    };
  }

  async newSession(params: NewSessionRequest) {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(
        `cwd must be an absolute path: ${params.cwd}`,
      );
    }

    // Pi doesn't support mcpServers, but we accept and store.
    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
    });

    const models = await getModelState(session.proc);

    return {
      sessionId: session.sessionId,
      models,
      // Pi doesn't have session "modes".
      modes: {
        availableModes: [],
        currentModeId: "default",
      },
      _meta: {},
    };
  }

  async authenticate(_params: AuthenticateRequest) {
    // MVP: no auth.
    return;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);

    const { message, attachments } = promptToPiMessage(params.prompt);

    const result = await session.prompt(message, attachments);
    // ACP StopReason does not include "error"; map to end_turn for now.
    const stopReason: StopReason = result === "error" ? "end_turn" : result;
    return { stopReason };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    await session.cancel();
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    if (!isAbsolute(params.cwd)) {
      throw RequestError.invalidParams(
        `cwd must be an absolute path: ${params.cwd}`,
      );
    }

    // MVP: ignore mcpServers.
    const stored = this.store.get(params.sessionId);
    if (!stored) {
      throw RequestError.invalidParams(
        `Unknown sessionId: ${params.sessionId}`,
      );
    }

    // Spawn pi and point it directly at the stored session file.
    const proc = await PiRpcProcess.spawn({
      cwd: params.cwd,
      sessionPath: stored.sessionFile,
    });

    const session = this.sessions.getOrCreate(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      proc,
    });

    // (Optional) ensure mapping stays fresh.
    this.store.upsert({
      sessionId: params.sessionId,
      cwd: params.cwd,
      sessionFile: stored.sessionFile,
    });

    // Replay full conversation history.
    const data = (await proc.getMessages()) as any;
    const messages = Array.isArray(data?.messages) ? data.messages : [];

    for (const m of messages) {
      const role = String(m?.role ?? "");

      if (role === "user") {
        const text = normalizePiMessageText(m?.content);
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "user_message_chunk",
              content: { type: "text", text },
            },
          });
        }
      }

      if (role === "assistant") {
        const text = normalizePiAssistantText(m?.content);
        if (text) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          });
        }
      }
    }

    const models = await getModelState(proc);

    return {
      models,
      modes: {
        availableModes: [],
        currentModeId: "default",
      },
      _meta: {},
    };
  }

  async unstable_setSessionModel(params: {
    sessionId: string;
    modelId: string;
  }): Promise<void> {
    const session = this.sessions.get(params.sessionId);

    // Accept either:
    //  - "provider/model" (preferred, matches how we advertise)
    //  - "model" (fallback, we try to resolve via available models)
    let provider: string | null = null;
    let modelId: string | null = null;

    if (params.modelId.includes("/")) {
      const [p, ...rest] = params.modelId.split("/");
      provider = p;
      modelId = rest.join("/");
    } else {
      modelId = params.modelId;
    }

    if (!provider) {
      const data = (await session.proc.getAvailableModels()) as any;
      const models: any[] = Array.isArray(data?.models) ? data.models : [];
      const found = models.find((m) => String(m?.id) === modelId);
      if (found) {
        provider = String(found.provider);
        modelId = String(found.id);
      }
    }

    if (!provider || !modelId) {
      throw RequestError.invalidParams(`Unknown modelId: ${params.modelId}`);
    }

    await session.proc.setModel(provider, modelId);
  }

  async setSessionMode(): Promise<never> {
    throw RequestError.methodNotFound("setSessionMode");
  }
}


async function getModelState(proc: PiRpcProcess): Promise<{
  availableModels: ModelInfo[];
  currentModelId: string;
} | null> {
  // Ask pi for available models.
  let availableModels: ModelInfo[] = [];
  try {
    const data = (await proc.getAvailableModels()) as any;
    const models: any[] = Array.isArray(data?.models) ? data.models : [];
    availableModels = models
      .map((m) => {
        const provider = String(m?.provider ?? "").trim();
        const id = String(m?.id ?? "").trim();
        if (!provider || !id) return null;

        const name = String(m?.name ?? id);
        return {
          modelId: `${provider}/${id}`,
          name: `${provider}/${name}`,
          description: null,
        } satisfies ModelInfo;
      })
      .filter(Boolean) as ModelInfo[];
  } catch {
    // ignore
  }

  // Ask pi what model is currently active.
  let currentModelId: string | null = null;
  try {
    const state = (await proc.getState()) as any;
    const model = state?.model;
    if (model && typeof model === "object") {
      const provider = String((model as any).provider ?? "").trim();
      const id = String((model as any).id ?? "").trim();
      if (provider && id) currentModelId = `${provider}/${id}`;
    }
  } catch {
    // ignore
  }

  if (!availableModels.length && !currentModelId) return null;

  // Fallback if current model is unknown: use first in list.
  if (!currentModelId)
    currentModelId = availableModels[0]?.modelId ?? "default";

  return {
    availableModels,
    currentModelId,
  };
}

function readNearestPackageJson(metaUrl: string): {
  name?: string;
  version?: string;
} {
  try {
    let dir = dirname(fileURLToPath(metaUrl));

    // Walk upwards a few levels to find the nearest package.json
    for (let i = 0; i < 6; i++) {
      const p = join(dir, "package.json");
      if (existsSync(p)) {
        const json = JSON.parse(readFileSync(p, "utf-8")) as any;
        return { name: json?.name, version: json?.version };
      }
      dir = dirname(dir);
    }
  } catch {
    // ignore
  }
  return { name: "pi-acp", version: "0.0.0" };
}
