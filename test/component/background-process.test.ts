import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RequestError } from '@agentclientprotocol/sdk'
import { PiRpcProcess, type PiRpcEvent } from '../../src/pi-rpc/process.js'
import { PiAcpSession } from '../../src/acp/session.js'
import { FakeAgentSideConnection, asAgentConn } from '../helpers/fakes.js'

const processTestOptions = { skip: process.platform === 'win32', timeout: 10_000 }

function fixture(t: TestContext, mode = 'normal') {
  const dir = mkdtempSync(join(tmpdir(), 'pi-acp-background-process-'))
  const executable = join(dir, 'pi.mjs')
  const logPath = join(dir, 'log.jsonl')
  const source = String.raw`
import { appendFileSync, existsSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
const dir = process.cwd()
const mode = ${JSON.stringify(mode)}
const sessionArg = process.argv.indexOf('--session')
const sessionFile = sessionArg < 0 ? join(dir, 'persisted.jsonl') : process.argv[sessionArg + 1]
const log = action => appendFileSync(join(dir, 'log.jsonl'), JSON.stringify({ action, pid: process.pid, sessionFile }) + '\n')
const emit = event => process.stdout.write(JSON.stringify(event) + '\n')
const bridge = message => emit({ type: 'extension_ui_request', id: 'status', method: 'setStatus', statusKey: 'pi-acp/background', statusText: JSON.stringify({ version: 1, ...message }) })
const snapshot = (active, idle, finished) => bridge({ type: 'snapshot', active, idle, ...(finished ? { finished } : {}) })
const job = { id: 'worker', title: 'Background worker' }
const settle = () => { emit({ type: 'agent_end' }); emit({ type: 'agent_settled' }) }
const response = (request, data = {}) => emit({ type: 'response', id: request.id, command: request.type, success: true, data })
const controls = new Set()
let awaitingExit = false
const processControls = () => {
  for (const name of ['continue', 'finish', 'crash', 'exit-release', 'malformed-running']) {
    if (controls.has(name) || !existsSync(join(dir, name))) continue
    controls.add(name)
    if (name === 'continue') {
      snapshot([], false, { ...job, status: 'completed', text: 'Child done' })
      emit({ type: 'agent_start' })
      emit({ type: 'fixture', action: 'continuation_started' })
    }
    if (name === 'finish') { snapshot([], true); settle() }
    if (name === 'crash') process.exit(42)
    if (name === 'malformed-running') emit({ type: 'extension_ui_request', method: 'setStatus', statusKey: 'pi-acp/background', statusText: '{invalid' })
    if (name === 'exit-release' && awaitingExit) process.exit(0)
  }
}
watch(dir, processControls)
process.on('SIGTERM', () => {
  log('sigterm')
  if (mode === 'hold-exit' && !existsSync(join(dir, 'exit-release'))) {
    awaitingExit = true
    writeFileSync(join(dir, 'retiring'), '')
  } else process.exit(0)
})
log('spawn')
writeFileSync(sessionFile, existsSync(sessionFile) ? readFileSync(sessionFile) : '')
if (mode === 'malformed') {
  emit({ type: 'extension_ui_request', id: 'status', method: 'setStatus', statusKey: 'pi-acp/background', statusText: '{invalid' })
} else if (mode !== 'missing') {
  bridge({ type: 'ready' })
  snapshot([], true)
}
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (request.type === 'get_state') return response(request, { sessionFile, pid: process.pid })
  if (request.type === 'get_commands') return response(request, { commands: [{ name: 'pi-acp-background' }, { name: 'ordinary' }] })
  if (request.type === 'prompt' && request.message === '/pi-acp-background cancel') {
    log('cancel')
    if (mode === 'late-launch') { snapshot([job], false); settle() }
    bridge({ type: 'cancelled', ...(mode === 'cancel-error' ? { error: 'Worker shutdown could not be verified' } : {}) })
    response(request)
    log('acknowledged')
    return
  }
  if (request.type === 'prompt') {
    response(request)
    emit({ type: 'agent_start' })
    if (mode === 'late-launch') {
      emit({ type: 'fixture', action: 'launching' })
    } else if (request.message === 'background') {
      snapshot([job], false)
      settle()
    } else {
      snapshot([], true)
      settle()
    }
    return
  }
  response(request)
})
`
  writeFileSync(executable, `#!${process.execPath}\n${source}`)
  chmodSync(executable, 0o755)
  let proc: PiRpcProcess | undefined
  t.after(async () => {
    writeFileSync(join(dir, 'exit-release'), '')
    await proc?.dispose().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    dir,
    trigger(name: string) {
      writeFileSync(join(dir, name), '')
    },
    records(): Array<{ action: string; pid: number; sessionFile: string }> {
      return readFileSync(logPath, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
    },
    async start() {
      proc = await PiRpcProcess.spawn({ cwd: dir, piCommand: executable })
      return proc
    }
  }
}

function nextEvent(proc: PiRpcProcess, predicate: (event: PiRpcEvent) => boolean) {
  return new Promise<PiRpcEvent>(resolve => {
    let unsubscribe = () => {}
    unsubscribe = proc.onEvent(event => {
      if (predicate(event)) {
        unsubscribe()
        resolve(event)
      }
    })
  })
}

function observe(promise: Promise<unknown>) {
  const state = { settled: false }
  void promise.then(
    () => {
      state.settled = true
    },
    () => {
      state.settled = true
    }
  )
  return state
}

async function waitForFile(t: TestContext, dir: string, name: string) {
  if (existsSync(join(dir, name))) return
  await new Promise<void>(resolve => {
    const watcher = watch(dir, () => {
      if (existsSync(join(dir, name))) {
        watcher.close()
        resolve()
      }
    })
    t.after(() => watcher.close())
    if (existsSync(join(dir, name))) {
      watcher.close()
      resolve()
    }
  })
}

function createSession(proc: PiRpcProcess, dir: string) {
  const conn = new FakeAgentSideConnection()
  return {
    conn,
    session: new PiAcpSession({ sessionId: 'real-process', cwd: dir, mcpServers: [], proc, conn: asAgentConn(conn) })
  }
}

test(
  'PiRpcProcess: bridge handshake hides its command and keeps ACP open through background continuation',
  processTestOptions,
  async t => {
    const fake = fixture(t)
    const proc = await fake.start()
    assert.deepEqual(await proc.getCommands(), { commands: [{ name: 'ordinary' }] })
    const { session, conn } = createSession(proc, fake.dir)
    const parentSettled = nextEvent(proc, event => event.type === 'agent_settled')
    const prompt = session.prompt('background')
    const state = observe(prompt)
    await parentSettled
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(state.settled, false)

    const continuing = nextEvent(proc, event => event.type === 'fixture' && event.action === 'continuation_started')
    fake.trigger('continue')
    await continuing
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(state.settled, false)
    fake.trigger('finish')
    assert.equal(await prompt, 'end_turn')
    const statuses = conn.updates.flatMap(({ update }) =>
      (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') &&
      update.toolCallId === 'background:worker'
        ? [update.status]
        : []
    )
    assert.deepEqual(statuses, ['in_progress', 'completed'])
  }
)

test(
  'PiRpcProcess: cancellation waits for process exit then resumes the same session in a new process',
  processTestOptions,
  async t => {
    const fake = fixture(t, 'hold-exit')
    const proc = await fake.start()
    const original = (await proc.getState()) as { pid: number; sessionFile: string }
    const { session } = createSession(proc, fake.dir)
    const parentSettled = nextEvent(proc, event => event.type === 'agent_settled')
    const prompt = session.prompt('background')
    const state = observe(prompt)
    await parentSettled
    const cancel = session.cancel()
    const cancelState = observe(cancel)
    await waitForFile(t, fake.dir, 'retiring')
    assert.equal(state.settled, false)
    assert.equal(cancelState.settled, false)
    assert.equal(fake.records().filter(record => record.action === 'spawn').length, 1)

    fake.trigger('exit-release')
    await cancel
    assert.equal(await prompt, 'cancelled')
    assert.throws(() => process.kill(original.pid, 0), { code: 'ESRCH' })
    assert.equal(await session.prompt('ordinary'), 'end_turn')
    const resumed = (await proc.getState()) as { pid: number; sessionFile: string }
    assert.notEqual(resumed.pid, original.pid)
    assert.equal(resumed.sessionFile, original.sessionFile)
    assert.equal(fake.records().filter(record => record.action === 'spawn').length, 2)
  }
)

test(
  'PiRpcProcess: failed cancellation verification rejects active work and forbids process restart',
  processTestOptions,
  async t => {
    const fake = fixture(t, 'cancel-error')
    const proc = await fake.start()
    const { session } = createSession(proc, fake.dir)
    const parentSettled = nextEvent(proc, event => event.type === 'agent_settled')
    const prompt = session.prompt('background')
    const queued = session.prompt('ordinary')
    const activeRejected = assert.rejects(prompt, (error: unknown) => {
      assert.ok(error instanceof RequestError)
      assert.match(error.message, /shutdown could not be verified/)
      return true
    })
    await parentSettled
    await assert.rejects(session.cancel(), /shutdown could not be verified/)
    await activeRejected
    assert.equal(await queued, 'cancelled')
    await assert.rejects(session.prompt('retry'), RequestError)
    await assert.rejects(proc.prompt('retry'), /shutdown could not be verified/)
    assert.equal(fake.records().filter(record => record.action === 'spawn').length, 1)
  }
)

test(
  'PiRpcProcess: an unexpected exit rejects active background work and queued requests',
  processTestOptions,
  async t => {
    const fake = fixture(t)
    const proc = await fake.start()
    const { session } = createSession(proc, fake.dir)
    const parentSettled = nextEvent(proc, event => event.type === 'agent_settled')
    const prompt = session.prompt('background')
    const queued = session.prompt('ordinary')
    const activeRejected = assert.rejects(prompt, RequestError)
    const queuedRejected = assert.rejects(queued, RequestError)
    await parentSettled
    fake.trigger('crash')
    await Promise.all([activeRejected, queuedRejected])
    await assert.rejects(session.prompt('retry'), /process exited/)
  }
)

for (const mode of ['malformed', 'missing']) {
  test(`PiRpcProcess: ${mode} background handshake fails during startup`, processTestOptions, async t => {
    const fake = fixture(t, mode)
    await assert.rejects(fake.start(), mode === 'missing' ? /bridge did not initialize/ : /JSON|background/)
    const spawned = fake.records().find(record => record.action === 'spawn')
    assert.ok(spawned)
    assert.throws(() => process.kill(spawned.pid, 0), { code: 'ESRCH' })
  })
}

test('PiRpcProcess: disposal verifies background shutdown before retiring its process', processTestOptions, async t => {
  const fake = fixture(t)
  const proc = await fake.start()
  const parentSettled = nextEvent(proc, event => event.type === 'agent_settled')
  await proc.prompt('background')
  await parentSettled
  await proc.dispose()
  const records = fake.records()
  assert.deepEqual(
    records.map(record => record.action),
    ['spawn', 'cancel', 'acknowledged', 'sigterm']
  )
  assert.throws(() => process.kill(records[0]!.pid, 0), { code: 'ESRCH' })
  await assert.rejects(proc.prompt('ordinary'), /disposed/)
})

test('PiRpcProcess: repeated Stop after retirement completes the pending prompt', processTestOptions, async t => {
  const fake = fixture(t)
  const proc = await fake.start()
  const { session, conn } = createSession(proc, fake.dir)
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>(resolve => {
    enter = resolve
  })
  const blocked = new Promise<void>(resolve => {
    release = resolve
  })
  t.after(() => release())
  const send = conn.sessionUpdate.bind(conn)
  conn.sessionUpdate = async message => {
    const running = (message.update._meta as { piAcp?: { running?: boolean } } | undefined)?.piAcp?.running
    if (running === false) {
      enter()
      await blocked
    }
    await send(message)
  }
  const parentSettled = nextEvent(proc, event => event.type === 'agent_settled')
  const prompt = session.prompt('background')
  await parentSettled
  await session.cancel()
  await entered
  await session.cancel()
  release()
  assert.equal(await prompt, 'cancelled')
  assert.equal(fake.records().filter(record => record.action === 'cancel').length, 1)
})

test(
  'PiRpcProcess: Stop during a launch uses group cancellation before the first background snapshot',
  processTestOptions,
  async t => {
    const fake = fixture(t, 'late-launch')
    const proc = await fake.start()
    const { session } = createSession(proc, fake.dir)
    const launching = nextEvent(proc, event => event.type === 'fixture' && event.action === 'launching')
    const prompt = session.prompt('launch')
    await launching
    await session.cancel()
    assert.equal(await prompt, 'cancelled')
    assert.deepEqual(
      fake.records().map(record => record.action),
      ['spawn', 'cancel', 'acknowledged', 'sigterm']
    )
  }
)

test(
  'PiRpcProcess: malformed live bridge output still runs group cleanup before reporting failure',
  processTestOptions,
  async t => {
    const fake = fixture(t)
    const proc = await fake.start()
    const { session } = createSession(proc, fake.dir)
    const parentSettled = nextEvent(proc, event => event.type === 'agent_settled')
    const prompt = session.prompt('background')
    const rejected = assert.rejects(prompt, /JSON|property name/)
    await parentSettled
    fake.trigger('malformed-running')
    await rejected
    assert.deepEqual(
      fake.records().map(record => record.action),
      ['spawn', 'cancel', 'acknowledged', 'sigterm']
    )
    await proc.dispose()
    assert.throws(() => process.kill(fake.records()[0]!.pid, 0), { code: 'ESRCH' })
  }
)
