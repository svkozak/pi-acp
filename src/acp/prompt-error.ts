import { RequestError } from '@agentclientprotocol/sdk'

const FALLBACK = 'The agent could not complete the request. No error details were provided.'

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
  message = message.length > 4000 ? `${message.slice(0, 4000)}...` : message
  return RequestError.internalError(undefined, message)
}
