/**
 * Mounts ACP session/new MCP servers inside pi without core changes.
 *
 * pi-acp spawns pi with `--extension <this file>` and PI_ACP_MCP_SERVERS set to
 * a JSON array of {name, config} in mcp.json shape. Entries register during
 * extension load, so the MCP extension connects them on session_start like any
 * later registration. A malformed handoff throws during load, failing the spawn
 * instead of running a session whose servers silently never arrive.
 *
 * No imports: pi loads this file directly (jiti handles .ts, node handles the
 * bundled .js), so it must stay dependency-free.
 */

interface HandoffEntry {
  name?: unknown
  config?: unknown
}

interface BridgeApi {
  registerMcpServer(name: string, config: unknown): void
}

export default function (pi: BridgeApi): void {
  const raw = process.env.PI_ACP_MCP_SERVERS
  if (raw === undefined || raw === '') return
  let entries: unknown
  try {
    entries = JSON.parse(raw)
  } catch {
    throw new Error('PI_ACP_MCP_SERVERS is not valid JSON')
  }
  if (!Array.isArray(entries)) throw new Error('PI_ACP_MCP_SERVERS must be a JSON array')
  for (const entry of entries) {
    const candidate = entry as HandoffEntry
    if (typeof candidate?.name !== 'string' || candidate.name.length === 0) {
      throw new Error('PI_ACP_MCP_SERVERS entry needs a non-empty string name')
    }
    if (typeof candidate.config !== 'object' || candidate.config === null) {
      throw new Error(`PI_ACP_MCP_SERVERS entry "${candidate.name}" needs a config object`)
    }
    pi.registerMcpServer(candidate.name, candidate.config)
  }
}
