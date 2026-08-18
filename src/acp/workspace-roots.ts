import { RequestError } from '@agentclientprotocol/sdk'
import { isAbsolute, resolve as resolvePath } from 'node:path'

/**
 * Validate and normalize the ACP `additionalDirectories` request field
 * (https://agentclientprotocol.com/protocol/v1/session-setup#additional-workspace-roots).
 *
 * Every entry MUST be an absolute path. `cwd` stays the primary root, so an entry
 * equal to it is dropped. Order is preserved and duplicates are removed.
 */
export function normalizeAdditionalDirectories(input: readonly string[] | null | undefined, cwd: string): string[] {
  if (!input || input.length === 0) return []

  const resolvedCwd = resolvePath(cwd)
  const out: string[] = []

  for (const entry of input) {
    if (typeof entry !== 'string') {
      throw RequestError.invalidParams(`additionalDirectories entries must be absolute paths: ${String(entry)}`)
    }

    const dir = entry.trim()
    if (!dir) continue

    if (!isAbsolute(dir)) {
      throw RequestError.invalidParams(`additionalDirectories entries must be absolute paths: ${entry}`)
    }

    if (resolvePath(dir) === resolvedCwd) continue
    if (!out.includes(dir)) out.push(dir)
  }

  return out
}
