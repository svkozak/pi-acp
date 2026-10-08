import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { PiAcpSession, getSessionConfiguration, PROJECTION_API_VERSION } from '../../src/library.js'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'
import { FakeAgentSideConnection, FakePiRpcProcess, asAgentConn } from '../helpers/fakes.js'

test('library imports without starting the CLI or a child process', () => {
  const source = `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])
      cp[name] = () => { throw new Error('Unexpected child process'); };
    syncBuiltinESMExports();
    const library = await import('./src/library.ts');
    process.stdout.write(String(library.PROJECTION_API_VERSION));
  `
  assert.equal(
    execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      encoding: 'utf8',
      timeout: 5000,
      input: ''
    }),
    '1'
  )
})

test('public projection operations deliver ordered text and tool updates', async () => {
  assert.equal(PROJECTION_API_VERSION, 1)
  const conn = new FakeAgentSideConnection()
  const proc = new FakePiRpcProcess()
  const session = new PiAcpSession({
    sessionId: 'sdk-session',
    cwd: process.cwd(),
    mcpServers: [],
    proc: proc as unknown as PiRpcProcess,
    conn: asAgentConn(conn)
  })
  session.emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'before' } })
  session.handlePiEvent({
    type: 'tool_execution_start',
    toolCallId: 'tool-1',
    toolName: 'read',
    args: { path: 'missing-fixture' }
  })
  assert.equal(session.hasToolCall('tool-1'), true)
  session.handlePiEvent({
    type: 'tool_execution_end',
    toolCallId: 'tool-1',
    result: { content: [{ type: 'text', text: 'done' }] },
    isError: false
  })
  assert.equal(session.hasToolCall('tool-1'), false)
  await session.flushEmits()
  assert.deepEqual(
    conn.updates.map(value => value.update.sessionUpdate),
    ['agent_message_chunk', 'tool_call', 'tool_call_update']
  )
  assert.ok(conn.updates.every(value => value.sessionId === 'sdk-session'))
  assert.deepEqual(proc.prompts, [])
})

test('configuration accepts an SDK-backed structural source', async () => {
  const result = await getSessionConfiguration({
    getState: async () => ({ model: { provider: 'test', id: 'model' }, thinkingLevel: 'high' }),
    getAvailableModels: async () => ({ models: [{ provider: 'test', id: 'model', name: 'Model' }] }),
    getAvailableThinkingLevels: async () => ['low', 'high']
  })
  assert.equal(result.models?.currentModelId, 'test/model')
  assert.equal(result.configOptions.find(option => option.category === 'thought_level')?.currentValue, 'high')
})
