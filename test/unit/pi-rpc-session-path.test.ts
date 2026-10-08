import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

function writeFakePi(root: string): string {
  const fixture = join(root, 'fake-pi.cjs')
  writeFileSync(
    fixture,
    [
      "const { appendFileSync } = require('node:fs')",
      "const readline = require('node:readline')",
      "const sessionPath = process.argv[process.argv.indexOf('--session') + 1]",
      "appendFileSync(sessionPath, 'started\\n')",
      "readline.createInterface({ input: process.stdin }).on('line', line => {",
      '  const command = JSON.parse(line)',
      "  process.stdout.write(JSON.stringify({ type: 'response', id: command.id, command: command.type, success: true, data: { sessionFile: sessionPath } }) + '\\n')",
      '  setTimeout(() => process.exit(0), 20)',
      '})'
    ].join('\n')
  )
  return fixture
}

test('PiRpcProcess passes distinct session paths intact to the pi launcher', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-acp launcher '))
  const fixture = writeFakePi(root)
  const launchers = process.platform === 'win32' ? ['pi.cmd', 'pi.bat'] : ['pi']
  const previousTestVar = process.env.PI_ACP_PATH_TEST

  process.env.PI_ACP_PATH_TEST = 'expanded'

  try {
    const sessionDir = join(root, 'project & (a) ^ 100% !PI_ACP_PATH_TEST! %PI_ACP_PATH_TEST%')
    mkdirSync(sessionDir)

    for (const launcherName of launchers) {
      const launcher = join(root, launcherName)
      if (process.platform === 'win32') {
        writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`)
      } else {
        writeFileSync(launcher, `#!/usr/bin/env node\nrequire('./fake-pi.cjs')\n`)
        chmodSync(launcher, 0o755)
      }

      const first = join(sessionDir, `${launcherName}-first.jsonl`)
      const second = join(sessionDir, `${launcherName}-second.jsonl`)

      for (const sessionPath of [first, second]) {
        const proc = await PiRpcProcess.spawn({ cwd: root, piCommand: launcher, sessionPath })
        proc.dispose()
      }

      assert.equal(readFileSync(first, 'utf8'), 'started\n')
      assert.equal(readFileSync(second, 'utf8'), 'started\n')
      assert.equal(existsSync(join(root, 'project')), false)
    }
  } finally {
    if (previousTestVar === undefined) delete process.env.PI_ACP_PATH_TEST
    else process.env.PI_ACP_PATH_TEST = previousTestVar
    await new Promise(resolve => setTimeout(resolve, 50))
    rmSync(root, { recursive: true, force: true })
  }
})

test(
  'PiRpcProcess keeps a simulated Windows cmd session path intact',
  { skip: process.platform === 'win32' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-cmd-'))
    writeFakePi(root)
    const launcher = join(root, 'pi.cmd')
    writeFileSync(launcher, "#!/usr/bin/env node\nrequire('./fake-pi.cjs')\n")
    chmodSync(launcher, 0o755)
    const sessionDir = join(root, 'my project')
    mkdirSync(sessionDir)
    const sessionPath = join(sessionDir, 'restored.jsonl')
    const originalPlatform = process.platform

    try {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      const proc = await PiRpcProcess.spawn({ cwd: root, piCommand: launcher, sessionPath })
      proc.dispose()
      assert.equal(readFileSync(sessionPath, 'utf8'), 'started\n')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
      await new Promise(resolve => setTimeout(resolve, 50))
      rmSync(root, { recursive: true, force: true })
    }
  }
)
