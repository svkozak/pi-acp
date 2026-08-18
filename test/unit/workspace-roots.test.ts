import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { normalizeAdditionalDirectories } from '../../src/acp/workspace-roots.js'
import { buildWorkspaceRootsPrompt } from '../../src/pi-rpc/process.js'

const cwd = resolve('/work')

test('normalizeAdditionalDirectories: empty input activates no additional roots', () => {
  assert.deepEqual(normalizeAdditionalDirectories(undefined, cwd), [])
  assert.deepEqual(normalizeAdditionalDirectories(null, cwd), [])
  assert.deepEqual(normalizeAdditionalDirectories([], cwd), [])
})

test('normalizeAdditionalDirectories: keeps absolute paths and preserves order', () => {
  const a = resolve('/work/libs/a')
  const b = resolve('/work/docs/b')

  assert.deepEqual(normalizeAdditionalDirectories([a, b], cwd), [a, b])
})

test('normalizeAdditionalDirectories: drops duplicates and cwd itself', () => {
  const a = resolve('/work/libs/a')

  assert.deepEqual(normalizeAdditionalDirectories([a, a, cwd, resolve('/work')], cwd), [a])
})

test('normalizeAdditionalDirectories: rejects non-absolute entries', () => {
  assert.throws(
    () => normalizeAdditionalDirectories(['relative/path'], cwd),
    (e: any) => e?.code === -32602
  )
})

test('normalizeAdditionalDirectories: rejects non-string entries', () => {
  assert.throws(
    () => normalizeAdditionalDirectories([42] as any, cwd),
    (e: any) => e?.code === -32602
  )
})

test('buildWorkspaceRootsPrompt: lists cwd and additional roots with guidance', () => {
  const a = resolve('/work/libs/a')
  const b = resolve('/work/docs/b')

  const prompt = buildWorkspaceRootsPrompt(cwd, [a, b])

  assert.ok(prompt.includes('<workspace_roots>'))
  assert.ok(prompt.includes(`Primary working directory: ${cwd}`))
  assert.ok(prompt.includes(`- ${a}`))
  assert.ok(prompt.includes(`- ${b}`))
  assert.ok(prompt.includes('</workspace_roots>'))
  assert.ok(prompt.includes('Relative paths still resolve against the primary working directory.'))
})
