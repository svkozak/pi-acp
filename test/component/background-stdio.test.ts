import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

interface Message {
  id?: number
  method?: string
  result?: { sessionId?: string; stopReason?: string }
  error?: unknown
  params?: { update?: { sessionUpdate?: string; toolCallId?: string; status?: string; content?: { text?: string } } }
}

async function client(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-wire-'))
  const executable = join(dir, 'pi.mjs')
  const preload = join(dir, 'home.mjs')
  writeFileSync(
    preload,
    `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => process.env.PI_ACP_TEST_HOME; syncBuiltinESMExports();`
  )
  writeFileSync(
    executable,
    `#!${process.execPath}\n` +
      String.raw`
import { appendFileSync, existsSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
const dir = process.cwd()
const output = value => process.stdout.write(JSON.stringify(value) + '\n')
const bridge = value => output({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'pi-acp/background', statusText: JSON.stringify({ version: 1, ...value }) })
const job = { id: 'child', title: 'Background child' }
const text = value => output({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: value } })
const settled = () => output({ type: 'agent_settled' })
const response = (request, data = {}) => output({ type: 'response', id: request.id, command: request.type, success: true, data })
const model = { id: 'fixture', provider: 'fixture', name: 'Fixture', reasoning: true }
const sessionFile = join(dir, 'session.jsonl')
let pendingCancel
let continued = false
const controls = () => {
  if (!continued && existsSync(join(dir, 'continue'))) {
    continued = true
    bridge({ type: 'snapshot', active: [], idle: false, finished: { ...job, status: 'completed' } })
    output({ type: 'agent_start' })
    text('Final continuation answer')
    bridge({ type: 'snapshot', active: [], idle: true })
    settled()
  }
  if (pendingCancel && existsSync(join(dir, 'release-cancel'))) {
    appendFileSync(join(dir, 'events'), 'proof\n')
    bridge({ type: 'cancelled' })
    response(pendingCancel)
    pendingCancel = undefined
  }
}
watch(dir, controls)
process.on('SIGTERM', () => { appendFileSync(join(dir, 'events'), 'exit\n'); process.exit(0) })
writeFileSync(sessionFile, '')
bridge({ type: 'ready' })
bridge({ type: 'snapshot', active: [], idle: true })
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.type === 'get_state') return response(request, { sessionId: 'fixture-session', sessionFile, model, thinkingLevel: 'off' })
  if (request.type === 'get_available_models') return response(request, { models: [model] })
  if (request.type === 'get_available_thinking_levels') return response(request, { levels: ['off'] })
  if (request.type === 'get_commands') return response(request, { commands: [] })
  if (request.type === 'prompt' && request.message === '/pi-acp-background cancel') {
    pendingCancel = request
    text('Cancellation requested')
    controls()
    return
  }
  if (request.type === 'prompt') {
    response(request)
    output({ type: 'agent_start' })
    bridge({ type: 'snapshot', active: [job], idle: false })
    settled()
    text('Parent settled with background work')
    return
  }
  response(request)
})
`
  )
  chmodSync(executable, 0o755)
  const child = spawn(
    process.execPath,
    ['--import', preload, '--import', 'tsx', fileURLToPath(new URL('../../src/index.ts', import.meta.url))],
    {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      stdio: 'pipe',
      env: {
        ...process.env,
        PI_ACP_TEST_HOME: dir,
        PI_CODING_AGENT_DIR: join(dir, 'agent'),
        PI_ACP_PI_COMMAND: executable
      }
    }
  )
  let stderr = ''
  child.stderr.on('data', value => {
    stderr += String(value)
  })
  const exited = once(child, 'exit')
  const messages: Message[] = []
  const listeners = new Set<() => void>()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    messages.push(JSON.parse(line) as Message)
    for (const listener of listeners) listener()
  })
  t.after(async () => {
    writeFileSync(join(dir, 'release-cancel'), '')
    child.stdin.end()
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
    try {
      await exited
    } finally {
      clearTimeout(timeout)
      lines.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  function wait(predicate: (message: Message) => boolean): Promise<Message> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check)
        reject(new Error(`ACP response timed out: ${stderr}\n${JSON.stringify(messages)}`))
      }, 5_000)
      const check = () => {
        const value = messages.find(predicate)
        if (!value) return
        clearTimeout(timer)
        listeners.delete(check)
        resolve(value)
      }
      listeners.add(check)
      check()
    })
  }
  const send = (value: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
  send({ id: 1, method: 'initialize', params: { protocolVersion: 1 } })
  assert.equal((await wait(message => message.id === 1)).error, undefined)
  send({ id: 2, method: 'session/new', params: { cwd: dir, mcpServers: [] } })
  const created = await wait(message => message.id === 2)
  assert.equal(created.error, undefined)
  assert.equal(created.result?.sessionId, 'fixture-session')
  return { dir, messages, send, wait }
}

const options = { skip: process.platform === 'win32', timeout: 15_000 }
const updateText = (message: Message) => message.params?.update?.content?.text

test('ACP stdio keeps the one prompt pending until background continuation finishes', options, async t => {
  const wire = await client(t)
  wire.send({
    id: 3,
    method: 'session/prompt',
    params: { sessionId: 'fixture-session', prompt: [{ type: 'text', text: 'delegate' }] }
  })
  await wire.wait(message => updateText(message) === 'Parent settled with background work')
  wire.send({ id: 4, method: 'initialize', params: { protocolVersion: 1 } })
  await wire.wait(message => message.id === 4)
  assert.equal(
    wire.messages.some(message => message.id === 3),
    false
  )
  assert.ok(
    wire.messages.some(
      message =>
        message.params?.update?.toolCallId === 'background:child' && message.params.update.status === 'in_progress'
    )
  )
  writeFileSync(join(wire.dir, 'continue'), '')
  const response = await wire.wait(message => message.id === 3)
  assert.equal(response.result?.stopReason, 'end_turn')
  assert.equal(wire.messages.filter(message => message.id === 3).length, 1)
  assert.ok(
    wire.messages.findIndex(message => updateText(message) === 'Final continuation answer') <
      wire.messages.indexOf(response)
  )
})

test('ACP stdio Stop waits for cancellation proof and parent exit before answering the prompt', options, async t => {
  const wire = await client(t)
  wire.send({
    id: 3,
    method: 'session/prompt',
    params: { sessionId: 'fixture-session', prompt: [{ type: 'text', text: 'delegate' }] }
  })
  await wire.wait(message => updateText(message) === 'Parent settled with background work')
  wire.send({ method: 'session/cancel', params: { sessionId: 'fixture-session' } })
  await wire.wait(message => updateText(message) === 'Cancellation requested')
  wire.send({ id: 4, method: 'initialize', params: { protocolVersion: 1 } })
  await wire.wait(message => message.id === 4)
  assert.equal(
    wire.messages.some(message => message.id === 3),
    false
  )
  writeFileSync(join(wire.dir, 'release-cancel'), '')
  assert.equal((await wire.wait(message => message.id === 3)).result?.stopReason, 'cancelled')
  assert.equal(wire.messages.filter(message => message.id === 3).length, 1)
  assert.deepEqual(readFileSync(join(wire.dir, 'events'), 'utf8').trim().split('\n'), ['proof', 'exit'])
})
