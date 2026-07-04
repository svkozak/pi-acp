import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

function isObject(x: unknown): x is Record<string, unknown> {
  return Boolean(x) && typeof x === 'object' && !Array.isArray(x)
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    const av = out[k]
    if (isObject(av) && isObject(v)) out[k] = deepMerge(av, v)
    else out[k] = v
  }
  return out
}

function readJsonFile(path: string): Record<string, unknown> {
  try {
    if (!existsSync(path)) return {}
    const raw = readFileSync(path, 'utf-8')
    const data = JSON.parse(raw)
    return isObject(data) ? data : {}
  } catch {
    return {}
  }
}

function getMergedSettings(cwd: string): Record<string, unknown> {
  const globalSettingsPath = join(getAgentDir(), 'settings.json')
  const projectSettingsPath = resolve(cwd, '.pi', 'settings.json')

  const global = readJsonFile(globalSettingsPath)
  const project = readJsonFile(projectSettingsPath)
  return deepMerge(global, project)
}

export function getAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent')
}

function envFlag(value: string | undefined): boolean | null {
  if (value == null) return null
  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false
  return null
}

function settingsPackagesIncludeMcpAdapter(settings: Record<string, unknown>): boolean {
  const packages = settings.packages
  if (!Array.isArray(packages)) return false
  return packages.some(pkg => typeof pkg === 'string' && pkg.includes('pi-mcp-adapter'))
}

/**
 * Best-effort detection for whether pi can actually consume MCP config.
 *
 * pi-acp can bridge ACP MCP servers, but pi itself only uses them when an MCP
 * extension such as `pi-mcp-adapter` is installed/enabled. `initialize` does not
 * include a cwd, so project-local detection is not always possible; this checks
 * global installation/settings and supports an explicit env override.
 */
export function getMcpCapabilities(): { http: boolean; sse: boolean; acp: boolean } {
  const forced = envFlag(process.env.PI_ACP_ENABLE_MCP)
  const enabled = forced ?? isMcpAdapterDetected()
  return { http: enabled, sse: enabled, acp: enabled }
}

export function isMcpAdapterDetected(cwd?: string): boolean {
  const agentDir = getAgentDir()

  // `pi install npm:pi-mcp-adapter` installs here globally.
  if (existsSync(join(agentDir, 'npm', 'node_modules', 'pi-mcp-adapter'))) return true
  if (existsSync(join(agentDir, 'npm', 'node_modules', '.bin', 'pi-mcp-adapter'))) return true

  // If settings still list the package, advertise support even if the package
  // manager directory has not been inspected/created yet.
  if (settingsPackagesIncludeMcpAdapter(readJsonFile(join(agentDir, 'settings.json')))) return true

  if (cwd) {
    const projectRoot = resolve(cwd)
    if (existsSync(join(projectRoot, '.pi', 'npm', 'node_modules', 'pi-mcp-adapter'))) return true
    if (settingsPackagesIncludeMcpAdapter(readJsonFile(join(projectRoot, '.pi', 'settings.json')))) return true
  }

  return false
}

/**
 * Mirror pi settings semantics (global + project merge, project overrides global).
 * Only returns the bits we currently need.
 */
export function getEnableSkillCommands(cwd: string): boolean {
  const merged = getMergedSettings(cwd)

  const direct = merged.enableSkillCommands
  if (typeof direct === 'boolean') return direct

  // Back-compat: some versions used skills.enableSkillCommands
  const nested = isObject(merged.skills) ? merged.skills.enableSkillCommands : undefined
  if (typeof nested === 'boolean') return nested

  return true
}

/**
 * Mirror pi's quietStartup setting: if true, pi suppresses the verbose startup prelude.
 * We use it to decide whether to synthesize + emit our own "startup info" message.
 */
export function getQuietStartup(cwd: string): boolean {
  const merged = getMergedSettings(cwd)

  const direct = merged.quietStartup
  if (typeof direct === 'boolean') return direct

  // Back-compat: some versions used quietStart
  const legacy = (merged as any).quietStart
  if (typeof legacy === 'boolean') return legacy

  return false
}
