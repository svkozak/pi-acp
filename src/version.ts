import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

export type PiAcpVersionInfo = {
  /** Package version from the installed package.json. */
  packageVersion: string
  /** Short git SHA when running from a git checkout, else null. */
  gitShortSha: string | null
  /** Whether the working tree has uncommitted changes at build time. */
  gitDirty: boolean
  /** Build file modification time (UTC ISO). */
  buildTime: string | null
  /** `true` when running from a `node <path>/src` or tsx dev invocation. */
  devMode: boolean
  /** User-supplied tag via PI_ACP_VERSION_TAG env, if any. */
  tag: string | null
  /** Absolute path to the resolved package.json. */
  packageRoot: string | null
}

let cached: PiAcpVersionInfo | null = null

export function getVersionInfo(): PiAcpVersionInfo {
  if (cached) return cached

  const selfDir = (() => {
    try {
      return dirname(fileURLToPath(import.meta.url))
    } catch {
      return process.cwd()
    }
  })()

  const pkg = findNearestPackageJson(selfDir)
  const packageVersion = pkg?.data?.version ? String(pkg.data.version) : '0.0.0'
  const packageRoot = pkg?.path ? dirname(pkg.path) : null

  const git = packageRoot ? readGitInfo(packageRoot) : { sha: null, dirty: false }

  // Build time = mtime of the entry file (`dist/index.js`), or package.json
  // as a fallback. Stable across reboots and meaningful for local iteration.
  let buildTime: string | null = null
  const entryCandidates = [
    packageRoot ? join(packageRoot, 'dist', 'index.js') : null,
    pkg?.path ?? null
  ].filter((p): p is string => typeof p === 'string' && existsSync(p))
  for (const p of entryCandidates) {
    try {
      buildTime = statSync(p).mtime.toISOString()
      break
    } catch {
      // ignore
    }
  }

  const devMode = /\/src(\/|$)/.test(selfDir) || selfDir.endsWith('/src')

  cached = {
    packageVersion,
    gitShortSha: git.sha,
    gitDirty: git.dirty,
    buildTime,
    devMode,
    tag: process.env.PI_ACP_VERSION_TAG?.trim() || null,
    packageRoot
  }
  return cached
}

/**
 * Short human-readable identifier suitable for a title bar or banner header.
 *
 * Examples:
 *   - "pi-acp v0.0.26"
 *   - "pi-acp v0.0.26+abc1234"
 *   - "pi-acp v0.0.26+abc1234-dirty (dev)"
 *   - "pi-acp v0.0.26 [my-branch]"
 */
export function formatVersionLabel(info: PiAcpVersionInfo = getVersionInfo()): string {
  const parts: string[] = [`pi-acp v${info.packageVersion}`]

  if (info.gitShortSha) {
    parts[0] += `+${info.gitShortSha}${info.gitDirty ? '-dirty' : ''}`
  }

  const flags: string[] = []
  if (info.devMode) flags.push('dev')
  if (info.tag) flags.push(info.tag)
  if (flags.length) parts.push(`(${flags.join(', ')})`)

  return parts.join(' ')
}

/**
 * Multi-line block with every known identifier. Used by the `/version` command
 * and embedded in the startup banner.
 */
export function formatVersionBlock(info: PiAcpVersionInfo = getVersionInfo()): string {
  const lines: string[] = []
  lines.push(formatVersionLabel(info))

  if (info.buildTime) lines.push(`  build: ${info.buildTime}`)
  if (info.packageRoot) lines.push(`  root:  ${info.packageRoot}`)
  if (info.gitShortSha) lines.push(`  git:   ${info.gitShortSha}${info.gitDirty ? ' (dirty)' : ''}`)

  return lines.join('\n')
}

/** Version string suitable for the `agentInfo.version` field in the initialize response. */
export function getAgentInfoVersion(info: PiAcpVersionInfo = getVersionInfo()): string {
  if (info.gitShortSha) {
    return `${info.packageVersion}+${info.gitShortSha}${info.gitDirty ? '.dirty' : ''}`
  }
  return info.packageVersion
}

// --- internals ---------------------------------------------------------------

function findNearestPackageJson(startDir: string): {
  path: string
  data: { name?: string; version?: string }
} | null {
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    const p = join(dir, 'package.json')
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, 'utf-8')
        const data = JSON.parse(raw)
        if (data && typeof data === 'object' && (data as any).name === 'pi-acp') {
          return { path: p, data: data as any }
        }
      } catch {
        // fall through to the parent dir
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

function readGitInfo(cwd: string): { sha: string | null; dirty: boolean } {
  // Only bother if a `.git` exists on the resolved package root. Published npm
  // packages won't have one, so we skip shelling out.
  if (!existsSync(join(cwd, '.git'))) return { sha: null, dirty: false }

  const sha = (() => {
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--short=7', 'HEAD'], {
      encoding: 'utf-8',
      timeout: 400
    })
    const out = String(r.stdout ?? '').trim()
    return out && /^[0-9a-f]{6,}$/i.test(out) ? out : null
  })()

  const dirty = (() => {
    const r = spawnSync('git', ['-C', cwd, 'status', '--porcelain'], {
      encoding: 'utf-8',
      timeout: 400
    })
    return String(r.stdout ?? '').trim().length > 0
  })()

  return { sha, dirty }
}
