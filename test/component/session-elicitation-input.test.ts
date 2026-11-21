import test from 'node:test'
import assert from 'node:assert/strict'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function makeSession(conn: FakeAgentSideConnection, proc: FakePiRpcProcess): void {
  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: []
  })
}

test('PiAcpSession: input UI request creates an elicitation and returns the accepted value', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  conn.elicitationResponse = { action: 'accept', content: { value: 'my custom answer' } }
  makeSession(conn, proc)

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-1',
    method: 'input',
    title: 'Your answer',
    placeholder: 'Type...'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.elicitationRequests.length, 1)
  const req = conn.elicitationRequests[0] as any
  assert.equal(req.message, 'Your answer')
  assert.equal(req.mode, 'form')
  assert.equal(req.sessionId, 's1')
  assert.equal(req.requestedSchema.type, 'object')
  assert.equal(req.requestedSchema.properties.value.type, 'string')
  assert.equal(req.requestedSchema.properties.value.title, 'Type...')
  assert.deepEqual(req.requestedSchema.required, ['value'])
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', value: 'my custom answer' }])
})

test('PiAcpSession: input UI request with declined elicitation is cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  conn.elicitationResponse = { action: 'decline' }
  makeSession(conn, proc)

  proc.emit({ type: 'extension_ui_request', id: 'ui-1', method: 'input', title: 'Your answer' })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.elicitationRequests.length, 1)
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', cancelled: true }])
})

test('PiAcpSession: input UI request with a failing elicitation is cancelled', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  conn.elicitationError = new Error('boom')
  makeSession(conn, proc)

  proc.emit({ type: 'extension_ui_request', id: 'ui-1', method: 'input', title: 'Your answer' })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.elicitationRequests.length, 1)
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-1', cancelled: true }])
})

test('PiAcpSession: editor UI request passes prefill as the schema default', async () => {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  makeSession(conn, proc)

  proc.emit({
    type: 'extension_ui_request',
    id: 'ui-2',
    method: 'editor',
    title: 'Edit text',
    prefill: 'hello'
  })

  await new Promise(r => setTimeout(r, 0))

  assert.equal(conn.elicitationRequests.length, 1)
  const req = conn.elicitationRequests[0] as any
  assert.equal(req.requestedSchema.properties.value.type, 'string')
  assert.equal(req.requestedSchema.properties.value.title, 'Answer')
  assert.equal(req.requestedSchema.properties.value.default, 'hello')
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'ui-2', value: 'my answer' }])
})
