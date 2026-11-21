import { RequestError } from '@agentclientprotocol/sdk'
import { getAuthMethods } from './auth.js'

const FALLBACK = 'The agent could not complete the request. No error details were provided.'
const AUTH_FAILURE_PATTERNS = [
  /\b401\b|\bunauthorized\b|\bauthentication(?:_error|\s+(?:failed|required))\b/i,
  /\b(?:invalid|incorrect|expired|missing|revoked)\s+(?:api[ _-]?key|(?:(?:authentication|access|refresh|auth)\s+)?token|credentials?)\b/i,
  /\b(?:api[ _-]?key|token|credentials?)\s+(?:(?:is|has|was)\s+)?(?:invalid|incorrect|expired|missing|revoked|required|not (?:valid|found|configured|set|provided))\b/i,
  /\bno\s+(?:api[ _-]?key|credentials?)\b/i
]

function messageOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (value && typeof value === 'object' && 'message' in value && typeof value.message === 'string') {
    return value.message.trim() || undefined
  }
  return undefined
}

export function toPromptError(error: unknown): RequestError {
  if (error instanceof RequestError) return error

  let message = messageOf(error) ?? FALLBACK
  const match = message.match(/^(?:(?<status>\d{3}):?\s+)?(?<body>\{[\s\S]*\})$/)
  if (match?.groups) {
    const { status, body } = match.groups
    try {
      const parsed: unknown = JSON.parse(body)
      const nested = parsed && typeof parsed === 'object' && 'error' in parsed ? parsed.error : undefined
      message = `${status ? `${status}: ` : ''}${messageOf(nested) ?? messageOf(parsed) ?? FALLBACK}`
    } catch {
      // Preserve non-JSON provider explanations.
    }
  }
  const authRequired = AUTH_FAILURE_PATTERNS.some(pattern => pattern.test(message))
  message = message.length > 4000 ? `${message.slice(0, 4000)}...` : message
  if (authRequired) return RequestError.authRequired({ authMethods: getAuthMethods() }, message)
  return RequestError.internalError(undefined, message)
}
