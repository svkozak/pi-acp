/**
 * ACP's `usage_update` reports context occupancy against the model's window.
 * pi supplies the two halves from different places: the occupancy rides on
 * every assistant message, while the window is a property of the model and is
 * only stated in the model list.
 */

/**
 * Tokens currently in context, or null when pi reported nothing usable.
 * Mirrors pi's own accounting: prefer the provider's native total, and fall
 * back to summing the components when it omits one.
 */
export function contextTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== 'object') return null
  const u = usage as any

  const total = Number(u.totalTokens)
  if (Number.isFinite(total) && total > 0) return total

  const parts = [u.input, u.output, u.cacheRead, u.cacheWrite].map(n => Number(n))
  if (parts.some(n => !Number.isFinite(n))) return null

  // All-zero usage means the message never reached the model.
  const sum = parts.reduce((a, b) => a + b, 0)
  return sum > 0 ? sum : null
}

/** Context window for one model, read from a `get_available_models` payload. */
export function contextWindowFor(models: unknown, provider: string, id: string): number | null {
  const list = Array.isArray((models as any)?.models) ? (models as any).models : []
  const found = list.find((m: any) => String(m?.provider ?? '') === provider && String(m?.id ?? '') === id)

  const size = Number(found?.contextWindow)
  return Number.isFinite(size) && size > 0 ? size : null
}
