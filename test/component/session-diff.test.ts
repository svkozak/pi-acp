import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function createSession(cwd: string) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  return { conn, proc }
}

function completedToolUpdate(conn: FakeAgentSideConnection, toolCallId = 't1') {
  return conn.updates.find(
    u =>
      (u.update as any).toolCallId === toolCallId &&
      u.update.sessionUpdate === 'tool_call_update' &&
      (u.update as any).status === 'completed'
  )
}

test('PiAcpSession: emits ACP diff content for edit tool from actual before/after file contents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-diff-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'before\n', 'utf8')

  const { conn, proc } = createSession(dir)

  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'edit', args: { path: 'a.txt' } })
  writeFileSync(filePath, 'after\n', 'utf8')
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'ok' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = completedToolUpdate(conn)
  assert.ok(end, 'expected completed tool_call_update')

  const content = (end.update as any).content as any[]
  assert.ok(Array.isArray(content), 'expected content array')
  const diff = content.find(c => c.type === 'diff')
  assert.ok(diff, 'expected diff content item')
  assert.equal(diff.path, 'a.txt')
  assert.equal(diff.oldText, 'before\n')
  assert.equal(diff.newText, 'after\n')
  assert.equal((end.update as any).rawOutput, undefined, 'expected raw output to be suppressed when diff is emitted')
})

test('PiAcpSession: does not turn requested edit args into finalized ACP diffs at tool start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-diff-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'before\n', 'utf8')

  const { conn, proc } = createSession(dir)

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: [{ oldText: 'before', newText: 'after' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const start = conn.updates.find(u => (u.update as any).toolCallId === 't1' && u.update.sessionUpdate === 'tool_call')
  assert.ok(start, 'expected tool_call for edit start')
  assert.equal((start.update as any).content, undefined, 'expected no start-time diff from requested edit args')

  writeFileSync(filePath, 'after\n', 'utf8')
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'ok' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = completedToolUpdate(conn)
  assert.ok(end, 'expected completed tool_call_update')
  const diff = (end.update as any).content?.find((c: any) => c.type === 'diff')
  assert.ok(diff, 'expected diff content item')
  assert.equal(diff.oldText, 'before\n')
  assert.equal(diff.newText, 'after\n')
})

test('PiAcpSession: edit diff uses realized fuzzy-match file contents instead of requested args', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-diff-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'fuzzy.txt')
  writeFileSync(filePath, 'FULLWIDTH: ＡＢＣ１２３\n', 'utf8')

  const { conn, proc } = createSession(dir)

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: {
      path: 'fuzzy.txt',
      edits: [{ oldText: 'FULLWIDTH: ABC123', newText: 'FULLWIDTH: ascii replacement' }]
    }
  })

  writeFileSync(filePath, 'FULLWIDTH: ascii replacement\n', 'utf8')
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in fuzzy.txt.' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = completedToolUpdate(conn)
  assert.ok(end, 'expected completed tool_call_update')
  const diff = (end.update as any).content?.find((c: any) => c.type === 'diff')
  assert.ok(diff, 'expected diff content item')
  assert.equal(diff.oldText, 'FULLWIDTH: ＡＢＣ１２３\n')
  assert.equal(diff.newText, 'FULLWIDTH: ascii replacement\n')
})

test('PiAcpSession: emits write diff content from actual before/after file contents on completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-diff-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'before\n', 'utf8')

  const { conn, proc } = createSession(dir)

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'write',
    args: { path: 'a.txt', content: 'after\n' }
  })

  await new Promise(r => setTimeout(r, 0))

  const start = conn.updates.find(u => (u.update as any).toolCallId === 't1' && u.update.sessionUpdate === 'tool_call')
  assert.ok(start, 'expected tool_call for write start')
  assert.equal((start.update as any).content, undefined, 'expected no start-time diff for write')

  writeFileSync(filePath, 'after\n', 'utf8')
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'Successfully wrote 6 bytes to a.txt' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = completedToolUpdate(conn)
  assert.ok(end, 'expected completed tool_call_update')
  const diff = (end.update as any).content?.find((c: any) => c.type === 'diff')
  assert.ok(diff, 'expected diff content item')
  assert.equal(diff.path, 'a.txt')
  assert.equal(diff.oldText, 'before\n')
  assert.equal(diff.newText, 'after\n')
  assert.equal((end.update as any).rawOutput, undefined, 'expected raw output to be suppressed when diff is emitted')
})

test('PiAcpSession: emits write diff content for new files on completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-diff-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'new.txt')

  const { conn, proc } = createSession(dir)

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'write',
    args: { path: 'new.txt', content: 'created\n' }
  })

  writeFileSync(filePath, 'created\n', 'utf8')
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'Successfully wrote 8 bytes to new.txt' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = completedToolUpdate(conn)
  assert.ok(end, 'expected completed tool_call_update')
  const diff = (end.update as any).content?.find((c: any) => c.type === 'diff')
  assert.ok(diff, 'expected diff content item')
  assert.equal(diff.path, 'new.txt')
  assert.equal(diff.oldText, null)
  assert.equal(diff.newText, 'created\n')
})
