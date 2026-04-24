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
 * Mirror pi settings semantics for extension-sourced slash commands (e.g. /worktree,
 * /plannotator, /mcp, /jarvis …).
 *
 * Resolution order (first wins):
 *   1. `PI_ACP_ENABLE_EXTENSION_COMMANDS` env var (`true` | `false`)
 *   2. `enableExtensionCommands` in merged pi settings (global + project)
 *   3. Default: `true` — matches the behavior of skill commands, so extension-provided
 *      commands are discoverable in ACP clients by default. Set to `false` to hide them
 *      (useful if an extension emits UI requests the ACP adapter doesn't handle).
 */
export function getEnableExtensionCommands(cwd: string): boolean {
  const env = process.env.PI_ACP_ENABLE_EXTENSION_COMMANDS
  if (env === 'true') return true
  if (env === 'false') return false

  const merged = getMergedSettings(cwd)
  const direct = merged.enableExtensionCommands
  if (typeof direct === 'boolean') return direct

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
