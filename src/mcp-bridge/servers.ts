import type { McpServer } from '@agentclientprotocol/sdk'
import { Type, type TSchema } from 'typebox'

/**
 * The spawned pi reads the session's MCP servers from its process env (one pi
 * process per ACP session, so a per-process hand-off is per-session safe).
 */
export const MCP_SERVERS_ENV = 'PI_ACP_MCP_SERVERS'

export type BridgeServerPlan =
  | { kind: 'stdio'; server: string; command: string; args: string[]; env: Record<string, string> }
  | { kind: 'http'; server: string; url: string; headers: Record<string, string> }
  | { kind: 'sse'; server: string; url: string; headers: Record<string, string> }

function listToRecord(list: unknown): Record<string, string> {
  if (!Array.isArray(list)) return {}
  const out: Record<string, string> = {}
  for (const entry of list) {
    const name = (entry as { name?: unknown })?.name
    const value = (entry as { value?: unknown })?.value
    if (typeof name === 'string' && typeof value === 'string') out[name] = value
  }
  return out
}

/**
 * Map one ACP `mcpServers` entry to the transport the bridge extension should
 * open for it. Servers that need the ACP channel itself (`type: "acp"`,
 * unstable) cannot be bridged into a pi extension and answer null.
 */
export function toBridgePlan(server: McpServer): BridgeServerPlan | null {
  const type = (server as { type?: unknown }).type
  const command = (server as { command?: unknown }).command

  if (typeof command === 'string' && command.length > 0) {
    const args = (server as { args?: unknown }).args
    return {
      kind: 'stdio',
      server: server.name,
      command,
      args: Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : [],
      env: listToRecord((server as { env?: unknown }).env)
    }
  }
  const url = (server as { url?: unknown }).url
  if (type === 'http' && typeof url === 'string') {
    return { kind: 'http', server: server.name, url, headers: listToRecord((server as { headers?: unknown }).headers) }
  }
  if (type === 'sse' && typeof url === 'string') {
    return { kind: 'sse', server: server.name, url, headers: listToRecord((server as { headers?: unknown }).headers) }
  }
  return null
}

/** pi tool names allow [a-zA-Z0-9_-] only; everything else collapses to `_`. */
const toolSafe = (text: string): string => String(text).replace(/[^a-zA-Z0-9_-]/g, '_')

/**
 * The name the LLM calls: `${server}_${tool}`. Prefixed so tools from
 * different MCP servers cannot collide with each other or with pi builtins.
 */
export const bridgeToolName = (server: string, tool: string): string => `${toolSafe(server)}_${toolSafe(tool)}`

/**
 * Convert an MCP tool's `inputSchema` (JSON Schema) to the TypeBox schema
 * pi.registerTool() demands. The common shapes convert 1:1; anything outside
 * them (anyOf/oneOf, format-decorated strings, ...) falls back to Type.Any()
 * rather than being guessed at.
 */
export function schemaToTypebox(schema: unknown): TSchema {
  const convert = (s: unknown): TSchema => {
    if (s === null || typeof s !== 'object') return Type.Any()
    const record = s as Record<string, unknown>
    const description = typeof record.description === 'string' ? record.description : undefined

    if (Array.isArray(record.enum) && record.enum.length > 0) {
      return Type.Union(
        record.enum.map(v => Type.Literal(v)),
        { description }
      )
    }

    switch (typeof record.type === 'string' ? record.type : '') {
      case 'string':
        return Type.String({ description })
      case 'number':
        return Type.Number({ description })
      case 'integer':
        return Type.Integer({ description })
      case 'boolean':
        return Type.Boolean({ description })
      case 'array':
        return Type.Array(convert(record.items), { description })
      case 'object': {
        const props: Record<string, TSchema> = {}
        const required = new Set(Array.isArray(record.required) ? record.required : [])
        const properties =
          record.properties !== null && typeof record.properties === 'object'
            ? (record.properties as Record<string, unknown>)
            : {}
        for (const [key, value] of Object.entries(properties)) {
          const inner = convert(value)
          props[key] = required.has(key) ? inner : Type.Optional(inner)
        }
        return Type.Object(props, { description })
      }
      default:
        return Type.Any({ description })
    }
  }
  return convert(schema)
}

/**
 * Parse what the adapter hands the spawned pi: the raw `mcpServers` array from
 * the ACP request, JSON-encoded in MCP_SERVERS_ENV. Empty/broken input parses
 * to no servers, and a bridge with no servers registers nothing.
 */
export function parseBridgeServers(json: string | undefined): McpServer[] {
  if (typeof json !== 'string' || json === '') return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
