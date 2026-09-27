import test from 'node:test'
import assert from 'node:assert/strict'
import { toolResultTitle, toolResultToText } from '../../src/acp/translate/pi-tools.js'

test('toolResultToText: extracts text from content blocks', () => {
  const text = toolResultToText({
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: ' world' }
    ]
  })
  assert.equal(text, 'hello world')
})

test('toolResultToText: prefers details.diff when present', () => {
  const text = toolResultToText({
    content: [{ type: 'text', text: 'Successfully replaced 2 block(s) in a.txt.' }],
    details: { diff: '--- a\n+++ b\n' }
  })
  assert.equal(text, '--- a\n+++ b\n')
})

test('toolResultToText: falls back to JSON', () => {
  const text = toolResultToText({ a: 1 })
  assert.match(text, /"a": 1/)
})

test('toolResultToText: extracts bash stdout/stderr from details', () => {
  const text = toolResultToText({
    details: {
      stdout: 'ok\n',
      stderr: 'warn\n',
      exitCode: 0
    }
  })
  assert.match(text, /ok/)
  assert.match(text, /stderr:/)
  assert.match(text, /warn/)
  assert.match(text, /exit code: 0/)
})

test('toolResultTitle: includes a short plain-text result', () => {
  const result = { content: [{ type: 'text', text: 'Message sent to reviewer' }] }
  assert.equal(toolResultTitle('send_message', result), 'send_message: Message sent to reviewer')
})

test('toolResultTitle: includes a complete long plain-text result', () => {
  const receipt = '📨 Message sent to Add collapsed tool result summaries #127 (01a092c1-c274-7760-a17e-ad52c1bde03e).'

  assert.equal(toolResultTitle('send_message', receipt), `send_message: ${receipt}`)
})

test('toolResultTitle: keeps the tool name for unsuitable results', () => {
  const cases = [
    { content: [{ type: 'text', text: 'first line\nsecond line' }] },
    { content: [{ type: 'text', text: '{"status":"ok"}' }] },
    { content: [{ type: 'text', text: '   ' }] },
    {
      content: [
        { type: 'text', text: 'image generated' },
        { type: 'image', data: 'base64' }
      ]
    }
  ]

  for (const result of cases) assert.equal(toolResultTitle('tool', result), 'tool')
})

test('toolResultTitle: keeps the tool name when surrounding whitespace contains line breaks', () => {
  const result = { content: [{ type: 'text', text: '\nDone\n' }] }
  assert.equal(toolResultTitle('tool', result), 'tool')
})

test('toolResultTitle: keeps the tool name when individual text blocks are structured', () => {
  const result = {
    content: [
      { type: 'text', text: '{"a":1}' },
      { type: 'text', text: '{"b":2}' }
    ]
  }
  assert.equal(toolResultTitle('tool', result), 'tool')
})

test('toolResultTitle: preserves specialized tool titles', () => {
  const result = { content: [{ type: 'text', text: 'ok' }] }

  for (const toolName of ['bash', 'read', 'write', 'edit']) {
    assert.equal(toolResultTitle(toolName, result), toolName)
  }
})
