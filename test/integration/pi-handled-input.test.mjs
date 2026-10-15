import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { createServer } from 'node:http'

const exec = promisify(execFile)
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const extension = `export default function(pi) {
  pi.on('input', async (event, ctx) => {
    if (event.text === 'handled') return { action: 'handled' };
    if (event.text === 'confirm') {
      const approved = await ctx.ui.confirm('Test permission', 'Approve this test?');
      ctx.ui.notify(approved ? 'test approved' : 'test denied');
      return { action: 'handled' };
    }
    if (event.text === 'extension-model') {
      pi.sendUserMessage('Reply with hello.');
      return { action: 'handled' };
    }
    return { action: 'continue' };
  });
}`

function deferred() {
  let resolve
  const promise = new Promise(r => {
    resolve = r
  })
  return { promise, resolve }
}

async function client(t, root, pi, entry, providerUrl, projectTrusted = false) {
  const directory = await mkdtemp(join(root, 'case-'))
  const home = join(directory, 'home')
  const agent = join(directory, 'agent')
  const workspace = join(directory, 'workspace')
  await Promise.all([
    mkdir(home),
    mkdir(join(agent, 'extensions'), { recursive: true }),
    mkdir(join(workspace, '.pi'), { recursive: true })
  ])
  await writeFile(join(agent, 'extensions/test.ts'), extension)
  await writeFile(
    join(agent, 'models.json'),
    JSON.stringify({
      providers: {
        repro: {
          baseUrl: providerUrl,
          api: 'openai-completions',
          apiKey: 'local-test-only',
          models: [{ id: 'repro-model', name: 'Repro', contextWindow: 8192, maxTokens: 128 }]
        }
      }
    })
  )
  await writeFile(
    join(agent, 'settings.json'),
    JSON.stringify({ defaultProvider: 'repro', defaultModel: 'repro-model' })
  )
  await writeFile(join(workspace, '.pi/settings.json'), '{}')
  await mkdir(join(workspace, '.pi/extensions'))
  await writeFile(
    join(workspace, '.pi/extensions/trust.ts'),
    `export default function(pi) {
    pi.on('input', async (event) => event.text === 'project-probe' ? { action: 'handled' } : { action: 'continue' });
  }`
  )
  if (projectTrusted) await writeFile(join(agent, 'trust.json'), JSON.stringify({ [workspace]: true }))
  const child = spawn(process.execPath, [entry], {
    cwd: workspace,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: agent,
      PI_OFFLINE: '1',
      PI_ACP_PI_COMMAND: pi
    }
  })
  let stderr = ''
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-4000)
  })
  const closed = new Promise(resolve => child.once('close', resolve))
  t.after(async () => {
    if (process.platform === 'win32') {
      if (child.exitCode === null) await exec('taskkill', ['/PID', String(child.pid), '/T', '/F'])
    } else {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') throw error
      }
    }
    await closed
  })
  const pending = new Map()
  const updates = []
  const permissions = []
  let optionId = 'no'
  let id = 0
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    const frame = JSON.parse(line)
    if (frame.method === 'session/update') updates.push(frame.params.update)
    else if (frame.method === 'session/request_permission') {
      permissions.push(frame.params)
      send({ id: frame.id, result: { outcome: { outcome: 'selected', optionId } } })
    } else if (frame.id !== undefined && pending.has(frame.id)) {
      const request = pending.get(frame.id)
      pending.delete(frame.id)
      clearTimeout(request.timer)
      if (frame.error) request.reject(new Error(JSON.stringify(frame.error)))
      else request.resolve(frame.result)
    }
  })
  child.once('close', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error(`Bridge exited: ${stderr}`))
    }
    pending.clear()
  })
  function request(method, params) {
    const requestId = ++id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`${method} did not complete within 10 seconds: ${stderr}`))
      }, 10_000)
      pending.set(requestId, { resolve, reject, timer })
      send({ id: requestId, method, params })
    })
  }
  await request('initialize', {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: 'pi-regression', version: '1' }
  })
  const { sessionId } = await request('session/new', { cwd: workspace, mcpServers: [] })
  return {
    updates,
    permissions,
    setPermission(value) {
      optionId = value
    },
    prompt(text) {
      return request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
    }
  }
}

test('real Pi 1.2.0 prompt completion over ACP', { timeout: 180_000 }, async t => {
  const configured = process.env.PI_ACP_TEST_ENTRY
  if (configured !== undefined) assert.ok(isAbsolute(configured), 'PI_ACP_TEST_ENTRY must be absolute')
  const entry = configured ?? join(repository, 'dist/index.js')
  await access(entry)
  const root = await mkdtemp(join(tmpdir(), 'pi-handled-input-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await exec(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    [
      'install',
      '--prefix',
      root,
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '@earendil-works/pi-coding-agent@1.2.0'
    ],
    { timeout: 120_000 }
  )
  const pi = join(root, 'node_modules/.bin', process.platform === 'win32' ? 'pi.cmd' : 'pi')
  let modelRequest = deferred()
  let releaseModel = deferred()
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) {
      /* Drain the request before completing it. */
    }
    modelRequest.resolve()
    await releaseModel.promise
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (const [delta, finish_reason] of [
      [{ role: 'assistant', content: 'hello from local provider' }, null],
      [{}, 'stop']
    ]) {
      response.write(
        `data: ${JSON.stringify({ id: 'repro', object: 'chat.completion.chunk', created: 1, model: 'repro-model', choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      )
    }
    response.end('data: [DONE]\n\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    releaseModel.resolve()
    server.closeAllConnections()
    server.close()
  })
  const url = `http://127.0.0.1:${server.address().port}/v1`

  await t.test('two handled prompts complete in the same session', async t => {
    const acp = await client(t, root, pi, entry, url)
    assert.equal((await acp.prompt('handled')).stopReason, 'end_turn')
    assert.equal((await acp.prompt('handled')).stopReason, 'end_turn')
  })
  await t.test('confirm permission reaches the client and preserves both choices', async t => {
    const acp = await client(t, root, pi, entry, url)
    for (const [choice, notice] of [
      ['no', 'test denied'],
      ['yes', 'test approved']
    ]) {
      acp.setPermission(choice)
      assert.equal((await acp.prompt('confirm')).stopReason, 'end_turn')
      assert.ok(acp.updates.some(update => update.content?.text === notice))
    }
    assert.equal(acp.permissions.length, 2)
    assert.equal(acp.permissions[0].toolCall.title, 'Test permission')
  })
  for (const prompt of ['Reply with hello.', 'extension-model', 'project-probe']) {
    await t.test(`${prompt} waits for model completion in an untrusted project`, async t => {
      modelRequest = deferred()
      releaseModel = deferred()
      t.after(() => releaseModel.resolve())
      const acp = await client(t, root, pi, entry, url)
      let finished = false
      const result = acp.prompt(prompt).then(value => {
        finished = true
        return value
      })
      await modelRequest.promise
      assert.equal(finished, false)
      releaseModel.resolve()
      assert.equal((await result).stopReason, 'end_turn')
      assert.ok(acp.updates.some(update => update.content?.text?.includes('hello from local provider')))
    })
  }
  await t.test('trusted project loads its project extension', async t => {
    const acp = await client(t, root, pi, entry, url, true)
    assert.equal((await acp.prompt('project-probe')).stopReason, 'end_turn')
    assert.ok(!acp.updates.some(update => update.content?.text?.includes('hello from local provider')))
  })
})
