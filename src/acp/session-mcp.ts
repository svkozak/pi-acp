import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'

/**
 * One `mcpServers` entry of pi's `mcp.json`.
 * pi connects stdio servers by `command` and streamable HTTP servers by `url`;
 * it has no SSE transport, so ACP servers of type "sse" cannot be passed on.
 */
export type PiMcpServer =
  | { url: string; headers?: Record<string, string> }
  | { command: string; args?: string[]; env?: Record<string, string> }

type PiMcpConfig = { mcpServers?: Record<string, PiMcpServer>; [key: string]: unknown }

/** Prefix of the per-session agent directories this module creates. */
const SESSION_DIR_PREFIX = '.acp-session-'

function toPiServer(server: McpServer): PiMcpServer | undefined {
  if ('command' in server) {
    const env = Object.fromEntries(server.env.map(entry => [entry.name, entry.value]))
    return { command: server.command, args: server.args, ...(Object.keys(env).length === 0 ? {} : { env }) }
  }
  if (server.type === 'http') {
    const headers = Object.fromEntries(server.headers.map(header => [header.name, header.value]))
    return Object.keys(headers).length === 0 ? { url: server.url } : { url: server.url, headers }
  }
  return undefined
}

function agentDirPath(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
}

function readMcpConfig(dir: string): PiMcpConfig {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'mcp.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** A file is hard linked, since the session directory sits inside the agent directory. */
function linkEntry(target: string, link: string): void {
  try {
    if (statSync(target).isDirectory()) {
      symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
      return
    }
    try {
      linkSync(target, link)
    } catch {
      copyFileSync(target, link)
    }
  } catch {
    // A resource that cannot be linked is left out: pi then starts without it,
    // which beats failing the session over, say, a broken symlink in the agent directory.
  }
}

/**
 * An agent directory for one pi process: everything from the user's agent
 * directory, plus an `mcp.json` that also lists the MCP servers the ACP client
 * sent with the session.
 *
 * pi reads only one agent directory, and its project-level `.pi/mcp.json` needs
 * project trust, so a session directory is the way to hand it servers that are
 * not in the user's own configuration. It is built inside the agent directory so
 * hard links and junctions stay on the same volume, and the caller removes it
 * once the pi process exits.
 *
 * Returns undefined when there is nothing to add, in which case pi runs on the
 * user's own agent directory.
 */
export function createSessionAgentDir(servers: McpServer[] | undefined): string | undefined {
  const sessionServers: Record<string, PiMcpServer> = {}
  for (const server of servers ?? []) {
    const entry = toPiServer(server)
    if (entry !== undefined) sessionServers[server.name] = entry
  }
  if (Object.keys(sessionServers).length === 0) return undefined

  const agentDir = agentDirPath()
  mkdirSync(agentDir, { recursive: true })
  const dir = mkdtempSync(join(agentDir, SESSION_DIR_PREFIX))
  for (const name of readdirSync(agentDir)) {
    if (name === 'mcp.json' || name.startsWith(SESSION_DIR_PREFIX)) continue
    linkEntry(join(agentDir, name), join(dir, name))
  }

  const config = readMcpConfig(agentDir)
  const mcpServers = { ...(config.mcpServers ?? {}), ...sessionServers }
  writeFileSync(join(dir, 'mcp.json'), `${JSON.stringify({ ...config, mcpServers }, null, 2)}\n`)

  // pi stores MCP sign-in tokens in mcp-auth.json. The session directory would
  // write its own copy and take the sign-in down with it, so that file points at
  // the user's, dangling until pi writes it.
  if (!existsSync(join(dir, 'mcp-auth.json'))) {
    try {
      symlinkSync(join(agentDir, 'mcp-auth.json'), join(dir, 'mcp-auth.json'))
    } catch {
      // Without symlink rights (Windows without Developer Mode) a sign-in made in
      // this session is lost when it ends; the tools still work while it runs.
    }
  }

  return dir
}

export function removeSessionAgentDir(dir: string | undefined): void {
  if (dir === undefined) return
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // Leftover directories are harmless and removed with the agent directory.
  }
}
