import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PiRpcProcess } from '../../src/pi-rpc/process.js'

test(
  'spawn passes private prompt files and cleans them on exit or spawn failure',
  { skip: process.platform === 'win32' },
  async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-spawn-prompt-'))
    const oldTmpdir = process.env.TMPDIR
    process.env.TMPDIR = root
    t.after(() => {
      if (oldTmpdir === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = oldTmpdir
      rmSync(root, { recursive: true, force: true })
    })
    const executable = join(root, 'fake-pi')
    writeFileSync(
      executable,
      `#!${process.execPath}
const fs = require('node:fs');
const readline = require('node:readline');
fs.writeFileSync('args.json', JSON.stringify(process.argv.slice(2)));
readline.createInterface({ input: process.stdin }).on('line', line => {
  const cmd = JSON.parse(line);
  console.log(JSON.stringify({ type: 'response', id: cmd.id, command: cmd.type, success: true, data: {} }));
});
`,
      { mode: 0o700 }
    )
    for (const mode of ['replace', 'append'] as const) {
      const text = '/etc/hosts\nLiteral $HOME and "quotes"'
      const proc = await PiRpcProcess.spawn({ cwd: root, piCommand: executable, systemPrompt: { mode, text } })
      const args = JSON.parse(readFileSync(join(root, 'args.json'), 'utf-8')) as string[]
      const path = args.at(-1)!
      try {
        assert.equal(args.at(-2), mode === 'replace' ? '--system-prompt' : '--append-system-prompt')
        assert.equal(readFileSync(path, 'utf-8'), text)
        assert.ok(!args.includes(text))
      } finally {
        proc.dispose()
      }
      for (let attempt = 0; existsSync(path) && attempt < 100; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(existsSync(path), false)
    }
    await assert.rejects(
      PiRpcProcess.spawn({
        cwd: root,
        piCommand: join(root, 'missing-executable'),
        systemPrompt: { mode: 'replace', text: 'instructions' }
      }),
      { name: 'PiRpcSpawnError', code: 'ENOENT' }
    )
    assert.deepEqual(
      readdirSync(root).filter(name => name.startsWith('pi-acp-prompt-')),
      []
    )
  }
)

test(
  'real Pi exports replacement and append from adapter spawn flags without model calls',
  {
    skip: process.env.PI_ACP_TEST_REAL_PI !== '1' || process.platform === 'win32'
  },
  async t => {
    const root = mkdtempSync(join(tmpdir(), 'pi-acp-real-prompt-'))
    t.after(() => rmSync(root, { recursive: true, force: true }))
    const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`
    const executable = join(root, 'isolated-pi')
    writeFileSync(
      executable,
      `#!/bin/sh\nexport PI_CODING_AGENT_DIR=${quote(join(root, 'agent'))}\nexec pi --offline --no-extensions --no-skills --no-context-files "$@"\n`,
      { mode: 0o700 }
    )
    const sessionPath = join(root, 'session.jsonl')
    const timestamp = '2026-01-01T00:00:00.000Z'
    writeFileSync(
      sessionPath,
      [
        { type: 'session', version: 3, id: crypto.randomUUID(), timestamp, cwd: root },
        {
          type: 'message',
          id: '00000001',
          parentId: null,
          timestamp,
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Synthetic fixture' }],
            timestamp: 1767225600000
          }
        }
      ]
        .map(entry => JSON.stringify(entry))
        .join('\n') + '\n'
    )
    for (const mode of ['replace', 'append'] as const) {
      const marker = 'ACP_NATIVE_SYSTEM_PROMPT_TEST'
      const proc = await PiRpcProcess.spawn({
        cwd: root,
        piCommand: executable,
        sessionPath,
        systemPrompt: { mode, text: marker }
      })
      try {
        const output = join(root, `${mode}.html`)
        await proc.exportHtml(output)
        const html = readFileSync(output, 'utf-8')
        const encoded = html.match(/<script id="session-data"[^>]*>([\s\S]*?)<\/script>/)?.[1]
        assert.ok(encoded)
        const data = JSON.parse(Buffer.from(encoded.trim(), 'base64').toString('utf-8')) as { systemPrompt: string }
        assert.equal(data.systemPrompt.split(marker).length - 1, 1)
        assert.equal(data.systemPrompt.includes('You are an expert coding assistant'), mode === 'append')
      } finally {
        proc.dispose()
      }
    }
  }
)
