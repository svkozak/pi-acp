import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('PiAcpSession: emits ACP diff content for write tool against a new file', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-write-new-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'new.txt')

  new PiAcpSession({
    sessionId: 's1',
    cwd: dir,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 'w1', toolName: 'write', args: { path: 'new.txt' } })

  writeFileSync(filePath, 'hello world\n', 'utf8')

  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'w1',
    isError: false,
    result: { content: [{ type: 'text', text: 'ok' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(
    u => (u.update as any).toolCallId === 'w1' && u.update.sessionUpdate === 'tool_call_update'
  )
  assert.ok(end, 'expected tool_call_update for write completion')

  const content = (end!.update as any).content as any[]
  assert.ok(Array.isArray(content), 'expected content array')
  const diff = content.find(c => c.type === 'diff')
  assert.ok(diff, 'expected diff content item for new file')

  assert.equal(diff.path, 'new.txt')
  assert.equal(diff.oldText, '')
  assert.equal(diff.newText, 'hello world\n')
})

test('PiAcpSession: emits ACP diff content for write tool overwriting an existing file', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-write-existing-'))
  mkdirSync(dir, { recursive: true })
  const filePath = join(dir, 'existing.txt')
  writeFileSync(filePath, 'v1\n', 'utf8')

  new PiAcpSession({
    sessionId: 's1',
    cwd: dir,
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 'w2', toolName: 'write', args: { path: 'existing.txt' } })

  writeFileSync(filePath, 'v2\n', 'utf8')

  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'w2',
    isError: false,
    result: { content: [{ type: 'text', text: 'ok' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(
    u => (u.update as any).toolCallId === 'w2' && u.update.sessionUpdate === 'tool_call_update'
  )
  const diff = ((end!.update as any).content as any[]).find(c => c.type === 'diff')
  assert.ok(diff, 'expected diff content item for overwrite')

  assert.equal(diff.path, 'existing.txt')
  assert.equal(diff.oldText, 'v1\n')
  assert.equal(diff.newText, 'v2\n')
})

test('PiAcpSession: wraps bash tool output in a fenced shell code block', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { cmd: 'echo hi' } })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'b1',
    isError: false,
    result: { content: [{ type: 'text', text: 'hi' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(
    u => (u.update as any).toolCallId === 'b1' && (u.update as any).status === 'completed'
  )
  assert.ok(end, 'expected completed tool_call_update for bash')

  const content = (end!.update as any).content as any[]
  assert.ok(Array.isArray(content) && content.length === 1, 'expected a single content item')
  const item = content[0]
  assert.equal(item.type, 'content')
  assert.equal(item.content.type, 'text')
  assert.ok(item.content.text.startsWith('```shell\n'), 'expected shell fence prefix')
  assert.ok(item.content.text.endsWith('```'), 'expected closing fence')
  assert.ok(item.content.text.includes('\nhi\n'), 'expected stdout preserved between fences')
})

test('PiAcpSession: escapes bash output containing backticks with a longer fence', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()

  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })

  proc.emit({ type: 'tool_execution_start', toolCallId: 'b2', toolName: 'bash', args: { cmd: 'cat file.md' } })
  proc.emit({
    type: 'tool_execution_end',
    toolCallId: 'b2',
    isError: false,
    result: { content: [{ type: 'text', text: 'line\n```\ninner\n```\nafter' }] }
  })

  await new Promise(r => setTimeout(r, 0))

  const end = conn.updates.find(
    u => (u.update as any).toolCallId === 'b2' && (u.update as any).status === 'completed'
  )
  const text = ((end!.update as any).content as any[])[0]!.content.text as string
  assert.ok(text.startsWith('````shell\n'), 'expected at least 4 backticks when inner has 3')
  assert.ok(text.endsWith('````'), 'expected matching closing fence length')
})

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
