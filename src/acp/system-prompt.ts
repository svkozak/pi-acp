import { RequestError } from '@agentclientprotocol/sdk'
import type { SystemPrompt } from '../pi-rpc/system-prompt.js'

export function parseSystemPrompt(value: unknown): SystemPrompt | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && value.trim().length > 0) {
    return { mode: 'replace', text: value }
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'append' in value &&
    typeof value.append === 'string' &&
    Object.keys(value).length === 1
  ) {
    return { mode: 'append', text: value.append }
  }
  throw RequestError.invalidParams(
    '_meta.systemPrompt must be a nonempty string or an object containing only append: string'
  )
}
