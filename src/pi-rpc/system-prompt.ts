import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type SystemPrompt = { mode: 'replace' | 'append'; text: string }

export function prepareSystemPrompt(prompt?: SystemPrompt): { args: string[]; dispose: () => void } {
  if (!prompt) return { args: [], dispose: () => {} }

  const directory = mkdtempSync(join(tmpdir(), 'pi-acp-prompt-'))
  const dispose = () => {
    rmSync(directory, { recursive: true, force: true })
  }
  try {
    const path = join(directory, 'prompt.md')
    writeFileSync(path, prompt.text, { encoding: 'utf-8', mode: 0o600, flag: 'wx' })
    return {
      args: [prompt.mode === 'replace' ? '--system-prompt' : '--append-system-prompt', path],
      dispose
    }
  } catch (error) {
    dispose()
    throw error
  }
}
