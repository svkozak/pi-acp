import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Storage owned by the ACP adapter.
 *
 * Set PI_ACP_DATA_DIR to override the default location (defaults to ~/.pi/pi-acp).
 * This is separate from pi's own ~/.pi/agent/* directory, which is controlled
 * via PI_CODING_AGENT_DIR.
 */
export function getPiAcpDir(): string {
  return process.env.PI_ACP_DATA_DIR
    ? resolve(process.env.PI_ACP_DATA_DIR)
    : join(homedir(), '.pi', 'pi-acp')
}

export function getPiAcpSessionMapPath(): string {
  return join(getPiAcpDir(), 'session-map.json')
}
