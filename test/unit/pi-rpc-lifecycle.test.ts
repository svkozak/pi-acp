import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { PiRpcProcess, type PiRpcEvent } from '../../src/pi-rpc/process.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

function setup() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    killed: false,
    kill() {
      this.killed = true
      return true
    }
  })
  const Constructor = PiRpcProcess as unknown as new (child: ChildProcessWithoutNullStreams) => PiRpcProcess
  const proc = new Constructor(child as unknown as ChildProcessWithoutNullStreams)
  child.stdin.on('data', (data: Buffer) => {
    const command = JSON.parse(data.toString()) as { id: string; type: string }
    if (command.type === 'prompt') {
      child.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: 'prompt', success: true }) + '\n')
    }
  })
  const conn = new FakeAgentSideConnection()
  const session = new PiAcpSession({ sessionId: 'test', cwd: '/tmp', mcpServers: [], proc, conn: asAgentConn(conn) })
  return { child, proc, session }
}

test('native child close settles a prompt even after its RPC acknowledgement', { timeout: 1000 }, async () => {
  const { child, session } = setup()
  const turn = session.prompt('accepted')
  await new Promise<void>(resolve => setImmediate(resolve))
  child.emit('close', 1, null)
  assert.equal(await turn, 'error')
  assert.equal(session.isClosed, true)
})

test('termination rejects outstanding and subsequent RPC requests and is emitted once', async () => {
  const { child, proc } = setup()
  const events: PiRpcEvent[] = []
  proc.onEvent(event => events.push(event))
  const outstanding = assert.rejects(proc.getState(), /pipe failed/)
  child.stdin.emit('error', new Error('pipe failed'))
  child.emit('error', new Error('child failed'))
  child.emit('close', 1, null)
  await outstanding
  await assert.rejects(proc.getState(), /pipe failed/)
  assert.deepEqual(events, [{ type: 'process_exit', error: 'pipe failed' }])
  const lateEvents: PiRpcEvent[] = []
  proc.onEvent(event => lateEvents.push(event))
  assert.deepEqual(lateEvents, events)
})

test('exit with inherited pipes still settles after a bounded drain wait', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { child, session } = setup()
  const turn = session.prompt('accepted')
  child.emit('exit', 1, null)
  assert.equal(session.isClosed, false)
  t.mock.timers.tick(1000)
  assert.equal(await turn, 'error')
  assert.equal(session.isClosed, true)
})

test('exit waits for stdout to drain before emitting process_exit', async () => {
  const { child, proc, session } = setup()
  const events: PiRpcEvent[] = []
  proc.onEvent(event => events.push(event))
  const turn = session.prompt('accepted')
  await new Promise<void>(resolve => setImmediate(resolve))
  child.emit('exit', 0, null)
  assert.equal(session.isClosed, false)
  assert.equal(events.length, 0)
  child.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\n')
  child.stdout.end()
  child.emit('close', 0, null)
  assert.equal(await turn, 'end_turn')
  assert.deepEqual(
    events.map(event => event.type),
    ['agent_settled', 'process_exit']
  )
})
