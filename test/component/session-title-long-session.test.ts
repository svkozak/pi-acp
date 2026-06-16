import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listPiSessions } from '../../src/acp/pi-sessions.js'

// Ensures we still pick up session_info.name even if it is older than the tail window.

test('listPiSessions: finds session_info.name even when it is outside the tail window', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--p--')
  mkdirSync(sessionsDir, { recursive: true })

  const sessionFile = join(sessionsDir, 's.jsonl')

  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id: 'sess-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp/project'
  })
  const info = JSON.stringify({
    type: 'session_info',
    id: 'i1',
    parentId: null,
    timestamp: '2026-01-01T00:00:01.000Z',
    name: 'Named Early'
  })

  // Create a large filler so the name is far outside the last 256KB tail.
  const fillerLine = JSON.stringify({
    type: 'message',
    id: 'm',
    parentId: null,
    timestamp: '2026-01-01T00:00:02.000Z',
    message: { role: 'user', content: 'x'.repeat(2000) }
  })
  const filler = Array.from({ length: 400 }, () => fillerLine).join('\n')

  writeFileSync(sessionFile, [header, info, filler].join('\n') + '\n', { encoding: 'utf8' })

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    const s = listPiSessions().find(x => x.sessionId === 'sess-1')
    assert.ok(s)
    assert.equal(s?.title, 'Named Early')
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})
