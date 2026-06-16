import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listPiSessions } from '../../src/acp/pi-sessions.js'

test('listPiSessions: updatedAt prefers last message timestamp over later non-message entries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp-test-'))
  const sessionsDir = join(root, 'sessions', '--p--')
  mkdirSync(sessionsDir, { recursive: true })

  const sessionFile = join(sessionsDir, 's.jsonl')

  // Last message at 00:00:02, but a later session_info at 00:00:10.
  // We want updatedAt == 00:00:02.
  writeFileSync(
    sessionFile,
    [
      JSON.stringify({
        type: 'session',
        version: 3,
        id: 'sess-1',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp/project'
      }),
      JSON.stringify({
        type: 'message',
        id: 'a1b2c3d4',
        parentId: null,
        timestamp: '2026-01-01T00:00:02.000Z',
        message: { role: 'user', content: 'hi' }
      }),
      JSON.stringify({
        type: 'session_info',
        id: 'b1b2c3d4',
        parentId: 'a1b2c3d4',
        timestamp: '2026-01-01T00:00:10.000Z',
        name: 'named'
      })
    ].join('\n') + '\n',
    { encoding: 'utf8' }
  )

  const oldEnv = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = root

  try {
    const sessions = listPiSessions().filter(s => s.sessionId === 'sess-1')
    assert.equal(sessions.length, 1)
    assert.equal(sessions[0]?.updatedAt, '2026-01-01T00:00:02.000Z')
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = oldEnv
  }
})
