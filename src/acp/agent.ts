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
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type StopReason,
} from "@agentclientprotocol/sdk";
import { SessionManager } from "./session.js";
import { SessionStore } from "./session-store.js";
import { PiRpcProcess } from "../pi-rpc/process.js";
import { normalizePiAssistantText, normalizePiMessageText } from "./translate/pi-messages.js";
import { promptToPiMessage } from "./translate/prompt.js";
import { loadSlashCommands, parseCommandArgs, toAvailableCommands } from "./slash-commands.js";
import { isAbsolute } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { AvailableCommand } from "@agentclientprotocol/sdk";
import { dirname, join } from "node:path";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

function builtinAvailableCommands(): AvailableCommand[] {
  return [
    {
      name: "compact",
      description: "Manually compact the session context",
      input: { hint: "optional custom instructions" },
    },
    {
      name: "autocompact",
      description: "Toggle automatic context compaction",
      input: { hint: "on|off|toggle" },
    },
  ];
}

function mergeCommands(a: AvailableCommand[], b: AvailableCommand[]): AvailableCommand[] {
  // Preserve order, de-dupe by name (first wins).
  const out: AvailableCommand[] = [];
  const seen = new Set<string>();

  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }

  return out;
}
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

    const fileCommands = loadSlashCommands(params.cwd);

    // Pi doesn't support mcpServers, but we accept and store.
    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      fileCommands,
    });

    const models = await getModelState(session.proc);
    const thinking = await getThinkingState(session.proc);

    const response = {
      sessionId: session.sessionId,
      models,
      modes: thinking,
      _meta: {},
    };

    // Advertise slash commands (ACP: available_commands_update)
    // Important: some clients (e.g. Zed) will ignore notifications for an unknown sessionId.
    // So we must send this *after* the session/new response has been delivered.
    setTimeout(() => {
      void this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: mergeCommands(
            toAvailableCommands(fileCommands),
            builtinAvailableCommands(),
          ),
        },
      });
    }, 0);

    return response;
  }

  async authenticate(_params: AuthenticateRequest) {
    // MVP: no auth.
    return;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);

    const { message, attachments } = promptToPiMessage(params.prompt);

    // Built-in ACP slash command handling (headless-friendly subset).
    // Note: file-based slash commands are expanded inside session.prompt().
    if (attachments.length === 0 && message.trimStart().startsWith("/")) {
      const trimmed = message.trim();
      const space = trimmed.indexOf(" ");
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
      const argsString = space === -1 ? "" : trimmed.slice(space + 1);
      const args = parseCommandArgs(argsString);

      if (cmd === "compact") {
        const customInstructions = args.join(" ").trim() || undefined;
        const res = await session.proc.compact(customInstructions);

        const r: any = res && typeof res === "object" ? (res as any) : null;
        const tokensBefore = typeof r?.tokensBefore === "number" ? r.tokensBefore : null;
        const summary = typeof r?.summary === "string" ? r.summary : null;

        const headerLines = [
          `Compaction completed.${customInstructions ? " (custom instructions applied)" : ""}`,
          tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null,
        ].filter(Boolean);

        const text = headerLines.join("\n") + (summary ? `\n\n${summary}` : "");

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        });

        return { stopReason: "end_turn" };
      }

      if (cmd === "autocompact") {
        const mode = (args[0] ?? "toggle").toLowerCase();
        let enabled: boolean | null = null;
        if (mode === "on" || mode === "true" || mode === "enable" || mode === "enabled") enabled = true;
        else if (mode === "off" || mode === "false" || mode === "disable" || mode === "disabled") enabled = false;

        if (enabled === null) {
          // toggle: read current state and invert.
          const state = (await session.proc.getState()) as any;
          const current = Boolean(state?.autoCompactionEnabled);
          enabled = !current;
        }

        await session.proc.setAutoCompaction(enabled);

        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Auto-compaction ${enabled ? "enabled" : "disabled"}.` },
          },
        });

        return { stopReason: "end_turn" };
      }
    }

    const result = await session.prompt(message, attachments);

    // ACP StopReason does not include "error"; if pi fails we map to end_turn for now,
    // unless we know this was a cancellation.
    const stopReason: StopReason = result === "error"
      ? (session.wasCancelRequested() ? "cancelled" : "end_turn")
      : result;

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

    const fileCommands = loadSlashCommands(params.cwd);

    const session = this.sessions.getOrCreate(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      proc,
      fileCommands,
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
    const thinking = await getThinkingState(proc);

    const response = {
      models,
      modes: thinking,
      _meta: {},
    };

    // Advertise slash commands after the response so the client knows the session exists.
    setTimeout(() => {
      void this.conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: mergeCommands(
            toAvailableCommands(fileCommands),
            builtinAvailableCommands(),
          ),
        },
      });
    }, 0);

    return response;
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

  async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
    const session = this.sessions.get(params.sessionId);

    const mode = String(params.modeId);
    if (!isThinkingLevel(mode)) {
      throw RequestError.invalidParams(`Unknown modeId: ${mode}`);
    }

    await session.proc.setThinkingLevel(mode);

    // Let the client know the current mode changed (keeps the dropdown in sync).
    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: mode,
      },
    });

    return {};
  }
}

function isThinkingLevel(x: string): x is ThinkingLevel {
  return x === "off" || x === "minimal" || x === "low" || x === "medium" || x === "high" || x === "xhigh";
}

async function getThinkingState(proc: PiRpcProcess): Promise<{
  availableModes: Array<{ id: string; name: string; description?: string | null }>;
  currentModeId: string;
}> {
  // Ask pi for current thinking level.
  let current: ThinkingLevel = "medium";
  try {
    const state = (await proc.getState()) as any;
    const tl = typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null;
    if (tl && isThinkingLevel(tl)) current = tl;
  } catch {
    // ignore
  }

  const available: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

  return {
    currentModeId: current,
    availableModes: available.map((id) => ({
      id,
      name: `Thinking: ${id}`,
      description: null,
    })),
  };
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
