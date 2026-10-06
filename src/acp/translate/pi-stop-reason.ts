export type AcpCompletionStopReason = 'end_turn' | 'max_tokens'

export function piCompletionStopReason(messages: unknown): AcpCompletionStopReason {
  if (!Array.isArray(messages)) return 'end_turn'

  const assistant = [...messages]
    .reverse()
    .find(message => (message as { role?: unknown } | null)?.role === 'assistant') as
    | { stopReason?: unknown }
    | undefined

  return assistant?.stopReason === 'length' ? 'max_tokens' : 'end_turn'
}
