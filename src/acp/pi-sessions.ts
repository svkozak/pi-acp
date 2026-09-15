import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'
import { titleFromContent } from './session-title.js'

export type PiSessionListItem = {
  sessionId: string
  cwd: string
  title: string | null
  updatedAt: string | null
  sessionFile: string
}

const DEFAULT_TAIL_BYTES = 256 * 1024
const DEFAULT_HEAD_BYTES = 64 * 1024

function getPiAgentDir(): string {
  // pi supports overriding config dir via PI_CODING_AGENT_DIR.
  // See pi README.
  return process.env.PI_CODING_AGENT_DIR ? resolve(process.env.PI_CODING_AGENT_DIR) : join(homedir(), '.pi', 'agent')
}

function readSessionDirFromSettings(agentDir: string): string | null {
  const settingsPath = join(agentDir, 'settings.json')
  try {
    if (!existsSync(settingsPath)) return null
    const raw = readFileSync(settingsPath, 'utf8')
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null

    const sessionDir = (data as Record<string, unknown>).sessionDir
    if (typeof sessionDir !== 'string' || !sessionDir.trim()) return null

    return isAbsolute(sessionDir) ? sessionDir : resolve(agentDir, sessionDir)
  } catch {
    return null
  }
}

export function getPiSessionsDir(): string {
  const agentDir = getPiAgentDir()
  return readSessionDirFromSettings(agentDir) ?? join(agentDir, 'sessions')
}

function walkJsonlFiles(dir: string, out: string[]) {
  let entries: import('node:fs').Dirent[]
  try {
    // Force string names.
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' }) as unknown as import('node:fs').Dirent[]
  } catch {
    return
  }

  for (const e of entries) {
    const name = typeof (e as any).name === 'string' ? (e as any).name : String((e as any).name)
    const p = join(dir, name)
    if (e.isDirectory()) walkJsonlFiles(p, out)
    else if (e.isFile() && name.endsWith('.jsonl')) out.push(p)
  }
}

function readFirstLine(path: string): string | null {
  // Avoid reading the whole file.
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(DEFAULT_HEAD_BYTES)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n <= 0) return null
    const s = buf.subarray(0, n).toString('utf-8')
    const idx = s.indexOf('\n')
    return idx === -1 ? s.trim() : s.slice(0, idx).trim()
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function readTail(path: string, tailBytes = DEFAULT_TAIL_BYTES): string {
  const st = statSync(path)
  const start = Math.max(0, st.size - tailBytes)
  const len = st.size - start

  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(len)
    const n = readSync(fd, buf, 0, buf.length, start)
    return buf.subarray(0, n).toString('utf-8')
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function parseSessionHeader(firstLine: string): { sessionId: string; cwd: string } | null {
  try {
    const obj = JSON.parse(firstLine) as any
    if (obj?.type !== 'session') return null
    const sessionId = typeof obj?.id === 'string' ? obj.id : null
    const cwd = typeof obj?.cwd === 'string' ? obj.cwd : null
    if (!sessionId || !cwd) return null
    return { sessionId, cwd }
  } catch {
    return null
  }
}

function pickTitleFromTail(tail: string): string | null {
  // Try to find the *latest* session_info entry (stores the user-provided name).
  // We scan backwards line-by-line.
  const lines = tail.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type === 'session_info' && typeof obj?.name === 'string' && obj.name.trim()) {
        return obj.name.trim()
      }
    } catch {
      // ignore
    }
  }
  return null
}

function scanSessionInfoNameFromFile(path: string): string | null {
  // Fallback when the session_info entry is older than our tail window.
  // Scan the whole file line-by-line and remember the last session_info.name.
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(256 * 1024)
    let leftover = ''
    let offset = 0
    let lastName: string | null = null

    while (true) {
      const n = readSync(fd, buf, 0, buf.length, offset)
      if (n <= 0) break
      offset += n

      const chunk = leftover + buf.subarray(0, n).toString('utf8')
      const lines = chunk.split(/\r?\n/)
      leftover = lines.pop() ?? ''

      for (const line0 of lines) {
        const line = line0.trim()
        if (!line) continue
        try {
          const obj = JSON.parse(line) as any
          if (obj?.type === 'session_info' && typeof obj?.name === 'string' && obj.name.trim()) {
            lastName = obj.name.trim()
          }
        } catch {
          // ignore
        }
      }
    }

    // Best-effort: parse leftover if it was a full line without trailing newline.
    const tailLine = leftover.trim()
    if (tailLine) {
      try {
        const obj = JSON.parse(tailLine) as any
        if (obj?.type === 'session_info' && typeof obj?.name === 'string' && obj.name.trim()) {
          lastName = obj.name.trim()
        }
      } catch {
        // ignore
      }
    }

    return lastName
  } catch {
    return null
  } finally {
    try {
      closeSync(fd)
    } catch {
      // ignore
    }
  }
}

function pickUpdatedAtFromTail(tail: string): string | null {
  // pi's `/resume` effectively orders sessions by last *message* activity.
  // We scan backwards and pick the timestamp of the most recent entry with type === "message".
  const lines = tail.split(/\r?\n/)

  // 1) Prefer the most recent message entry.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      if (obj?.type !== 'message') continue
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null
      if (!ts) continue
      const d = new Date(ts)
      if (Number.isFinite(d.getTime())) return d.toISOString()
    } catch {
      // ignore
    }
  }

  // 2) Fallback: any valid timestamp (covers sessions that somehow have no messages).
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const obj = JSON.parse(line) as any
      const ts = typeof obj?.timestamp === 'string' ? obj.timestamp : null
      if (!ts) continue
      const d = new Date(ts)
      if (Number.isFinite(d.getTime())) return d.toISOString()
    } catch {
      // ignore
    }
  }

  return null
}

function pickFallbackTitleFromHead(path: string): string | null {
  // Fallback to first user message.
  try {
    const raw = readFileSync(path, { encoding: 'utf8' })
    const lines = raw.split(/\r?\n/)
    for (const line0 of lines.slice(0, 2000)) {
      const line = line0.trim()
      if (!line) continue
      try {
        const obj = JSON.parse(line) as any
        if (obj?.type === 'message' && obj?.message?.role === 'user') {
          const title = titleFromContent(obj.message.content)
          if (title) return title
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  return null
}

export function readPiSessionTitle(path: string, tail?: string): string | null {
  try {
    return (
      pickTitleFromTail(tail ?? readTail(path)) ?? scanSessionInfoNameFromFile(path) ?? pickFallbackTitleFromHead(path)
    )
  } catch {
    return null
  }
}

export function listPiSessions(): PiSessionListItem[] {
  const sessionsDir = getPiSessionsDir()
  const files: string[] = []
  walkJsonlFiles(sessionsDir, files)

  const items: PiSessionListItem[] = []

  for (const file of files) {
    const first = readFirstLine(file)
    if (!first) continue
    const header = parseSessionHeader(first)
    if (!header) continue

    let updatedAt: string | null = null

    let title: string | null = null
    try {
      const tail = readTail(file)
      title = readPiSessionTitle(file, tail)
      updatedAt = pickUpdatedAtFromTail(tail)
    } catch {
      // ignore
    }

    // Fallback for updatedAt when we couldn't parse timestamps from tail.
    if (!updatedAt) {
      try {
        updatedAt = statSync(file).mtime.toISOString()
      } catch {
        updatedAt = null
      }
    }

    items.push({
      sessionId: header.sessionId,
      cwd: header.cwd,
      title,
      updatedAt,
      sessionFile: file
    })
  }

  // Sort most recent first.
  items.sort((a, b) => {
    const aa = a.updatedAt ?? ''
    const bb = b.updatedAt ?? ''
    return bb.localeCompare(aa)
  })

  return items
}

export function findPiSession(sessionId: string): PiSessionListItem | null {
  const all = listPiSessions()
  return all.find(s => s.sessionId === sessionId) ?? null
}

export function findPiSessionFile(sessionId: string): string | null {
  return findPiSession(sessionId)?.sessionFile ?? null
}
