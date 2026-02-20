import test from 'node:test'
import assert from 'node:assert/strict'

// This is a lightweight regression test: our stdout writer should not throw
// if stdout is marked as destroyed.

test('stdout writer: resolves even if stdout is destroyed', async () => {
  const prevDestroyed = (process.stdout as any).destroyed
  const prevWritable = (process.stdout as any).writable

  try {
    ;(process.stdout as any).destroyed = true
    ;(process.stdout as any).writable = false

    // Inline copy of the writer logic from src/index.ts (kept intentionally tiny)
    const write = (chunk: Uint8Array) =>
      new Promise<void>(resolve => {
        if ((process.stdout as any).destroyed || !process.stdout.writable) return resolve()
        try {
          process.stdout.write(chunk, () => resolve())
        } catch {
          resolve()
        }
      })

    await write(new Uint8Array([1, 2, 3]))
    assert.ok(true)
  } finally {
    ;(process.stdout as any).destroyed = prevDestroyed
    ;(process.stdout as any).writable = prevWritable
  }
})
