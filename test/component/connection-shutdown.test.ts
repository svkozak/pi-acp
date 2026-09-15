import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

for (const shutdown of ['stdin end', 'SIGTERM'] as const) {
  test(
    `adapter ${shutdown} terminates all session children`,
    {
      timeout: 10000,
      skip: process.platform === 'win32' && 'fixture uses a POSIX executable'
    },
    async t => {
      const cwd = mkdtempSync(join(tmpdir(), 'pi-acp-shutdown-'))
      const pi = join(cwd, 'pi')
      const pidFile = join(cwd, 'pids')
      writeFileSync(
        pi,
        `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('test-fixture'); process.exit(0); }
fs.appendFileSync(process.env.TEST_PI_PIDS, process.pid + '\\n');
const sessionId = 'test-' + process.pid;
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  const data = command.type === 'get_state'
    ? { sessionId, sessionFile: process.cwd() + '/' + sessionId + '.jsonl', model: { provider: 'test', id: 'model' } }
    : command.type === 'get_available_models' ? { models: [{ provider: 'test', id: 'model' }] }
    : command.type === 'get_messages' ? { messages: [] } : { commands: [] };
  console.log(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data }));
});
`
      )
      chmodSync(pi, 0o755)
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
        cwd: root,
        stdio: 'pipe',
        env: {
          ...process.env,
          HOME: cwd,
          PI_CODING_AGENT_DIR: cwd,
          PI_ACP_PI_COMMAND: pi,
          TEST_PI_PIDS: pidFile,
          PATH: cwd + delimiter + (process.env.PATH ?? '')
        }
      })
      let stderr = ''
      child.stderr.on('data', data => {
        stderr += String(data)
      })
      const readPids = () => {
        try {
          return readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean).map(Number)
        } catch {
          return []
        }
      }
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        for (const pid of readPids()) {
          try {
            process.kill(pid, 'SIGKILL')
          } catch {
            /* already exited */
          }
        }
        await delay(20)
        rmSync(cwd, { recursive: true, force: true })
      })
      const replies = new Map<number, (reply: { result?: { sessionId: string }; error?: unknown }) => void>()
      let buffer = ''
      child.stdout.on('data', data => {
        buffer += String(data)
        let index: number
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          const reply = JSON.parse(line) as { id: number; result?: { sessionId: string }; error?: unknown }
          replies.get(reply.id)?.(reply)
          replies.delete(reply.id)
        }
      })
      let id = 0
      async function request(method: string, params: unknown) {
        const requestId = ++id
        const reply = new Promise<{ result?: { sessionId: string }; error?: unknown }>(resolve => {
          replies.set(requestId, resolve)
        })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
        const result = await reply
        assert.equal(result.error, undefined, stderr)
        return result.result
      }
      await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const first = await request('session/new', { cwd, mcpServers: [] })
      await request('session/prompt', { sessionId: first!.sessionId, prompt: [{ type: 'text', text: '/session' }] })
      await request('session/new', { cwd, mcpServers: [] })
      const pids = readPids()
      assert.equal(pids.length, 2)
      assert.ok(pids.every(isAlive), 'both sessions must remain alive before disconnect')
      const closed = once(child, 'close')
      if (shutdown === 'stdin end') child.stdin.end()
      else child.kill('SIGTERM')
      await closed
      for (let attempt = 0; attempt < 100 && pids.some(isAlive); attempt++) await delay(20)
      assert.ok(
        pids.every(pid => !isAlive(pid)),
        `session children survived adapter shutdown: ${pids}; ${stderr}`
      )
    }
  )
}
