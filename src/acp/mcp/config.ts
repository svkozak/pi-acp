/**
 * MCP server config translation and project-local `.pi/mcp.json` management.
 *
 * pi has no built-in MCP support. The community `pi-mcp-adapter` extension
 * reads MCP server configuration from a well-known set of files, including the
 * project-local `.pi/mcp.json`. To wire ACP-provided stdio/http/sse MCP
 * servers through to pi, we translate them into pi-mcp-adapter's config format
 * and merge them into `.pi/mcp.json` for the duration of a session.
 *
 * ACP-transport (`type: "acp"`) servers are NOT handled here; they go through
 * the socket/shim bridge (see `bridge.ts`) and are presented to pi as stdio
 * servers by the `McpManager`.
 *
 * pi-mcp-adapter config format (subset we emit):
 *   { "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...} } } }
 *   { "mcpServers": { "<name>": { "type": "http"|"sse", "url": "...", "headers": {...} } } }
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { McpServer } from '@agentclientprotocol/sdk'

/** pi-mcp-adapter config entry. */
export type PiMcpServerConfig = {
  command?: string
  args?: string[]
  env?: Record<string, string>
  type?: 'http' | 'sse' | 'stdio'
  url?: string
  headers?: Record<string, string>
}

export type PiMcpConfig = {
  mcpServers: Record<string, PiMcpServerConfig>
}

/** Marker stored alongside managed config so we can identify our own writes. */
const MANAGED_MARKER_KEY = '_piAcpManaged'

function isObject(x: unknown): x is Record<string, unknown> {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x)
}

function envArrayToRecord(env: Array<{ name: string; value: string }> | undefined): Record<string, string> | undefined {
  if (!Array.isArray(env) || env.length === 0) return undefined
  const out: Record<string, string> = {}
  for (const e of env) {
    if (e && typeof e.name === 'string') out[e.name] = String(e.value ?? '')
  }
  return out
}

function headersArrayToRecord(
  headers: Array<{ name: string; value: string }> | undefined
): Record<string, string> | undefined {
  return envArrayToRecord(headers as Array<{ name: string; value: string }> | undefined)
}

/**
 * Translate an ACP MCP server (stdio/http/sse) into a pi-mcp-adapter config entry.
 * Returns `null` for `acp`-transport servers (handled by the bridge) or for
 * servers we cannot represent.
 */
export function acpMcpServerToPiConfig(server: McpServer): PiMcpServerConfig | null {
  if ('type' in server) {
    if (server.type === 'http' || server.type === 'sse') {
      const cfg: PiMcpServerConfig = { type: server.type, url: server.url }
      const headers = headersArrayToRecord(server.headers as Array<{ name: string; value: string }> | undefined)
      if (headers) cfg.headers = headers
      return cfg
    }

    if (server.type === 'acp') {
      // ACP transport is handled by the shim bridge, not the config file.
      return null
    }
    // Fall through: McpServerStdio may omit an explicit `type` field, but if an
    // explicit unknown type is present we don't know how to handle it.
    return null
  }

  // Stdio (default when no `type` field is present).
  const cfg: PiMcpServerConfig = { command: server.command, args: [...server.args] }
  const env = envArrayToRecord(server.env as Array<{ name: string; value: string }> | undefined)
  if (env) cfg.env = env
  return cfg
}

function readPiMcpConfig(path: string): PiMcpConfig {
  try {
    if (!existsSync(path)) return { mcpServers: {} }
    const raw = readFileSync(path, 'utf-8')
    const data = JSON.parse(raw)
    if (!isObject(data) || !isObject(data.mcpServers)) return { mcpServers: {} }
    return { mcpServers: data.mcpServers as Record<string, PiMcpServerConfig> }
  } catch {
    return { mcpServers: {} }
  }
}

function projectMcpConfigPath(cwd: string): string {
  return resolve(cwd, '.pi', 'mcp.json')
}

/**
 * Result of writing a managed MCP config. Call `restore()` when the session
 * ends to put back the original file contents.
 */
export interface ManagedMcpConfig {
  /** Path of the `.pi/mcp.json` that was (possibly) written. */
  path: string
  /** Restore the original file state. Safe to call multiple times. */
  restore: () => void
}

/**
 * Merge `managedServers` into the project-local `.pi/mcp.json`, preserving any
 * pre-existing user-managed servers (managed entries take precedence on name
 * collision, since the ACP client explicitly requested them for this session).
 *
 * A backup of the original file is kept next to it so `restore()` can recover
 * even if the process crashed between write and restore.
 */
export function writeManagedMcpConfig(
  cwd: string,
  managedServers: Record<string, PiMcpServerConfig>
): ManagedMcpConfig {
  const path = projectMcpConfigPath(cwd)
  const backupPath = `${path}.pi-acp.bak`

  if (Object.keys(managedServers).length === 0) {
    return { path, restore: () => {} }
  }

  const existing = readPiMcpConfig(path)

  // Preserve a backup of the true user file (only the first time we touch it
  // during this session) so repeated calls don't overwrite the backup with an
  // already-managed version.
  let backedUp = false
  try {
    if (existsSync(path) && !existsSync(backupPath)) {
      copyFileSync(path, backupPath)
      backedUp = true
    }
  } catch {
    // Best-effort backup; continue without it.
  }

  const merged: PiMcpConfig = {
    mcpServers: {
      ...existing.mcpServers,
      ...managedServers
    }
  }

  ;(merged as Record<string, unknown>)[MANAGED_MARKER_KEY] = true

  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8')
  } catch {
    // If we can't write the config, we simply can't offer these MCP servers to
    // pi. Don't throw — the rest of the session should still work.
    return { path, restore: () => {} }
  }

  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    try {
      if (existsSync(backupPath)) {
        // Restore the original user file from the backup (covers both the case
        // where we created it now and where a prior run left one behind).
        renameSync(backupPath, path)
      } else if (backedUp === false && existsSync(path)) {
        // No original existed and we created this file -> remove it.
        unlinkSync(path)
      }
    } catch {
      // ignore restore failures
    }
  }

  return { path, restore }
}
