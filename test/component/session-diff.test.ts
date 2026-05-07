import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession: emits ACP diff content for edit tool when file changes', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-diff-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'before\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd: dir,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  // Start edit -> snapshot should be taken
  proc.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'edit', args: { path: 'a.txt' } })

  // Simulate file being edited by pi
  writeFileSync(filePath, 'after\n', 'utf8')

  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'ok' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(u => (u.update as any).toolCallId === 't1' && u.update.sessionUpdate === 'tool_call_update')
  assert.ok(end, 'expected tool_call_update for edit completion')

  const content = (end!.update as any).content as any[]
  assert.ok(Array.isArray(content), 'expected content array')
  const diff = content.find(c => c.type === 'diff')
  assert.ok(diff, 'expected diff content item')

  assert.equal(diff.path, 'a.txt')
  assert.equal(diff.oldText, 'before\n')
  assert.equal(diff.newText, 'after\n')
})

test('PiAcpSession: emits edit diff content from tool args when edit starts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-diff-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'before\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd: dir,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'edit',
    args: { path: 'a.txt', edits: [{ oldText: 'before', newText: 'after' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const start = conn.updates.find(u => (u.update as any).toolCallId === 't1' && u.update.sessionUpdate === 'tool_call')
  assert.ok(start, 'expected tool_call for edit start')

  const content = (start!.update as any).content as any[]
  assert.equal(content?.[0]?.type, 'diff')
  assert.equal(content?.[0]?.path, 'a.txt')
  assert.equal(content?.[0]?.oldText, 'before')
  assert.equal(content?.[0]?.newText, 'after')

  writeFileSync(filePath, 'after\n', 'utf8')
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'ok' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(
    u =>
      (u.update as any).toolCallId === 't1' &&
      u.update.sessionUpdate === 'tool_call_update' &&
      (u.update as any).status === 'completed'
  )
  assert.ok(end, 'expected completed tool_call_update')
  assert.equal((end!.update as any).content, undefined, 'expected completion not to resend initial diff content')
  assert.equal((end!.update as any).rawOutput, undefined, 'expected no raw output when initial diff was emitted')
})

test('PiAcpSession: emits write diff content from existing file snapshot when write starts', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-diff-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'a.txt')
  writeFileSync(filePath, 'before\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd: dir,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'write',
    args: { path: 'a.txt', content: 'after\n' }
  })

  await new Promise(r => setTimeout(r, 0))

  const start = conn.updates.find(u => (u.update as any).toolCallId === 't1' && u.update.sessionUpdate === 'tool_call')
  assert.ok(start, 'expected tool_call for write start')

  const content = (start!.update as any).content as any[]
  assert.equal(content?.[0]?.type, 'diff')
  assert.equal(content?.[0]?.path, 'a.txt')
  assert.equal(content?.[0]?.oldText, 'before\n')
  assert.equal(content?.[0]?.newText, 'after\n')

  writeFileSync(filePath, 'after\n', 'utf8')
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 't1',
    isError: false,
    result: { content: [{ type: 'text', text: 'Successfully wrote 6 bytes to a.txt' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(
    u =>
      (u.update as any).toolCallId === 't1' &&
      u.update.sessionUpdate === 'tool_call_update' &&
      (u.update as any).status === 'completed'
  )
  assert.ok(end, 'expected completed tool_call_update')
  assert.equal((end!.update as any).content, undefined, 'expected completion not to resend initial write diff content')
  assert.equal((end!.update as any).rawOutput, undefined, 'expected no raw output when write diff is emitted')
})

test('PiAcpSession: emits write diff content for new files', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-diff-'))
  mkdirSync(dir, { recursive: true })

  new PiAcpSession({
    sessionId: 's1',
    cwd: dir,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({
    type: 'tool_execution_start',
    toolCallId: 't1',
    toolName: 'write',
    args: { path: 'new.txt', content: 'created\n' }
  })

  await new Promise(r => setTimeout(r, 0))

  const start = conn.updates.find(u => (u.update as any).toolCallId === 't1' && u.update.sessionUpdate === 'tool_call')
  assert.ok(start, 'expected tool_call for write start')

  const content = (start!.update as any).content as any[]
  assert.equal(content?.[0]?.type, 'diff')
  assert.equal(content?.[0]?.path, 'new.txt')
  assert.equal(content?.[0]?.oldText, null)
  assert.equal(content?.[0]?.newText, 'created\n')
})
