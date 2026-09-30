import { platform } from 'node:os'

export function defaultPiCommand(): string {
  return platform() === 'win32' ? 'pi.cmd' : 'pi'
}

export function getPiCommand(override?: string): string {
  return override ?? defaultPiCommand()
}

export function getPiArgs(encoded = process.env.PI_ACP_PI_ARGS): string[] {
  if (encoded === undefined) return []
  let args: unknown
  try {
    args = JSON.parse(encoded)
  } catch {
    throw new Error('PI_ACP_PI_ARGS must be a JSON array of strings')
  }
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string' && !arg.includes('\0'))) {
    throw new Error('PI_ACP_PI_ARGS must be a JSON array of strings')
  }
  return args
}

export function shouldUseShellForPiCommand(cmd: string): boolean {
  if (platform() !== 'win32') return false

  const normalized = cmd.trim().toLowerCase()
  return normalized.endsWith('.cmd') || normalized.endsWith('.bat')
}
