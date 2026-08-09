import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { PiRpcProcess, PiRpcTimeoutError } from '../../src/pi-rpc/process.js'

type RpcCommand = { id: string; type: string }

function fakeProcess(onCommand: (command: RpcCommand, respond: (data?: unknown) => void) => void, timeoutMs = 10) {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    killed: boolean
    exitCode: number | null
    signalCode: NodeJS.Signals | null
    kill: (signal?: NodeJS.Signals | number) => boolean
  }
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.killed = false
  child.exitCode = null
  child.signalCode = null

  const commands: RpcCommand[] = []
  const killSignals: Array<NodeJS.Signals | number> = []
  let input = ''

  child.stdin.setEncoding('utf8')
  child.stdin.on('data', chunk => {
    input += chunk
    let newline = input.indexOf('\n')
    while (newline >= 0) {
      const line = input.slice(0, newline)
      input = input.slice(newline + 1)
      const command = JSON.parse(line) as RpcCommand
      commands.push(command)
      onCommand(command, data => {
        child.stdout.write(
          `${JSON.stringify({
            id: command.id,
            type: 'response',
            command: command.type,
            success: true,
            data
          })}\n`
        )
      })
      newline = input.indexOf('\n')
    }
  })

  child.kill = (signal: NodeJS.Signals | number = 'SIGTERM') => {
    if (child.killed) return false
    child.killed = true
    child.signalCode = typeof signal === 'string' ? signal : null
    killSignals.push(signal)
    child.emit('exit', null, signal)
    child.stdin.destroy()
    child.stdout.destroy()
    child.stderr.destroy()
    return true
  }

  return {
    proc: new (PiRpcProcess as unknown as new (
      child: unknown,
      timeoutMs: number,
      promptIdleTimeoutMs: number
    ) => PiRpcProcess)(child, timeoutMs, 0),
    commands,
    killSignals,
    emit(event: unknown) {
      child.stdout.write(`${JSON.stringify(event)}\n`)
    }
  }
}

test('PiRpcProcess: rejects and terminates pi when prompt ACK remains idle', async () => {
  const harness = fakeProcess((command, respond) => {
    if (command.type === 'get_state') respond({ isStreaming: false, isCompacting: false })
  })

  await assert.rejects(
    () => harness.proc.prompt('hello'),
    error => error instanceof PiRpcTimeoutError && /prompt/.test(error.message)
  )

  assert.deepEqual(
    harness.commands.map(command => command.type),
    ['prompt', 'get_state']
  )
  assert.deepEqual(harness.killSignals, ['SIGTERM'])
  await assert.rejects(() => harness.proc.getState(), PiRpcTimeoutError)
})

test('PiRpcProcess: reconciles a missing prompt ACK when pi is already streaming', async t => {
  const harness = fakeProcess((command, respond) => {
    if (command.type === 'get_state') respond({ isStreaming: true, isCompacting: false })
  })
  t.after(() => harness.proc.dispose())

  await harness.proc.prompt('hello')

  assert.deepEqual(
    harness.commands.map(command => command.type),
    ['prompt', 'get_state']
  )
  assert.deepEqual(harness.killSignals, [])
})

test('PiRpcProcess: reconciles a missing prompt ACK after agent_start without probing state', async t => {
  const harness = fakeProcess(() => {})
  t.after(() => harness.proc.dispose())

  const prompting = harness.proc.prompt('hello')
  harness.emit({ type: 'agent_start' })
  await prompting

  assert.deepEqual(
    harness.commands.map(command => command.type),
    ['prompt']
  )
  assert.deepEqual(harness.killSignals, [])
})

test('PiRpcProcess: keeps a single prompt alive while pi reports compaction', async t => {
  let probes = 0
  const harness = fakeProcess((command, respond) => {
    if (command.type !== 'get_state') return
    probes += 1
    respond(probes === 1 ? { isStreaming: false, isCompacting: true } : { isStreaming: true, isCompacting: false })
  })
  t.after(() => harness.proc.dispose())

  await harness.proc.prompt('hello')

  assert.deepEqual(
    harness.commands.map(command => command.type),
    ['prompt', 'get_state', 'get_state']
  )
  assert.equal(harness.commands.filter(command => command.type === 'prompt').length, 1)
  assert.deepEqual(harness.killSignals, [])
})
