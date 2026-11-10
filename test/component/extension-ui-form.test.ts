import test from 'node:test'
import assert from 'node:assert/strict'
import { RequestError } from '@agentclientprotocol/sdk'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

function setup(formElicitation = true) {
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  new PiAcpSession({
    sessionId: 's1',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as any,
    conn: asAgentConn(conn),
    fileCommands: [],
    formElicitation
  })
  return { conn, proc }
}

const tick = () => new Promise(r => setTimeout(r, 0))

test('extension select becomes an enum form when the client supports forms', async () => {
  const { conn, proc } = setup()
  conn.nextElicitationResponse = { action: 'accept', content: { value: 'Beta' } }

  proc.emit({ type: 'extension_ui_request', id: 'u1', method: 'select', title: 'Pick one', options: ['Alpha', 'Beta'] })
  await tick()

  assert.equal(conn.permissionRequests.length, 0)
  assert.deepEqual(conn.elicitationRequests, [
    {
      mode: 'form',
      sessionId: 's1',
      message: 'Pick one',
      requestedSchema: {
        type: 'object',
        properties: {
          value: {
            type: 'string',
            oneOf: [
              { const: 'Alpha', title: 'Alpha' },
              { const: 'Beta', title: 'Beta' }
            ]
          }
        },
        required: ['value']
      }
    }
  ])
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'u1', value: 'Beta' }])
})

test('extension confirm becomes a boolean form', async () => {
  const { conn, proc } = setup()
  conn.nextElicitationResponse = { action: 'accept', content: { value: false } }

  proc.emit({ type: 'extension_ui_request', id: 'u2', method: 'confirm', title: 'Clear?', message: 'All gone.' })
  await tick()

  const req = conn.elicitationRequests[0] as any
  assert.equal(req.message, 'Clear?\n\nAll gone.')
  assert.equal(req.requestedSchema.properties.value.type, 'boolean')
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'u2', confirmed: false }])
})

test('extension input and editor become a text form with placeholder and prefill', async () => {
  const { conn, proc } = setup()
  conn.nextElicitationResponse = { action: 'accept', content: { value: 'typed' } }

  proc.emit({ type: 'extension_ui_request', id: 'u3', method: 'input', title: 'Name', placeholder: 'your name' })
  await tick()
  proc.emit({ type: 'extension_ui_request', id: 'u4', method: 'editor', title: 'Edit', prefill: 'a\nb' })
  await tick()

  const [input, editor] = conn.elicitationRequests as any[]
  assert.deepEqual(input.requestedSchema.properties.value, {
    type: 'string',
    description: 'your name'
  })
  assert.equal(editor.requestedSchema.properties.value.default, 'a\nb')
  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'u3', value: 'typed' },
    { id: 'u4', value: 'typed' }
  ])
})

test('an accepted input form with no text answers with an empty string', async () => {
  const { conn, proc } = setup()
  conn.nextElicitationResponse = { action: 'accept', content: {} }

  proc.emit({ type: 'extension_ui_request', id: 'u5', method: 'input', title: 'Name' })
  await tick()

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'u5', value: '' }])
})

test('declined and cancelled forms cancel the pi dialog without asking again', async () => {
  for (const action of ['decline', 'cancel']) {
    const { conn, proc } = setup()
    conn.nextElicitationResponse = { action }

    proc.emit({ type: 'extension_ui_request', id: 'u6', method: 'select', title: 'Pick', options: ['A'] })
    await tick()

    assert.equal(conn.permissionRequests.length, 0)
    assert.deepEqual(proc.extensionUiResponses, [{ id: 'u6', cancelled: true }])
  }
})

test('an accepted answer that is not one of the options cancels', async () => {
  const { conn, proc } = setup()
  conn.nextElicitationResponse = { action: 'accept', content: { value: 'Zeta' } }

  proc.emit({ type: 'extension_ui_request', id: 'u7', method: 'select', title: 'Pick', options: ['A', 'B'] })
  await tick()

  assert.deepEqual(proc.extensionUiResponses, [{ id: 'u7', cancelled: true }])
})

test('a client that abstains with -32601 falls back to permissions and is not asked again', async () => {
  const { conn, proc } = setup()
  conn.nextElicitationResponse = RequestError.methodNotFound('elicitation/create')
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-0' } }

  proc.emit({ type: 'extension_ui_request', id: 'u8', method: 'select', title: 'Pick', options: ['A', 'B'] })
  await tick()
  proc.emit({ type: 'extension_ui_request', id: 'u9', method: 'select', title: 'Pick', options: ['A', 'B'] })
  await tick()

  assert.equal(conn.elicitationRequests.length, 1)
  assert.equal(conn.permissionRequests.length, 2)
  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'u8', value: 'A' },
    { id: 'u9', value: 'A' }
  ])
})

test('any other elicitation error cancels the dialog instead of asking twice', async () => {
  const { conn, proc } = setup()
  conn.nextElicitationResponse = new Error('boom')

  proc.emit({ type: 'extension_ui_request', id: 'u10', method: 'confirm', title: 'Sure?' })
  await tick()

  assert.equal(conn.permissionRequests.length, 0)
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'u10', cancelled: true }])
})

test('without form support the permission bridge and the input fallback are unchanged', async () => {
  const { conn, proc } = setup(false)
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-1' } }

  proc.emit({ type: 'extension_ui_request', id: 'u11', method: 'select', title: 'Pick', options: ['A', 'B'] })
  await tick()
  proc.emit({ type: 'extension_ui_request', id: 'u12', method: 'input', title: 'Name' })
  await tick()

  assert.equal(conn.elicitationRequests.length, 0)
  assert.deepEqual(proc.extensionUiResponses, [
    { id: 'u11', value: 'B' },
    { id: 'u12', cancelled: true }
  ])
})

test('a select with duplicate options is not expressible as a form and uses permissions', async () => {
  const { conn, proc } = setup()
  conn.nextPermissionResponse = { outcome: { outcome: 'selected', optionId: 'choice-0' } }

  proc.emit({ type: 'extension_ui_request', id: 'u13', method: 'select', title: 'Pick', options: ['A', 'A'] })
  await tick()

  assert.equal(conn.elicitationRequests.length, 0)
  assert.deepEqual(proc.extensionUiResponses, [{ id: 'u13', value: 'A' }])
})
