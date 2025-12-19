import {
  RequestError,
  type Agent as ACPAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type CancelNotification,
  type ContentBlock,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { SessionManager } from "./session.js";
import { SessionStore } from "./session-store.js";
import { PiRpcProcess } from "../pi-rpc/process.js";
// (paths.ts currently only provides the adapter-owned session map location.)
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

    return null;
  }

  async unstable_setSessionModel(): Promise<never> {
    throw RequestError.methodNotFound("unstable_setSessionModel");
  }

  async setSessionMode(): Promise<never> {
    throw RequestError.methodNotFound("setSessionMode");
  }
}

function normalizePiMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) =>
      c?.type === "text" && typeof c.text === "string" ? c.text : "",
    )
    .filter(Boolean)
    .join("");
}

function normalizePiAssistantText(content: unknown): string {
  // Assistant content is typically an array of blocks; only replay text blocks for MVP.
  if (!Array.isArray(content)) return "";
  return content
    .map((c: any) =>
      c?.type === "text" && typeof c.text === "string" ? c.text : "",
    )
    .filter(Boolean)
    .join("");
}

function promptToPiMessage(blocks: ContentBlock[]): {
  message: string;
  attachments: PiAttachment[];
} {
  let message = "";
  const attachments: PiAttachment[] = [];

  for (const b of blocks) {
    switch (b.type) {
      case "text":
        message += b.text;
        break;

      case "resource_link":
        message += `\n[Context] ${b.uri}`;
        break;

      case "image": {
        const id = b.uri ?? crypto.randomUUID();
        // pi expects base64 without data-url prefix.
        const size = Buffer.byteLength(b.data, "base64");
        attachments.push({
          id,
          type: "image",
          fileName: guessFileNameFromMime(b.mimeType),
          mimeType: b.mimeType,
          size,
          content: b.data,
        });
        break;
      }

      // Not supported in pi-acp MVP.
      case "audio":
      case "resource":
        break;

      default:
        break;
    }
  }

  return { message, attachments };
}

type PiAttachment = {
  id: string;
  type: "image" | "document";
  fileName: string;
  mimeType: string;
  size: number;
  content: string;
  extractedText?: string;
  preview?: string;
};

function guessFileNameFromMime(mimeType: string): string {
  const ext =
    mimeType === "image/png"
      ? "png"
      : mimeType === "image/jpeg"
        ? "jpg"
        : mimeType === "image/webp"
          ? "webp"
          : "bin";
  return `attachment.${ext}`;
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
