#!/usr/bin/env node

// src/index.ts
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";

// src/acp/agent.ts
import {
  RequestError as RequestError3
} from "@agentclientprotocol/sdk";

// src/acp/auth.ts
var PI_SETUP_METHOD_ID = "pi_terminal_login";
function getAuthMethods(opts) {
  const supportsTerminalAuthMeta = opts?.supportsTerminalAuthMeta ?? true;
  const method = {
    id: PI_SETUP_METHOD_ID,
    name: "Launch pi in the terminal",
    description: "Start pi in an interactive terminal to configure API keys or login",
    // Registry-required fields
    type: "terminal",
    args: ["--terminal-login"],
    env: {}
  };
  if (supportsTerminalAuthMeta) {
    const launch = terminalAuthLaunchSpec();
    method._meta = {
      ...method._meta ?? {},
      "terminal-auth": {
        ...launch,
        label: "Launch pi"
      }
    };
  }
  return [method];
}
function terminalAuthLaunchSpec() {
  const argv0 = process.argv[0] || "node";
  const argv1 = process.argv[1];
  if (argv1 && argv0) {
    const isNode = argv0.includes("node");
    const isJs = argv1.endsWith(".js");
    if (isNode && isJs) {
      return { command: argv0, args: [argv1, "--terminal-login"] };
    }
  }
  return { command: "pi-acp", args: ["--terminal-login"] };
}

// src/acp/session.ts
import { RequestError as RequestError2 } from "@agentclientprotocol/sdk";
import { readFileSync as readFileSync3 } from "fs";
import { isAbsolute, resolve as resolvePath } from "path";

// src/pi-rpc/process.ts
import { spawn } from "child_process";
import * as readline from "readline";

// src/pi-rpc/command.ts
import { platform } from "os";
function defaultPiCommand() {
  return platform() === "win32" ? "pi.cmd" : "pi";
}
function getPiCommand(override) {
  return override ?? defaultPiCommand();
}
function shouldUseShellForPiCommand(cmd) {
  if (platform() !== "win32") return false;
  const normalized = cmd.trim().toLowerCase();
  return normalized.endsWith(".cmd") || normalized.endsWith(".bat");
}

// src/pi-rpc/process.ts
var PiRpcSpawnError = class extends Error {
  /** Underlying spawn error code, e.g. ENOENT, EACCES */
  code;
  constructor(message, opts) {
    super(message);
    this.name = "PiRpcSpawnError";
    this.code = opts?.code;
    this.cause = opts?.cause;
  }
};
var ESC = String.fromCharCode(27);
var CSI = String.fromCharCode(155);
var ANSI_ESCAPE_REGEX = new RegExp(
  `[${ESC}${CSI}][[\\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]`,
  "g"
);
function stripAnsi(s) {
  return s.replace(ANSI_ESCAPE_REGEX, "");
}
var PiRpcProcess = class _PiRpcProcess {
  child;
  pending = /* @__PURE__ */ new Map();
  eventHandlers = [];
  preludeLines = [];
  constructor(child) {
    this.child = child;
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        const cleaned = stripAnsi(String(line)).trimEnd();
        if (cleaned) this.preludeLines.push(cleaned);
        return;
      }
      if (msg?.type === "response") {
        const id = typeof msg.id === "string" ? msg.id : void 0;
        if (id) {
          const pending = this.pending.get(id);
          if (pending) {
            this.pending.delete(id);
            pending.resolve(msg);
            return;
          }
        }
      }
      for (const h of this.eventHandlers) h(msg);
    });
    child.on("exit", (code, signal) => {
      const err = new Error(`pi process exited (code=${code}, signal=${signal})`);
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
    child.on("error", (err) => {
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    });
  }
  static async spawn(params) {
    const cmd = getPiCommand(params.piCommand);
    const args = ["--mode", "rpc", "--no-themes"];
    if (params.sessionPath) args.push("--session", params.sessionPath);
    const child = spawn(cmd, args, {
      cwd: params.cwd,
      stdio: "pipe",
      env: process.env,
      shell: shouldUseShellForPiCommand(cmd)
    });
    try {
      await new Promise((resolve4, reject) => {
        const onSpawn = () => {
          cleanup();
          resolve4();
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          child.off("spawn", onSpawn);
          child.off("error", onError);
        };
        child.once("spawn", onSpawn);
        child.once("error", onError);
      });
    } catch (e) {
      const code = typeof e?.code === "string" ? e.code : void 0;
      if (code === "ENOENT") {
        throw new PiRpcSpawnError(
          `Could not start pi: executable not found (command: ${cmd}). Pi needs to be installed before it can run in ACP clients. Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH. Then try again.`,
          { code, cause: e }
        );
      }
      if (code === "EACCES") {
        throw new PiRpcSpawnError(`Could not start pi: permission denied (command: ${cmd}).`, { code, cause: e });
      }
      throw new PiRpcSpawnError(`Could not start pi (command: ${cmd}).`, { code, cause: e });
    }
    child.stderr.on("data", () => {
    });
    const proc = new _PiRpcProcess(child);
    try {
      const state = await proc.getState();
      const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null;
      if (sessionFile) {
        const { mkdirSync: mkdirSync2 } = await import("fs");
        const { dirname: dirname3 } = await import("path");
        mkdirSync2(dirname3(sessionFile), { recursive: true });
      }
    } catch {
    }
    return proc;
  }
  onEvent(handler) {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter((h) => h !== handler);
    };
  }
  dispose(signal = "SIGTERM") {
    if (this.child.killed) return;
    try {
      this.child.kill(signal);
    } catch {
    }
  }
  /**
   * Human-readable stdout lines emitted before RPC NDJSON begins (e.g. Context/Skills/Extensions info).
   * Themes are typically noisy/less useful for ACP, so callers can filter as needed.
   */
  consumePreludeLines() {
    const lines = this.preludeLines.splice(0, this.preludeLines.length);
    return lines;
  }
  async prompt(message, images = []) {
    const res = await this.request({ type: "prompt", message, images });
    if (!res.success) throw new Error(`pi prompt failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async abort() {
    const res = await this.request({ type: "abort" });
    if (!res.success) throw new Error(`pi abort failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async getState() {
    const res = await this.request({ type: "get_state" });
    if (!res.success) throw new Error(`pi get_state failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async getAvailableModels() {
    const res = await this.request({ type: "get_available_models" });
    if (!res.success) throw new Error(`pi get_available_models failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async setModel(provider, modelId) {
    const res = await this.request({ type: "set_model", provider, modelId });
    if (!res.success) throw new Error(`pi set_model failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async setThinkingLevel(level) {
    const res = await this.request({ type: "set_thinking_level", level });
    if (!res.success) throw new Error(`pi set_thinking_level failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async setFollowUpMode(mode) {
    const res = await this.request({ type: "set_follow_up_mode", mode });
    if (!res.success) throw new Error(`pi set_follow_up_mode failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async setSteeringMode(mode) {
    const res = await this.request({ type: "set_steering_mode", mode });
    if (!res.success) throw new Error(`pi set_steering_mode failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async compact(customInstructions) {
    const res = await this.request({ type: "compact", customInstructions });
    if (!res.success) throw new Error(`pi compact failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async setAutoCompaction(enabled) {
    const res = await this.request({ type: "set_auto_compaction", enabled });
    if (!res.success) throw new Error(`pi set_auto_compaction failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async getSessionStats() {
    const res = await this.request({ type: "get_session_stats" });
    if (!res.success) throw new Error(`pi get_session_stats failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async setSessionName(name) {
    const res = await this.request({ type: "set_session_name", name });
    if (!res.success) throw new Error(`pi set_session_name failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async exportHtml(outputPath) {
    const res = await this.request({ type: "export_html", outputPath });
    if (!res.success) throw new Error(`pi export_html failed: ${res.error ?? JSON.stringify(res.data)}`);
    const data = res.data;
    return { path: String(data?.path ?? "") };
  }
  async switchSession(sessionPath) {
    const res = await this.request({ type: "switch_session", sessionPath });
    if (!res.success) throw new Error(`pi switch_session failed: ${res.error ?? JSON.stringify(res.data)}`);
  }
  async getMessages() {
    const res = await this.request({ type: "get_messages" });
    if (!res.success) throw new Error(`pi get_messages failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async getCommands() {
    const res = await this.request({ type: "get_commands" });
    if (!res.success) throw new Error(`pi get_commands failed: ${res.error ?? JSON.stringify(res.data)}`);
    return res.data;
  }
  async sendExtensionUiResponse(response) {
    await this.writeLine(`${JSON.stringify({ type: "extension_ui_response", ...response })}
`);
  }
  request(cmd) {
    const id = crypto.randomUUID();
    const withId = { ...cmd, id };
    const line = `${JSON.stringify(withId)}
`;
    return new Promise((resolve4, reject) => {
      this.pending.set(id, { resolve: resolve4, reject });
      void this.writeLine(line).catch((error) => {
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  writeLine(line) {
    return new Promise((resolve4, reject) => {
      try {
        this.child.stdin.write(line, (error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve4();
        });
      } catch (error) {
        reject(error);
      }
    });
  }
};

// src/acp/auth-required.ts
import { RequestError } from "@agentclientprotocol/sdk";
function maybeAuthRequiredError(err) {
  const msg = String(err?.message ?? err ?? "");
  const s = msg.toLowerCase();
  const patterns = [
    "api key",
    "apikey",
    "missing key",
    "no key",
    "not configured",
    "unauthorized",
    "authentication",
    "permission denied",
    "forbidden",
    "401",
    "403"
  ];
  const hit = patterns.some((p) => s.includes(p));
  if (!hit) return null;
  return RequestError.authRequired(
    {
      authMethods: getAuthMethods()
    },
    "Configure an API key or log in with an OAuth provider."
  );
}

// src/acp/session-store.ts
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

// src/acp/paths.ts
import { homedir } from "os";
import { join } from "path";
function getPiAcpDir() {
  return join(homedir(), ".pi", "pi-acp");
}
function getPiAcpSessionMapPath() {
  return join(getPiAcpDir(), "session-map.json");
}

// src/acp/session-store.ts
function ensureParentDir(path) {
  mkdirSync(dirname(path), { recursive: true });
}
function loadFile(path) {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 1 || typeof parsed.sessions !== "object" || !parsed.sessions) {
      return { version: 1, sessions: {} };
    }
    return parsed;
  } catch {
    return { version: 1, sessions: {} };
  }
}
function saveFile(path, data) {
  ensureParentDir(path);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}
var SessionStore = class {
  path;
  constructor(path = getPiAcpSessionMapPath()) {
    this.path = path;
  }
  get(sessionId) {
    const db = loadFile(this.path);
    return db.sessions[sessionId] ?? null;
  }
  upsert(entry) {
    const db = loadFile(this.path);
    db.sessions[entry.sessionId] = {
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      sessionFile: entry.sessionFile,
      updatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    saveFile(this.path, db);
  }
  delete(sessionId) {
    const db = loadFile(this.path);
    if (!db.sessions[sessionId]) return;
    delete db.sessions[sessionId];
    saveFile(this.path, db);
  }
};

// src/acp/slash-commands.ts
import { existsSync, readdirSync, readFileSync as readFileSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join2, resolve } from "path";
function parseFrontmatter(content) {
  const frontmatter = {};
  if (!content.startsWith("---")) return { frontmatter, content };
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) return { frontmatter, content };
  const frontmatterBlock = content.slice(4, endIndex);
  const remaining = content.slice(endIndex + 4).trim();
  for (const line of frontmatterBlock.split("\n")) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) frontmatter[match[1]] = match[2].trim();
  }
  return { frontmatter, content: remaining };
}
function loadCommandsFromDir(dir, source, subdir = "") {
  const commands = [];
  if (!existsSync(dir)) return commands;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join2(dir, entry.name);
      if (entry.isDirectory()) {
        const newSubdir = subdir ? `${subdir}:${entry.name}` : entry.name;
        commands.push(...loadCommandsFromDir(fullPath, source, newSubdir));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        const rawContent = readFileSync2(fullPath, "utf-8");
        const { frontmatter, content } = parseFrontmatter(rawContent);
        const name = entry.name.slice(0, -3);
        const sourceStr = source === "user" ? subdir ? `(user:${subdir})` : "(user)" : subdir ? `(project:${subdir})` : "(project)";
        let description = frontmatter.description || "";
        if (!description) {
          const firstLine = content.split("\n").find((l) => l.trim());
          if (firstLine) {
            description = firstLine.slice(0, 60);
            if (firstLine.length > 60) description += "...";
          }
        }
        description = description ? `${description} ${sourceStr}` : sourceStr;
        commands.push({
          name,
          description,
          content,
          source: sourceStr
        });
      } catch {
      }
    }
  } catch {
  }
  return commands;
}
function loadSlashCommands(cwd) {
  const commands = [];
  const userDir = join2(homedir2(), ".pi", "agent", "prompts");
  const projectDir = resolve(cwd, ".pi", "prompts");
  commands.push(...loadCommandsFromDir(userDir, "user"));
  commands.push(...loadCommandsFromDir(projectDir, "project"));
  return commands;
}
function toAvailableCommands(fileCommands) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const c of fileCommands) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push({
      name: c.name,
      description: c.description
      // input: omitted for now (pi commands don't specify this)
    });
  }
  return out;
}
function parseCommandArgs(argsString) {
  const args = [];
  let current = "";
  let inQuote = null;
  for (let i = 0; i < argsString.length; i++) {
    const ch = argsString[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === " " || ch === "	") {
      if (current) {
        args.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) args.push(current);
  return args;
}
function substituteArgs(content, args) {
  let result = content;
  result = result.replace(/\$@/g, args.join(" "));
  result = result.replace(/\$(\d+)/g, (_m, num) => {
    const idx = Number.parseInt(String(num), 10) - 1;
    return args[idx] ?? "";
  });
  return result;
}
function expandSlashCommand(text, fileCommands) {
  if (!text.startsWith("/")) return text;
  const spaceIndex = text.indexOf(" ");
  const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  const argsString = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);
  const cmd = fileCommands.find((c) => c.name === commandName);
  if (!cmd) return text;
  const args = parseCommandArgs(argsString);
  return substituteArgs(cmd.content, args);
}

// src/acp/translate/pi-tools.ts
function toolResultToText(result) {
  if (!result) return "";
  const content = result.content;
  if (Array.isArray(content)) {
    const texts = content.map((c) => c?.type === "text" && typeof c.text === "string" ? c.text : "").filter(Boolean);
    if (texts.length) return texts.join("");
  }
  const details = result?.details;
  const diff = details?.diff;
  if (typeof diff === "string" && diff.trim()) {
    return diff;
  }
  const stdout = (typeof details?.stdout === "string" ? details.stdout : void 0) ?? (typeof result?.stdout === "string" ? result.stdout : void 0) ?? (typeof details?.output === "string" ? details.output : void 0) ?? (typeof result?.output === "string" ? result.output : void 0);
  const stderr = (typeof details?.stderr === "string" ? details.stderr : void 0) ?? (typeof result?.stderr === "string" ? result.stderr : void 0);
  const exitCode = (typeof details?.exitCode === "number" ? details.exitCode : void 0) ?? (typeof result?.exitCode === "number" ? result.exitCode : void 0) ?? (typeof details?.code === "number" ? details.code : void 0) ?? (typeof result?.code === "number" ? result.code : void 0);
  if (typeof stdout === "string" && stdout.trim() || typeof stderr === "string" && stderr.trim()) {
    const parts = [];
    if (typeof stdout === "string" && stdout.trim()) parts.push(stdout);
    if (typeof stderr === "string" && stderr.trim()) parts.push(`stderr:
${stderr}`);
    if (typeof exitCode === "number") parts.push(`exit code: ${exitCode}`);
    return parts.join("\n\n").trimEnd();
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

// src/acp/session.ts
var CONFIRM_PERMISSION_OPTIONS = [
  { optionId: "yes", name: "Yes", kind: "allow_once" },
  { optionId: "no", name: "No", kind: "reject_once" }
];
var EXTENSION_UI_RAW_INPUT_KEYS = ["title", "message", "options", "placeholder", "prefill"];
var CHOICE_OPTION_PREFIX = "choice-";
function findUniqueLineNumber(text, needle) {
  if (!needle) return void 0;
  const first = text.indexOf(needle);
  if (first < 0) return void 0;
  const second = text.indexOf(needle, first + needle.length);
  if (second >= 0) return void 0;
  let line = 1;
  for (let i = 0; i < first; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
function toToolCallLocations(args, cwd, line) {
  const path = typeof args?.path === "string" ? args.path : void 0;
  if (!path) return void 0;
  const resolvedPath = isAbsolute(path) ? path : resolvePath(cwd, path);
  return [{ path: resolvedPath, ...typeof line === "number" ? { line } : {} }];
}
var SessionManager = class {
  sessions = /* @__PURE__ */ new Map();
  store = new SessionStore();
  /** Dispose all sessions and their underlying pi subprocesses. */
  disposeAll() {
    for (const [id] of this.sessions) this.close(id);
  }
  /** Get a registered session if it exists (no throw). */
  maybeGet(sessionId) {
    return this.sessions.get(sessionId);
  }
  /**
   * Dispose a session's underlying pi process and remove it from the manager.
   * Used when clients explicitly reload a session and we want a fresh pi subprocess.
   */
  close(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    try {
      s.proc.dispose?.();
    } catch {
    }
    this.sessions.delete(sessionId);
  }
  /** Close all sessions except the one with `keepSessionId`. */
  closeAllExcept(keepSessionId) {
    for (const [id] of this.sessions) {
      if (id === keepSessionId) continue;
      this.close(id);
    }
  }
  async create(params) {
    let proc;
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        piCommand: params.piCommand
      });
    } catch (e) {
      if (e instanceof PiRpcSpawnError) {
        throw RequestError2.internalError({ code: e.code }, e.message);
      }
      throw e;
    }
    let state = null;
    try {
      state = await proc.getState();
    } catch {
      state = null;
    }
    const sessionId = typeof state?.sessionId === "string" ? state.sessionId : crypto.randomUUID();
    const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null;
    if (sessionFile) {
      this.store.upsert({ sessionId, cwd: params.cwd, sessionFile });
    }
    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? []
    });
    this.sessions.set(sessionId, session);
    return session;
  }
  get(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) throw RequestError2.invalidParams(`Unknown sessionId: ${sessionId}`);
    return s;
  }
  /**
   * Used by session/load: create a session object bound to an existing sessionId/proc
   * if it isn't already registered.
   */
  getOrCreate(sessionId, params) {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const session = new PiAcpSession({
      sessionId,
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      proc: params.proc,
      conn: params.conn,
      fileCommands: params.fileCommands ?? []
    });
    this.sessions.set(sessionId, session);
    return session;
  }
};
var PiAcpSession = class {
  sessionId;
  cwd;
  mcpServers;
  startupInfo = null;
  startupInfoSent = false;
  proc;
  conn;
  fileCommands;
  // Used to map abort semantics to ACP stopReason.
  // Applies to the currently running turn.
  cancelRequested = false;
  // Current in-flight turn (if any). Additional prompts are queued.
  pendingTurn = null;
  turnQueue = [];
  // Track tool call statuses and ensure they are monotonic (pending -> in_progress -> completed).
  // Some pi events can arrive out of order (e.g. late toolcall_* deltas after execution starts),
  // and clients may hide progress if we ever downgrade back to `pending`.
  currentToolCalls = /* @__PURE__ */ new Map();
  // pi can emit multiple `turn_end` events for a single user prompt (e.g. after tool_use).
  // The overall agent loop completes when `agent_end` is emitted.
  inAgentLoop = false;
  // For ACP diff support: capture file contents before edits, then emit ToolCallContent {type:"diff"}.
  // This is due to pi sending diff as a string as opposed to ACP expected diff format.
  // Compatible format may need to be implemented in pi in the future.
  editSnapshots = /* @__PURE__ */ new Map();
  // Ensure `session/update` notifications are sent in order and can be awaited
  // before completing a `session/prompt` request.
  lastEmit = Promise.resolve();
  constructor(opts) {
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd;
    this.mcpServers = opts.mcpServers;
    this.proc = opts.proc;
    this.conn = opts.conn;
    this.fileCommands = opts.fileCommands ?? [];
    this.proc.onEvent((ev) => this.handlePiEvent(ev));
  }
  setStartupInfo(text) {
    this.startupInfo = text;
    this.startupInfoSent = false;
  }
  /**
   * Best-effort attempt to send startup info outside of a prompt turn.
   * Some clients (e.g. Zed) may only render agent messages once the UI is ready;
   * callers can invoke this shortly after session/new returns.
   */
  sendStartupInfoIfPending() {
    if (this.startupInfoSent || !this.startupInfo) return;
    this.startupInfoSent = true;
    this.emit({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: this.startupInfo }
    });
  }
  async prompt(message, images = []) {
    const expandedMessage = expandSlashCommand(message, this.fileCommands);
    const turnPromise = new Promise((resolve4, reject) => {
      const queued = { message: expandedMessage, images, resolve: resolve4, reject };
      if (this.pendingTurn) {
        this.turnQueue.push(queued);
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: `Queued message (position ${this.turnQueue.length}).`
          }
        });
        this.emit({
          sessionUpdate: "session_info_update",
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
        });
        return;
      }
      this.startTurn(queued);
    });
    return turnPromise;
  }
  async cancel() {
    this.cancelRequested = true;
    if (this.turnQueue.length) {
      const queued = this.turnQueue.splice(0, this.turnQueue.length);
      for (const t of queued) t.resolve("cancelled");
      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Cleared queued prompts." }
      });
      this.emit({
        sessionUpdate: "session_info_update",
        _meta: { piAcp: { queueDepth: 0, running: Boolean(this.pendingTurn) } }
      });
    }
    await this.proc.abort();
  }
  wasCancelRequested() {
    return this.cancelRequested;
  }
  emit(update) {
    this.lastEmit = this.lastEmit.then(
      () => this.conn.sessionUpdate({
        sessionId: this.sessionId,
        update
      })
    ).catch(() => {
    });
  }
  async flushEmits() {
    await this.lastEmit;
  }
  startTurn(t) {
    this.cancelRequested = false;
    this.inAgentLoop = false;
    this.pendingTurn = { resolve: t.resolve, reject: t.reject };
    this.emit({
      sessionUpdate: "session_info_update",
      _meta: { piAcp: { queueDepth: this.turnQueue.length, running: true } }
    });
    this.proc.prompt(t.message, t.images).catch((err) => {
      void this.flushEmits().finally(() => {
        const authErr = maybeAuthRequiredError(err);
        if (authErr) {
          this.pendingTurn?.reject(authErr);
        } else {
          const reason = this.cancelRequested ? "cancelled" : "error";
          this.pendingTurn?.resolve(reason);
        }
        this.pendingTurn = null;
        this.inAgentLoop = false;
        this.emit({
          sessionUpdate: "session_info_update",
          _meta: { piAcp: { queueDepth: this.turnQueue.length, running: false } }
        });
      });
      void err;
    });
  }
  handlePiEvent(ev) {
    const type = String(ev.type ?? "");
    switch (type) {
      case "message_update": {
        const ame = ev.assistantMessageEvent;
        if (ame?.type === "text_delta" && typeof ame.delta === "string") {
          this.emit({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: ame.delta }
          });
          break;
        }
        if (ame?.type === "thinking_delta" && typeof ame.delta === "string") {
          this.emit({
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: ame.delta }
          });
          break;
        }
        if (ame?.type === "toolcall_start" || ame?.type === "toolcall_delta" || ame?.type === "toolcall_end") {
          const toolCall = (
            // pi sometimes includes the tool call directly on the event
            ame?.toolCall ?? // ...and always includes it in the partial assistant message at contentIndex
            ame?.partial?.content?.[ame?.contentIndex ?? 0]
          );
          const toolCallId = String(toolCall?.id ?? "");
          const toolName = String(toolCall?.name ?? "tool");
          if (toolCallId) {
            const rawInput = toolCall?.arguments && typeof toolCall.arguments === "object" ? toolCall.arguments : (() => {
              const s = String(toolCall?.partialArgs ?? "");
              if (!s) return void 0;
              try {
                return JSON.parse(s);
              } catch {
                return { partialArgs: s };
              }
            })();
            const locations = toToolCallLocations(rawInput, this.cwd);
            const existingStatus = this.currentToolCalls.get(toolCallId);
            const status = existingStatus ?? "pending";
            if (!existingStatus) {
              this.currentToolCalls.set(toolCallId, "pending");
              this.emit({
                sessionUpdate: "tool_call",
                toolCallId,
                title: toolName,
                kind: toToolKind(toolName),
                status,
                locations,
                rawInput
              });
            } else {
              this.emit({
                sessionUpdate: "tool_call_update",
                toolCallId,
                status,
                locations,
                rawInput
              });
            }
          }
          break;
        }
        break;
      }
      case "tool_execution_start": {
        const toolCallId = String(ev.toolCallId ?? crypto.randomUUID());
        const toolName = String(ev.toolName ?? "tool");
        const args = ev.args;
        let line;
        if (toolName === "edit") {
          const p = typeof args?.path === "string" ? args.path : void 0;
          if (p) {
            try {
              const abs = isAbsolute(p) ? p : resolvePath(this.cwd, p);
              const oldText = readFileSync3(abs, "utf8");
              this.editSnapshots.set(toolCallId, { path: p, oldText });
              const needle = typeof args?.oldText === "string" ? args.oldText : "";
              line = findUniqueLineNumber(oldText, needle);
            } catch {
            }
          }
        }
        const locations = toToolCallLocations(args, this.cwd, line);
        if (!this.currentToolCalls.has(toolCallId)) {
          this.currentToolCalls.set(toolCallId, "in_progress");
          this.emit({
            sessionUpdate: "tool_call",
            toolCallId,
            title: toolName,
            kind: toToolKind(toolName),
            status: "in_progress",
            locations,
            rawInput: args
          });
        } else {
          this.currentToolCalls.set(toolCallId, "in_progress");
          this.emit({
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: "in_progress",
            locations,
            rawInput: args
          });
        }
        break;
      }
      case "tool_execution_update": {
        const toolCallId = String(ev.toolCallId ?? "");
        if (!toolCallId) break;
        const partial = ev.partialResult;
        const text = toolResultToText(partial);
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: "in_progress",
          content: text ? [{ type: "content", content: { type: "text", text } }] : void 0,
          rawOutput: partial
        });
        break;
      }
      case "tool_execution_end": {
        const toolCallId = String(ev.toolCallId ?? "");
        if (!toolCallId) break;
        const result = ev.result;
        const isError = Boolean(ev.isError);
        const text = toolResultToText(result);
        const snapshot = this.editSnapshots.get(toolCallId);
        let content;
        if (!isError && snapshot) {
          try {
            const abs = isAbsolute(snapshot.path) ? snapshot.path : resolvePath(this.cwd, snapshot.path);
            const newText = readFileSync3(abs, "utf8");
            if (newText !== snapshot.oldText) {
              content = [
                {
                  type: "diff",
                  path: snapshot.path,
                  oldText: snapshot.oldText,
                  newText
                },
                ...text ? [{ type: "content", content: { type: "text", text } }] : []
              ];
            }
          } catch {
          }
        }
        if (!content && text) {
          content = [{ type: "content", content: { type: "text", text } }];
        }
        this.emit({
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: isError ? "failed" : "completed",
          content,
          rawOutput: result
        });
        this.currentToolCalls.delete(toolCallId);
        this.editSnapshots.delete(toolCallId);
        break;
      }
      case "extension_ui_request": {
        void this.handleExtensionUiRequest(ev).catch(() => {
          const id = stringProp(ev, "id");
          if (!id) {
            return;
          }
          void this.proc.sendExtensionUiResponse({ id, cancelled: true }).catch(() => {
          });
        });
        break;
      }
      case "auto_retry_start": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: formatAutoRetryMessage(ev) }
        });
        break;
      }
      case "auto_retry_end": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Retry finished, resuming." }
        });
        break;
      }
      case "auto_compaction_start": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Context nearing limit, running automatic compaction..."
          }
        });
        break;
      }
      case "auto_compaction_end": {
        this.emit({
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Automatic compaction finished; context was summarized to continue the session."
          }
        });
        break;
      }
      case "agent_start": {
        this.inAgentLoop = true;
        break;
      }
      case "turn_end": {
        break;
      }
      case "agent_end": {
        void this.flushEmits().finally(() => {
          const reason = this.cancelRequested ? "cancelled" : "end_turn";
          this.pendingTurn?.resolve(reason);
          this.pendingTurn = null;
          this.inAgentLoop = false;
          const next = this.turnQueue.shift();
          if (next) {
            this.emit({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Starting queued message. (${this.turnQueue.length} remaining)` }
            });
            this.startTurn(next);
          } else {
            this.emit({
              sessionUpdate: "session_info_update",
              _meta: { piAcp: { queueDepth: 0, running: false } }
            });
          }
        });
        break;
      }
      default:
        break;
    }
  }
  async handleExtensionUiRequest(ev) {
    const id = stringProp(ev, "id");
    const method = stringProp(ev, "method");
    if (!id) {
      return;
    }
    if (method === "select") {
      await this.handleExtensionSelect(ev, id);
      return;
    }
    if (method === "confirm") {
      await this.handleExtensionConfirm(ev, id);
      return;
    }
    if (method === "input" || method === "editor") {
      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `Pi ${method} UI request is not supported in ACP yet; cancelling it.`
        }
      });
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return;
    }
    if (method === "notify") {
      this.emit({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: stringProp(ev, "message") ?? "Pi notification" }
      });
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return;
    }
    await this.proc.sendExtensionUiResponse({ id, cancelled: true });
  }
  async handleExtensionSelect(ev, id) {
    const rawOptions = ev.options;
    const options = Array.isArray(rawOptions) ? rawOptions.map((option) => String(option)) : [];
    if (!options.length) {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return;
    }
    const permissionOptions = options.map((name, index2) => ({
      optionId: `${CHOICE_OPTION_PREFIX}${index2}`,
      name,
      kind: "allow_once"
    }));
    const selected = await this.requestExtensionPermission(id, ev, permissionOptions);
    if (selected === null) {
      return;
    }
    const selectedOptionId = selected.outcome.outcome === "selected" ? selected.outcome.optionId : null;
    const index = selectedOptionId === null ? null : optionIndex(selectedOptionId);
    const value = index === null ? null : options.at(index) ?? null;
    await this.proc.sendExtensionUiResponse(value === null ? { id, cancelled: true } : { id, value });
  }
  async handleExtensionConfirm(ev, id) {
    const selected = await this.requestExtensionPermission(id, ev, CONFIRM_PERMISSION_OPTIONS);
    if (selected === null) {
      return;
    }
    if (selected.outcome.outcome === "cancelled") {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return;
    }
    await this.proc.sendExtensionUiResponse({ id, confirmed: selected.outcome.optionId === "yes" });
  }
  async requestExtensionPermission(id, ev, options) {
    try {
      return await this.conn.requestPermission({
        sessionId: this.sessionId,
        toolCall: extensionUiToolCall(id, ev),
        options
      });
    } catch {
      await this.proc.sendExtensionUiResponse({ id, cancelled: true });
      return null;
    }
  }
};
function extensionUiToolCall(id, ev) {
  const method = stringProp(ev, "method") ?? "ui";
  const title = stringProp(ev, "title") ?? `Pi ${method}`;
  const rawInput = { method };
  for (const key of EXTENSION_UI_RAW_INPUT_KEYS) {
    if (Object.hasOwn(ev, key)) rawInput[key] = ev[key];
  }
  return {
    toolCallId: `pi-ui-${id}`,
    title,
    kind: "other",
    status: "pending",
    rawInput
  };
}
function stringProp(source, key) {
  const value = source[key];
  return typeof value === "string" ? value : null;
}
function optionIndex(optionId) {
  if (!optionId.startsWith(CHOICE_OPTION_PREFIX)) {
    return null;
  }
  const rawIndex = optionId.slice(CHOICE_OPTION_PREFIX.length);
  if (!rawIndex) {
    return null;
  }
  const index = Number(rawIndex);
  return Number.isSafeInteger(index) && index >= 0 && String(index) === rawIndex ? index : null;
}
function formatAutoRetryMessage(ev) {
  const attempt = Number(ev.attempt);
  const maxAttempts = Number(ev.maxAttempts);
  const delayMs = Number(ev.delayMs);
  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts) || !Number.isFinite(delayMs)) {
    return "Retrying...";
  }
  let delaySeconds = Math.round(delayMs / 1e3);
  if (delayMs > 0 && delaySeconds === 0) delaySeconds = 1;
  return `Retrying (attempt ${attempt}/${maxAttempts}, waiting ${delaySeconds}s)...`;
}
function toToolKind(toolName) {
  switch (toolName) {
    case "read":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "bash":
      return "other";
    default:
      return "other";
  }
}

// src/acp/pi-sessions.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync4, statSync, openSync, readSync, closeSync, existsSync as existsSync2 } from "fs";
import { homedir as homedir3 } from "os";
import { join as join3, resolve as resolve2, isAbsolute as isAbsolute2 } from "path";
var DEFAULT_TAIL_BYTES = 256 * 1024;
var DEFAULT_HEAD_BYTES = 64 * 1024;
function getPiAgentDir() {
  return process.env.PI_CODING_AGENT_DIR ? resolve2(process.env.PI_CODING_AGENT_DIR) : join3(homedir3(), ".pi", "agent");
}
function readSessionDirFromSettings(agentDir) {
  const settingsPath = join3(agentDir, "settings.json");
  try {
    if (!existsSync2(settingsPath)) return null;
    const raw = readFileSync4(settingsPath, "utf8");
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const sessionDir = data.sessionDir;
    if (typeof sessionDir !== "string" || !sessionDir.trim()) return null;
    return isAbsolute2(sessionDir) ? sessionDir : resolve2(agentDir, sessionDir);
  } catch {
    return null;
  }
}
function getPiSessionsDir() {
  const agentDir = getPiAgentDir();
  return readSessionDirFromSettings(agentDir) ?? join3(agentDir, "sessions");
}
function walkJsonlFiles(dir, out) {
  let entries;
  try {
    entries = readdirSync2(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const e of entries) {
    const name = typeof e.name === "string" ? e.name : String(e.name);
    const p = join3(dir, name);
    if (e.isDirectory()) walkJsonlFiles(p, out);
    else if (e.isFile() && name.endsWith(".jsonl")) out.push(p);
  }
}
function readFirstLine(path) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(DEFAULT_HEAD_BYTES);
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (n <= 0) return null;
    const s = buf.subarray(0, n).toString("utf-8");
    const idx = s.indexOf("\n");
    return idx === -1 ? s.trim() : s.slice(0, idx).trim();
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
    }
  }
}
function readTail(path, tailBytes = DEFAULT_TAIL_BYTES) {
  const st = statSync(path);
  const start = Math.max(0, st.size - tailBytes);
  const len = st.size - start;
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, buf.length, start);
    return buf.subarray(0, n).toString("utf-8");
  } finally {
    try {
      closeSync(fd);
    } catch {
    }
  }
}
function parseSessionHeader(firstLine) {
  try {
    const obj = JSON.parse(firstLine);
    if (obj?.type !== "session") return null;
    const sessionId = typeof obj?.id === "string" ? obj.id : null;
    const cwd = typeof obj?.cwd === "string" ? obj.cwd : null;
    if (!sessionId || !cwd) return null;
    return { sessionId, cwd };
  } catch {
    return null;
  }
}
function pickTitleFromTail(tail) {
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.type === "session_info" && typeof obj?.name === "string" && obj.name.trim()) {
        return obj.name.trim();
      }
    } catch {
    }
  }
  return null;
}
function scanSessionInfoNameFromFile(path) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(256 * 1024);
    let leftover = "";
    let offset = 0;
    let lastName = null;
    while (true) {
      const n = readSync(fd, buf, 0, buf.length, offset);
      if (n <= 0) break;
      offset += n;
      const chunk = leftover + buf.subarray(0, n).toString("utf8");
      const lines = chunk.split(/\r?\n/);
      leftover = lines.pop() ?? "";
      for (const line0 of lines) {
        const line = line0.trim();
        if (!line) continue;
        try {
          const obj = JSON.parse(line);
          if (obj?.type === "session_info" && typeof obj?.name === "string" && obj.name.trim()) {
            lastName = obj.name.trim();
          }
        } catch {
        }
      }
    }
    const tailLine = leftover.trim();
    if (tailLine) {
      try {
        const obj = JSON.parse(tailLine);
        if (obj?.type === "session_info" && typeof obj?.name === "string" && obj.name.trim()) {
          lastName = obj.name.trim();
        }
      } catch {
      }
    }
    return lastName;
  } catch {
    return null;
  } finally {
    try {
      closeSync(fd);
    } catch {
    }
  }
}
function pickUpdatedAtFromTail(tail) {
  const lines = tail.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      if (obj?.type !== "message") continue;
      const ts = typeof obj?.timestamp === "string" ? obj.timestamp : null;
      if (!ts) continue;
      const d = new Date(ts);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    } catch {
    }
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const ts = typeof obj?.timestamp === "string" ? obj.timestamp : null;
      if (!ts) continue;
      const d = new Date(ts);
      if (Number.isFinite(d.getTime())) return d.toISOString();
    } catch {
    }
  }
  return null;
}
function pickFallbackTitleFromHead(path) {
  try {
    const raw = readFileSync4(path, { encoding: "utf8" });
    const lines = raw.split(/\r?\n/);
    for (const line0 of lines) {
      const line = line0.trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj?.type === "message" && obj?.message?.role === "user") {
          const content = obj?.message?.content;
          if (typeof content === "string") return content.slice(0, 80);
          if (Array.isArray(content)) {
            const t = content.find((c) => c?.type === "text" && typeof c?.text === "string");
            if (t?.text) return String(t.text).slice(0, 80);
          }
        }
      } catch {
      }
      if (lines.length > 2e3) break;
    }
  } catch {
  }
  return null;
}
function listPiSessions() {
  const sessionsDir = getPiSessionsDir();
  const files = [];
  walkJsonlFiles(sessionsDir, files);
  const items = [];
  for (const file of files) {
    const first = readFirstLine(file);
    if (!first) continue;
    const header = parseSessionHeader(first);
    if (!header) continue;
    let updatedAt = null;
    let title = null;
    try {
      const tail = readTail(file);
      title = pickTitleFromTail(tail);
      updatedAt = pickUpdatedAtFromTail(tail);
    } catch {
    }
    if (!title) {
      title = scanSessionInfoNameFromFile(file);
    }
    if (!updatedAt) {
      try {
        updatedAt = statSync(file).mtime.toISOString();
      } catch {
        updatedAt = null;
      }
    }
    if (!title) {
      title = pickFallbackTitleFromHead(file);
    }
    items.push({
      sessionId: header.sessionId,
      cwd: header.cwd,
      title,
      updatedAt,
      sessionFile: file
    });
  }
  items.sort((a, b) => {
    const aa = a.updatedAt ?? "";
    const bb = b.updatedAt ?? "";
    return bb.localeCompare(aa);
  });
  return items;
}
function findPiSessionFile(sessionId) {
  const all = listPiSessions();
  const found = all.find((s) => s.sessionId === sessionId);
  return found?.sessionFile ?? null;
}

// src/acp/translate/pi-messages.ts
function normalizePiMessageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c) => c?.type === "text" && typeof c.text === "string" ? c.text : "").filter(Boolean).join("");
}
function normalizePiAssistantText(content) {
  if (!Array.isArray(content)) return "";
  return content.map((c) => c?.type === "text" && typeof c.text === "string" ? c.text : "").filter(Boolean).join("");
}

// src/acp/translate/prompt.ts
function promptToPiMessage(blocks) {
  let message = "";
  const images = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        message += b.text;
        break;
      case "resource_link":
        message += `
[Context] ${b.uri}`;
        break;
      case "image": {
        images.push({
          type: "image",
          mimeType: b.mimeType,
          data: b.data
        });
        break;
      }
      case "resource": {
        const r = b.resource;
        const uri = typeof r?.uri === "string" ? r.uri : "(unknown)";
        if (typeof r?.text === "string") {
          const mime = typeof r?.mimeType === "string" ? r.mimeType : "text/plain";
          message += `
[Embedded Context] ${uri} (${mime})
${r.text}`;
        } else if (typeof r?.blob === "string") {
          const mime = typeof r?.mimeType === "string" ? r.mimeType : "application/octet-stream";
          const bytes = Buffer.byteLength(r.blob, "base64");
          message += `
[Embedded Context] ${uri} (${mime}, ${bytes} bytes)`;
        } else {
          message += `
[Embedded Context] ${uri}`;
        }
        break;
      }
      case "audio": {
        const bytes = Buffer.byteLength(b.data, "base64");
        message += `
[Audio] (${b.mimeType}, ${bytes} bytes) not supported by pi-acp`;
        break;
      }
      default:
        break;
    }
  }
  return { message, images };
}

// src/acp/pi-settings.ts
import { existsSync as existsSync3, readFileSync as readFileSync5 } from "fs";
import { homedir as homedir4 } from "os";
import { join as join4, resolve as resolve3 } from "path";
function isObject(x) {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}
function deepMerge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const av = out[k];
    if (isObject(av) && isObject(v)) out[k] = deepMerge(av, v);
    else out[k] = v;
  }
  return out;
}
function readJsonFile(path) {
  try {
    if (!existsSync3(path)) return {};
    const raw = readFileSync5(path, "utf-8");
    const data = JSON.parse(raw);
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}
function getMergedSettings(cwd) {
  const globalSettingsPath = join4(getAgentDir(), "settings.json");
  const projectSettingsPath = resolve3(cwd, ".pi", "settings.json");
  const global = readJsonFile(globalSettingsPath);
  const project = readJsonFile(projectSettingsPath);
  return deepMerge(global, project);
}
function getAgentDir() {
  return process.env.PI_CODING_AGENT_DIR ? resolve3(process.env.PI_CODING_AGENT_DIR) : join4(homedir4(), ".pi", "agent");
}
function getEnableSkillCommands(cwd) {
  const merged = getMergedSettings(cwd);
  const direct = merged.enableSkillCommands;
  if (typeof direct === "boolean") return direct;
  const nested = isObject(merged.skills) ? merged.skills.enableSkillCommands : void 0;
  if (typeof nested === "boolean") return nested;
  return true;
}
function getQuietStartup(cwd) {
  const merged = getMergedSettings(cwd);
  const direct = merged.quietStartup;
  if (typeof direct === "boolean") return direct;
  const legacy = merged.quietStart;
  if (typeof legacy === "boolean") return legacy;
  return false;
}

// src/acp/pi-commands.ts
function describeFallback(c) {
  const source = typeof c.source === "string" ? c.source : "";
  const location = typeof c.location === "string" ? c.location : "";
  const parts = [];
  if (source) parts.push(source);
  if (location) parts.push(location);
  return parts.length ? `(${parts.join(":")})` : "(command)";
}
function toAvailableCommandsFromPiGetCommands(data, opts) {
  const enableSkillCommands = opts?.enableSkillCommands ?? true;
  const includeExtensionCommands = opts?.includeExtensionCommands ?? false;
  const root = data;
  const commandsRaw = Array.isArray(root?.commands) ? root.commands : Array.isArray(root?.data?.commands) ? root.data.commands : [];
  const out = [];
  for (const c of commandsRaw) {
    const name = typeof c?.name === "string" ? c.name.trim() : "";
    if (!name) continue;
    const source = typeof c?.source === "string" ? c.source : "";
    if (!includeExtensionCommands && source === "extension") continue;
    if (!enableSkillCommands && name.startsWith("skill:")) continue;
    const desc = typeof c?.description === "string" ? c.description.trim() : "";
    out.push({
      name,
      description: desc || describeFallback(c)
    });
  }
  return { commands: out, raw: commandsRaw };
}

// src/acp/agent.ts
import { isAbsolute as isAbsolute3 } from "path";
import { existsSync as existsSync4, readFileSync as readFileSync6, realpathSync, readdirSync as readdirSync3, statSync as statSync2, unlinkSync } from "fs";
import { join as join5, dirname as dirname2, basename } from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
var modelCatalogCache = /* @__PURE__ */ new Map();
function builtinAvailableCommands() {
  return [
    {
      name: "compact",
      description: "Manually compact the session context",
      input: { hint: "optional custom instructions" }
    },
    {
      name: "autocompact",
      description: "Toggle automatic context compaction",
      input: { hint: "on|off|toggle" }
    },
    {
      name: "export",
      description: "Export session to an HTML file in the session cwd"
    },
    {
      name: "session",
      description: "Show session stats (messages, tokens, cost, session file)"
    },
    {
      name: "name",
      description: "Set session display name",
      input: { hint: "<name>" }
    },
    {
      name: "steering",
      description: "Get/set pi steering message delivery mode (how queued steering messages are delivered)",
      input: { hint: "(no args to show) all | one-at-a-time" }
    },
    {
      name: "follow-up",
      description: "Get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)",
      input: { hint: "(no args to show) all | one-at-a-time" }
    },
    {
      name: "changelog",
      description: "Show pi changelog"
    }
  ];
}
function mergeCommands(a, b) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const c of [...a, ...b]) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    out.push(c);
  }
  return out;
}
var pkg = readNearestPackageJson(import.meta.url);
var PiAcpAgent = class {
  conn;
  sessions = new SessionManager();
  store = new SessionStore();
  dispose() {
    this.sessions.disposeAll();
  }
  // Remember recent session cwd and use it as the default filter.
  lastSessionCwd = null;
  constructor(conn, _config) {
    this.conn = conn;
    void _config;
  }
  cleanupFailedNewSession(sessionId, state) {
    this.sessions.close(sessionId);
    const sessionFile = typeof state?.sessionFile === "string" && state.sessionFile.trim() ? state.sessionFile : this.store.get(sessionId)?.sessionFile;
    if (typeof sessionFile === "string" && sessionFile.trim()) {
      try {
        if (existsSync4(sessionFile)) unlinkSync(sessionFile);
      } catch {
      }
    }
    this.store.delete(sessionId);
  }
  async initialize(params) {
    const supportedVersion = 1;
    const requested = params.protocolVersion;
    return {
      protocolVersion: requested === supportedVersion ? requested : supportedVersion,
      agentInfo: {
        name: pkg.name ?? "pi-acp",
        title: "pi ACP adapter",
        version: pkg.version ?? "0.0.0"
      },
      // Zed currently uses ClientCapabilities._meta["terminal-auth"] to decide whether to show
      // the "Authenticate" banner/button. If not supported, we still return the method for the registry.
      authMethods: getAuthMethods({
        supportsTerminalAuthMeta: params?.clientCapabilities?._meta?.["terminal-auth"] === true
      }),
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: false, sse: false },
        promptCapabilities: {
          image: true,
          audio: false,
          embeddedContext: process.env.PI_ACP_ENABLE_EMBEDDED_CONTEXT === "true"
        },
        sessionCapabilities: {
          // **UNSTABLE** ACP capability used by Zed's codex-acp adapter.
          // Enables a native session picker in clients that support it.
          list: {}
        }
      }
    };
  }
  async newSession(params) {
    if (!isAbsolute3(params.cwd)) {
      throw RequestError3.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }
    this.lastSessionCwd = params.cwd;
    const fileCommands = loadSlashCommands(params.cwd);
    const enableSkillCommands = getEnableSkillCommands(params.cwd);
    const session = await this.sessions.create({
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      fileCommands,
      piCommand: process.env.PI_ACP_PI_COMMAND
    });
    let state = null;
    let availableModels = null;
    let stateErr = null;
    let availableModelsErr = null;
    await Promise.all([
      session.proc.getState().then((s) => {
        state = s;
      }).catch((err) => {
        stateErr = err;
        state = null;
      }),
      session.proc.getAvailableModels().then((m) => {
        availableModels = m;
      }).catch((err) => {
        availableModelsErr = err;
        availableModels = null;
      })
    ]);
    const availableModelsAuthErr = maybeAuthRequiredError(availableModelsErr);
    if (availableModelsAuthErr) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw availableModelsAuthErr;
    }
    if (availableModelsErr) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError3.internalError({}, String(availableModelsErr?.message ?? availableModelsErr));
    }
    const rawModelsCount = Array.isArray(availableModels?.models) ? availableModels.models.length : 0;
    if (rawModelsCount === 0) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError3.authRequired(
        { authMethods: getAuthMethods() },
        "Configure an API key or log in with an OAuth provider."
      );
    }
    if (stateErr && maybeAuthRequiredError(stateErr)) {
      this.cleanupFailedNewSession(session.sessionId, state);
      throw RequestError3.authRequired(
        { authMethods: getAuthMethods() },
        "Configure an API key or log in with an OAuth provider."
      );
    }
    const models = await getModelState(session.proc, { state, availableModels });
    const configOptions = toConfigOptions(models);
    const thinking = await getThinkingState(session.proc, { state });
    const quietStartup = getQuietStartup(params.cwd);
    const updateNotice = buildUpdateNotice();
    const preludeText = quietStartup ? updateNotice ? updateNotice + "\n" : "" : buildStartupInfo({
      cwd: params.cwd,
      fileCommands,
      updateNotice
    });
    if (preludeText)
      session.setStartupInfo(preludeText);
    this.sessions.closeAllExcept?.(session.sessionId);
    const response = {
      sessionId: session.sessionId,
      ...configOptions.length > 0 ? { configOptions } : {},
      models,
      modes: thinking,
      _meta: {
        piAcp: {
          startupInfo: preludeText || null
        }
      }
    };
    if (preludeText) setTimeout(() => session.sendStartupInfoIfPending(), 0);
    setTimeout(() => {
      void emitUsageUpdate(this.conn, session.sessionId, session.proc, models);
    }, 0);
    setTimeout(() => {
      void (async () => {
        try {
          const pi = await session.proc.getCommands();
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: false
          });
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          });
          return;
        } catch {
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        });
      })();
    }, 0);
    return response;
  }
  async authenticate(_params) {
    return;
  }
  async prompt(params) {
    const session = this.sessions.get(params.sessionId);
    const { message, images } = promptToPiMessage(params.prompt);
    if (images.length === 0 && message.trimStart().startsWith("/")) {
      const trimmed = message.trim();
      const space = trimmed.indexOf(" ");
      const cmd = space === -1 ? trimmed.slice(1) : trimmed.slice(1, space);
      const argsString = space === -1 ? "" : trimmed.slice(space + 1);
      const args = parseCommandArgs(argsString);
      if (cmd === "compact") {
        const customInstructions = args.join(" ").trim() || void 0;
        const res = await session.proc.compact(customInstructions);
        const r = res && typeof res === "object" ? res : null;
        const tokensBefore = typeof r?.tokensBefore === "number" ? r.tokensBefore : null;
        const summary = typeof r?.summary === "string" ? r.summary : null;
        const headerLines = [
          `Compaction completed.${customInstructions ? " (custom instructions applied)" : ""}`,
          tokensBefore !== null ? `Tokens before: ${tokensBefore}` : null
        ].filter(Boolean);
        const text = headerLines.join("\n") + (summary ? `

${summary}` : "");
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "session") {
        const stats = await session.proc.getSessionStats();
        const lines = [];
        if (stats?.sessionId) lines.push(`Session: ${stats.sessionId}`);
        if (stats?.sessionFile) lines.push(`Session file: ${stats.sessionFile}`);
        if (typeof stats?.totalMessages === "number") lines.push(`Messages: ${stats.totalMessages}`);
        if (typeof stats?.cost === "number") lines.push(`Cost: ${stats.cost}`);
        const t = stats?.tokens;
        if (t && typeof t === "object") {
          const parts = [];
          if (typeof t.input === "number") parts.push(`in ${t.input}`);
          if (typeof t.output === "number") parts.push(`out ${t.output}`);
          if (typeof t.cacheRead === "number") parts.push(`cache read ${t.cacheRead}`);
          if (typeof t.cacheWrite === "number") parts.push(`cache write ${t.cacheWrite}`);
          if (typeof t.total === "number") parts.push(`total ${t.total}`);
          if (parts.length) lines.push(`Tokens: ${parts.join(", ")}`);
        }
        const text = lines.length ? lines.join("\n") : `Session stats:
${JSON.stringify(stats, null, 2)}`;
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "name") {
        const name = args.join(" ").trim();
        if (!name) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Usage: /name <name>" }
            }
          });
          return { stopReason: "end_turn" };
        }
        try {
          await session.proc.setSessionName(name);
        } catch (e) {
          const msg = String(e?.message ?? e);
          const hint = /set_session_name/i.test(msg) ? " This requires a newer pi version that supports `set_session_name` in RPC mode." : "";
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Failed to set session name: ${msg}${hint}` }
            }
          });
          return { stopReason: "end_turn" };
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "session_info_update",
            title: name,
            updatedAt: (/* @__PURE__ */ new Date()).toISOString()
          }
        });
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Session name set: ${name}` }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "steering") {
        const modeRaw = String(args[0] ?? "").toLowerCase();
        const state = await session.proc.getState();
        const current = String(state?.steeringMode ?? "");
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Steering mode: ${current || "unknown"}`
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Usage: /steering all | /steering one-at-a-time"
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        await session.proc.setSteeringMode(modeRaw);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Steering mode set to: ${modeRaw}` }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "follow-up") {
        const modeRaw = String(args[0] ?? "").toLowerCase();
        const state = await session.proc.getState();
        const current = String(state?.followUpMode ?? "");
        if (!modeRaw) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Follow-up mode: ${current || "unknown"}`
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        if (modeRaw !== "all" && modeRaw !== "one-at-a-time") {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Usage: /follow-up all | /follow-up one-at-a-time"
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        await session.proc.setFollowUpMode(modeRaw);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `Follow-up mode set to: ${modeRaw}` }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "changelog") {
        const findChangelog = () => {
          try {
            const whichCmd = process.platform === "win32" ? "where" : "which";
            const which = spawnSync(whichCmd, ["pi"], { encoding: "utf-8" });
            const piPath = String(which.stdout ?? "").split(/\r?\n/)[0]?.trim();
            if (piPath) {
              const resolved = realpathSync(piPath);
              const pkgRoot = dirname2(dirname2(resolved));
              const p = join5(pkgRoot, "CHANGELOG.md");
              if (existsSync4(p)) return p;
            }
          } catch {
          }
          try {
            const npmRoot = spawnSync("npm", ["root", "-g"], { encoding: "utf-8" });
            const root = String(npmRoot.stdout ?? "").trim();
            if (root) {
              const p = join5(root, "@earendil-works", "pi-coding-agent", "CHANGELOG.md");
              if (existsSync4(p)) return p;
            }
          } catch {
          }
          return null;
        };
        const changelogPath = findChangelog();
        if (!changelogPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Changelog not found (couldn't locate pi installation)." }
            }
          });
          return { stopReason: "end_turn" };
        }
        let text = "";
        try {
          text = readFileSync6(changelogPath, "utf-8");
        } catch (e) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Failed to read changelog: ${String(e?.message ?? e)}` }
            }
          });
          return { stopReason: "end_turn" };
        }
        const maxChars = 2e4;
        if (text.length > maxChars) text = text.slice(0, maxChars) + "\n\n...(truncated)...";
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "export") {
        const state = await session.proc.getState();
        const sessionFile = typeof state?.sessionFile === "string" ? state.sessionFile : null;
        const messageCount = typeof state?.messageCount === "number" ? state.messageCount : 0;
        if (!sessionFile || messageCount === 0 || !existsSync4(sessionFile)) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Nothing to export yet (no session messages). Send a prompt first."
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        try {
          const raw = readFileSync6(sessionFile, "utf-8");
          if (raw.trim().length === 0) {
            await this.conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: "Nothing to export yet (empty session file). Send a prompt first."
                }
              }
            });
            return { stopReason: "end_turn" };
          }
        } catch {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Couldn't read session file for export. Try sending a prompt first."
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        const safeSessionId = session.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
        const outputPath = join5(session.cwd, `pi-session-${safeSessionId}.html`);
        let resultPath = "";
        try {
          const result2 = await session.proc.exportHtml(outputPath);
          resultPath = result2.path;
        } catch (e) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: `Export failed: ${String(e?.message ?? e)}`
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        if (!resultPath) {
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: "Export failed: no output path returned by pi."
              }
            }
          });
          return { stopReason: "end_turn" };
        }
        const uri = `file://${resultPath}`;
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Session exported: "
            }
          }
        });
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "resource_link",
              name: `pi-session-${safeSessionId}.html`,
              uri,
              mimeType: "text/html",
              title: "Session exported"
            }
          }
        });
        return { stopReason: "end_turn" };
      }
      if (cmd === "autocompact") {
        const mode = (args[0] ?? "toggle").toLowerCase();
        let enabled = null;
        if (mode === "on" || mode === "true" || mode === "enable" || mode === "enabled") enabled = true;
        else if (mode === "off" || mode === "false" || mode === "disable" || mode === "disabled") enabled = false;
        if (enabled === null) {
          const state = await session.proc.getState();
          const current = Boolean(state?.autoCompactionEnabled);
          enabled = !current;
        }
        await session.proc.setAutoCompaction(enabled);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: `Auto-compaction ${enabled ? "enabled" : "disabled"}.`
            }
          }
        });
        return { stopReason: "end_turn" };
      }
    }
    const result = await session.prompt(message, images);
    const stopReason = result === "error" ? session.wasCancelRequested() ? "cancelled" : "end_turn" : result;
    await emitUsageUpdate(this.conn, session.sessionId, session.proc);
    return { stopReason };
  }
  async cancel(params) {
    const session = this.sessions.get(params.sessionId);
    await session.cancel();
  }
  async unstable_listSessions(params) {
    const all = listPiSessions();
    const effectiveCwd = params.cwd ?? this.lastSessionCwd;
    const filtered = effectiveCwd ? all.filter((s) => s.cwd === effectiveCwd) : all;
    const offset = params.cursor ? Number.parseInt(params.cursor, 10) : 0;
    const start = Number.isFinite(offset) && offset > 0 ? offset : 0;
    const PAGE_SIZE = 50;
    const page = filtered.slice(start, start + PAGE_SIZE);
    const sessions = page.map((s) => ({
      sessionId: s.sessionId,
      cwd: s.cwd,
      title: s.title,
      updatedAt: s.updatedAt
    }));
    const nextCursor = start + PAGE_SIZE < filtered.length ? String(start + PAGE_SIZE) : null;
    return { sessions, nextCursor, _meta: {} };
  }
  async loadSession(params) {
    if (!isAbsolute3(params.cwd)) {
      throw RequestError3.invalidParams(`cwd must be an absolute path: ${params.cwd}`);
    }
    this.sessions.close(params.sessionId);
    this.lastSessionCwd = params.cwd;
    const stored = this.store.get(params.sessionId);
    const sessionFile = stored?.sessionFile ?? findPiSessionFile(params.sessionId);
    if (!sessionFile) {
      throw RequestError3.invalidParams(`Unknown sessionId: ${params.sessionId}`);
    }
    let proc;
    try {
      proc = await PiRpcProcess.spawn({
        cwd: params.cwd,
        sessionPath: sessionFile,
        piCommand: process.env.PI_ACP_PI_COMMAND
      });
    } catch (e) {
      if (e?.name === "PiRpcSpawnError") {
        throw RequestError3.internalError({ code: e?.code }, String(e?.message ?? e));
      }
      throw e;
    }
    const fileCommands = loadSlashCommands(params.cwd);
    const enableSkillCommands = getEnableSkillCommands(params.cwd);
    const session = this.sessions.getOrCreate(params.sessionId, {
      cwd: params.cwd,
      mcpServers: params.mcpServers,
      conn: this.conn,
      proc,
      fileCommands
    });
    this.sessions.closeAllExcept?.(session.sessionId);
    this.store.upsert({
      sessionId: params.sessionId,
      cwd: params.cwd,
      sessionFile
    });
    const data = await proc.getMessages();
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
              content: { type: "text", text }
            }
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
              content: { type: "text", text }
            }
          });
        }
      }
      if (role === "toolResult") {
        const toolName = String(m?.toolName ?? "tool");
        const toolCallId = String(m?.toolCallId ?? crypto.randomUUID());
        const isError = Boolean(m?.isError);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: toolName,
            kind: toolName === "read" ? "read" : toolName === "write" || toolName === "edit" ? "edit" : "other",
            status: "completed",
            rawInput: null,
            rawOutput: m
          }
        });
        const text = toolResultToText(m);
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            status: isError ? "failed" : "completed",
            content: text ? [{ type: "content", content: { type: "text", text } }] : null,
            rawOutput: m
          }
        });
      }
    }
    const models = await getModelState(proc);
    const configOptions = toConfigOptions(models);
    const thinking = await getThinkingState(proc);
    const response = {
      ...configOptions.length > 0 ? { configOptions } : {},
      models,
      modes: thinking,
      _meta: {
        piAcp: {
          startupInfo: null
        }
      }
    };
    setTimeout(() => {
      void emitUsageUpdate(this.conn, session.sessionId, proc, models);
    }, 0);
    setTimeout(() => {
      void (async () => {
        try {
          const pi = await proc.getCommands();
          const { commands } = toAvailableCommandsFromPiGetCommands(pi, {
            enableSkillCommands,
            includeExtensionCommands: false
          });
          await this.conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "available_commands_update",
              availableCommands: mergeCommands(commands, builtinAvailableCommands())
            }
          });
          return;
        } catch {
        }
        await this.conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: mergeCommands(toAvailableCommands(fileCommands), builtinAvailableCommands())
          }
        });
      })();
    }, 0);
    return response;
  }
  async unstable_setSessionModel(params) {
    const session = this.sessions.get(params.sessionId);
    await setSessionModel(session.proc, params.modelId);
  }
  async setSessionConfigOption(params) {
    const session = this.sessions.get(params.sessionId);
    if (params.configId !== "model") {
      throw RequestError3.invalidParams(`Unknown configId: ${params.configId}`);
    }
    await setSessionModel(session.proc, params.value);
    const models = await getModelState(session.proc);
    const configOptions = toConfigOptions(models);
    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "config_option_update",
        configOptions
      }
    });
    await emitUsageUpdate(this.conn, session.sessionId, session.proc, models);
    return { configOptions };
  }
  async setSessionMode(params) {
    const session = this.sessions.get(params.sessionId);
    const mode = String(params.modeId);
    if (!isThinkingLevel(mode)) {
      throw RequestError3.invalidParams(`Unknown modeId: ${mode}`);
    }
    await session.proc.setThinkingLevel(mode);
    void this.conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "current_mode_update",
        modeId: mode
      }
    });
    return {};
  }
};
function isThinkingLevel(x) {
  return x === "off" || x === "minimal" || x === "low" || x === "medium" || x === "high" || x === "xhigh";
}
async function getThinkingState(proc, pre) {
  let current = "medium";
  const state = pre?.state ?? await (async () => {
    try {
      return await proc.getState();
    } catch {
      return null;
    }
  })();
  const tl = typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null;
  if (tl && isThinkingLevel(tl)) current = tl;
  const available = ["off", "minimal", "low", "medium", "high", "xhigh"];
  return {
    currentModeId: current,
    availableModes: available.map((id) => ({
      id,
      name: `Thinking: ${id}`,
      description: null
    }))
  };
}
function parseCompactTokenCount(value) {
  if (!value) return void 0;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
  if (!match) return void 0;
  const amount = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(amount)) return void 0;
  const unit = (match[2] ?? "").toUpperCase();
  const multiplier = unit === "B" ? 1e9 : unit === "M" ? 1e6 : unit === "K" ? 1e3 : 1;
  return Math.round(amount * multiplier);
}
function getPiCatalogCommand() {
  return process.env.PI_ACP_PI_COMMAND?.trim() || "pi";
}
function getModelCatalog() {
  const command = getPiCatalogCommand();
  const cached = modelCatalogCache.get(command);
  if (cached) return cached;
  try {
    const result = spawnSync(command, ["--list-models"], { encoding: "utf-8", timeout: 15e3 });
    const lines = String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
    const catalog = /* @__PURE__ */ new Map();
    for (const line of lines.slice(1)) {
      const [provider, model, context, maxOut, thinking, images] = line.trim().split(/\s{2,}/).map((part) => part.trim());
      if (!provider || !model) continue;
      const description = [
        context ? `${context} context` : null,
        maxOut ? `${maxOut} max out` : null,
        thinking === "yes" ? "thinking" : null,
        images === "yes" ? "images" : null
      ].filter(Boolean).join(" \xB7 ");
      catalog.set(`${provider}/${model}`, {
        ...context ? { contextWindow: parseCompactTokenCount(context) } : {},
        ...description ? { description } : {}
      });
    }
    modelCatalogCache.set(command, catalog);
    return catalog;
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
async function getModelState(proc, pre) {
  let availableModels = [];
  const data = pre?.availableModels ?? await (async () => {
    try {
      return await proc.getAvailableModels();
    } catch {
      return null;
    }
  })();
  const catalog = getModelCatalog();
  const models = Array.isArray(data?.models) ? data.models : [];
  availableModels = models.map((m) => {
    const provider = String(m?.provider ?? "").trim();
    const id = String(m?.id ?? "").trim();
    if (!provider || !id) return null;
    const name = String(m?.name ?? id);
    const modelId = `${provider}/${id}`;
    return {
      modelId,
      name: `${provider}/${name}`,
      description: catalog.get(modelId)?.description ?? null
    };
  }).filter(Boolean);
  let currentModelId = null;
  const state = pre?.state ?? await (async () => {
    try {
      return await proc.getState();
    } catch {
      return null;
    }
  })();
  const model = state?.model;
  if (model && typeof model === "object") {
    const provider = String(model.provider ?? "").trim();
    const id = String(model.id ?? "").trim();
    if (provider && id) currentModelId = `${provider}/${id}`;
  }
  if (!availableModels.length && !currentModelId) return null;
  if (!currentModelId) currentModelId = availableModels[0]?.modelId ?? "default";
  return {
    availableModels,
    currentModelId
  };
}
function toConfigOptions(models) {
  if (!models) return [];
  return [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: models.currentModelId,
      options: models.availableModels.map((model) => ({
        value: model.modelId,
        name: model.name,
        description: model.description ?? null
      })),
      _meta: { category: "model" }
    }
  ];
}
async function setSessionModel(proc, requestedModelId) {
  let provider = null;
  let modelId = null;
  if (requestedModelId.includes("/")) {
    const [p, ...rest] = requestedModelId.split("/");
    provider = p;
    modelId = rest.join("/");
  } else {
    modelId = requestedModelId;
  }
  if (!provider) {
    const data = await proc.getAvailableModels();
    const models = Array.isArray(data?.models) ? data.models : [];
    const found = models.find((m) => String(m?.id) === modelId);
    if (found) {
      provider = String(found.provider);
      modelId = String(found.id);
    }
  }
  if (!provider || !modelId) throw RequestError3.invalidParams(`Unknown modelId: ${requestedModelId}`);
  await proc.setModel(provider, modelId);
}
async function emitUsageUpdate(conn, sessionId, proc, models) {
  try {
    const stats = await proc.getSessionStats();
    const used = typeof stats?.tokens?.total === "number" ? stats.tokens.total : null;
    if (used === null) return;
    const activeModelId = models?.currentModelId ?? (typeof stats?.model === "string" ? stats.model : null);
    const size = (activeModelId ? getModelCatalog().get(activeModelId)?.contextWindow : void 0) ?? used;
    await conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "usage_update",
        used,
        size,
        ...typeof stats?.cost === "number" ? { cost: { amount: stats.cost, currency: "USD" } } : {}
      }
    });
  } catch {
  }
}
function isSemver(v) {
  return /^\d+\.\d+\.\d+(?:[-+].+)?$/.test(v);
}
function compareSemver(a, b) {
  const pa = a.split(/[.-]/).slice(0, 3).map((n) => Number(n));
  const pb = b.split(/[.-]/).slice(0, 3).map((n) => Number(n));
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}
function buildUpdateNotice() {
  try {
    const piVersion = spawnSync("pi", ["--version"], { encoding: "utf-8" });
    const installed = (String(piVersion.stdout ?? "").trim() || String(piVersion.stderr ?? "").trim()).replace(
      /^v/i,
      ""
    );
    if (!installed || !isSemver(installed)) return null;
    const latestRes = spawnSync("npm", ["view", "@earendil-works/pi-coding-agent", "version"], {
      encoding: "utf-8",
      timeout: 800
    });
    const latest = String(latestRes.stdout ?? "").trim().replace(/^v/i, "");
    if (!latest || !isSemver(latest)) return null;
    if (compareSemver(latest, installed) <= 0) return null;
    return `New version available: v${latest} (installed v${installed}). Run: \`npm i -g @earendil-works/pi-coding-agent\``;
  } catch {
    return null;
  }
}
function buildStartupInfo(opts) {
  void opts.fileCommands;
  const md = [];
  try {
    const piVersion = spawnSync("pi", ["--version"], { encoding: "utf-8" });
    const installed = (String(piVersion.stdout ?? "").trim() || String(piVersion.stderr ?? "").trim()).replace(
      /^v/i,
      ""
    );
    if (installed) {
      md.push(`pi v${installed}`);
      md.push("---");
      md.push("");
    }
  } catch {
  }
  const addSection = (title, items) => {
    const cleaned = items.map((s) => s.trim()).filter(Boolean);
    if (!cleaned.length) return;
    md.push(`## ${title}`);
    for (const item of cleaned) md.push(`- ${item}`);
    md.push("");
  };
  const contextItems = [];
  const contextPath = join5(opts.cwd, "AGENTS.md");
  if (existsSync4(contextPath)) contextItems.push(contextPath);
  addSection("Context", contextItems);
  const skillsItems = [];
  const pushSkillFromRoot = (root) => {
    try {
      for (const e of readdirSync3(root)) {
        const p = join5(root, e);
        try {
          const st = statSync2(p);
          if (st.isFile() && e.toLowerCase().endsWith(".md")) {
            skillsItems.push(p);
          }
        } catch {
        }
      }
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop();
        let entries = [];
        try {
          entries = readdirSync3(dir);
        } catch {
          continue;
        }
        for (const name of entries) {
          if (name === "node_modules" || name === ".git") continue;
          const p = join5(dir, name);
          let st;
          try {
            st = statSync2(p);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            stack.push(p);
          } else if (st.isFile() && name === "SKILL.md") {
            skillsItems.push(p);
          }
        }
      }
    } catch {
    }
  };
  const globalSkillsDir = join5(getAgentDir(), "skills");
  pushSkillFromRoot(globalSkillsDir);
  const legacyAgentsSkillsDir = join5(process.env.HOME ?? "", ".agents", "skills");
  pushSkillFromRoot(legacyAgentsSkillsDir);
  const projectSkillsDir = join5(opts.cwd, ".pi", "skills");
  pushSkillFromRoot(projectSkillsDir);
  addSection("Skills", skillsItems);
  const promptsItems = [];
  const promptsDir = join5(process.env.HOME ?? "", ".pi", "agent", "prompts");
  try {
    const prompts = readdirSync3(promptsDir).filter((f) => f.endsWith(".md"));
    for (const f of prompts) promptsItems.push(`/${basename(f, ".md")}`);
  } catch {
  }
  addSection("Prompts", promptsItems);
  const extItems = [];
  const extDir = join5(process.env.HOME ?? "", ".pi", "agent", "extensions");
  try {
    const exts = readdirSync3(extDir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
    for (const f of exts) extItems.push(join5(extDir, f));
  } catch {
  }
  try {
    const settingsPath = join5(process.env.HOME ?? "", ".pi", "agent", "settings.json");
    const settings = JSON.parse(readFileSync6(settingsPath, "utf-8"));
    const pkgs = Array.isArray(settings?.packages) ? settings.packages : [];
    for (const pkg2 of pkgs) {
      const s = String(pkg2);
      if (s.startsWith("npm:")) {
        extItems.push(`${s}
  - index.ts`);
      } else {
        extItems.push(s);
      }
    }
  } catch {
  }
  addSection("Extensions", extItems);
  if (opts.updateNotice) {
    md.push("---");
    md.push(opts.updateNotice);
    md.push("");
  }
  return md.join("\n").trim() + "\n";
}
function readNearestPackageJson(metaUrl) {
  try {
    let dir = dirname2(fileURLToPath(metaUrl));
    for (let i = 0; i < 6; i++) {
      const p = join5(dir, "package.json");
      if (existsSync4(p)) {
        const json = JSON.parse(readFileSync6(p, "utf-8"));
        return { name: json?.name, version: json?.version };
      }
      dir = dirname2(dir);
    }
  } catch {
  }
  return { name: "pi-acp", version: "0.0.0" };
}

// src/index.ts
if (process.argv.includes("--terminal-login")) {
  const { spawnSync: spawnSync2 } = await import("child_process");
  const cmd = getPiCommand(process.env.PI_ACP_PI_COMMAND);
  const res = spawnSync2(cmd, [], {
    stdio: "inherit",
    env: process.env,
    shell: shouldUseShellForPiCommand(cmd)
  });
  if (res.error && res.error.code === "ENOENT") {
    process.stderr.write(
      `pi-acp: could not start pi (command not found: ${cmd}). Install it via \`npm install -g @earendil-works/pi-coding-agent\` or ensure \`pi\` is on your PATH.
`
    );
    process.exit(1);
  }
  process.exit(typeof res.status === "number" ? res.status : 1);
}
var input = new WritableStream({
  write(chunk) {
    return new Promise((resolve4) => {
      if (process.stdout.destroyed || !process.stdout.writable) return resolve4();
      try {
        process.stdout.write(chunk, (err) => {
          void err;
          resolve4();
        });
      } catch {
        resolve4();
      }
    });
  }
});
var output = new ReadableStream({
  start(controller) {
    process.stdin.on("data", (chunk) => controller.enqueue(new Uint8Array(chunk)));
    process.stdin.on("end", () => controller.close());
    process.stdin.on("error", (err) => controller.error(err));
  }
});
var stream = ndJsonStream(input, output);
var agent = new AgentSideConnection((conn) => new PiAcpAgent(conn), stream);
function shutdown() {
  try {
    ;
    agent?.agent?.dispose?.();
  } catch {
  }
  try {
    process.exit(0);
  } catch {
  }
}
process.stdin.on("end", shutdown);
process.stdin.on("close", shutdown);
process.stdin.resume();
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdout.on("error", () => {
  try {
    process.exit(0);
  } catch {
  }
});
//# sourceMappingURL=index.js.map