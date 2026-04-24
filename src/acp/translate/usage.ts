/**
 * Translate pi assistant-message `usage` payloads (see @mariozechner/pi-ai `Usage`) into a
 * compact per-turn + cumulative shape, plus a human-readable status line.
 *
 * Pi emits `message_end` events for each assistant message. On `assistant` messages the
 * attached `usage` looks like:
 *   {
 *     input, output, cacheRead, cacheWrite, totalTokens,
 *     cost: { input, output, cacheRead, cacheWrite, total }
 *   }
 *
 * Since pi issues multiple assistant messages per ACP prompt turn (one per model call
 * in the agent loop), we accumulate them across the turn and over the whole session.
 */

export type PiUsage = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

export type UsageSnapshot = {
  /** Tokens used by the current model's last assistant turn (final call of a prompt). */
  lastTurnTokens: number
  /** Cost of the current model's last assistant turn (final call of a prompt). */
  lastTurnCost: number
  /** Running total for the session. */
  sessionInputTokens: number
  sessionOutputTokens: number
  sessionCacheReadTokens: number
  sessionCacheWriteTokens: number
  sessionTotalTokens: number
  sessionCost: number
  /** Size of the most recent assistant message's context window (if known). */
  contextWindow: number | null
  /**
   * Best-effort context window fill % based on the **most recent** assistant message's
   * input+cacheRead+cacheWrite. Pi reports per-call input, which after a tool loop
   * approximates the prompt size going into the final model call.
   */
  contextFillRatio: number | null
}

export function emptyUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  }
}

export function parsePiUsage(raw: unknown): PiUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

  const cost = (r.cost ?? {}) as Record<string, unknown>

  return {
    input: num(r.input),
    output: num(r.output),
    cacheRead: num(r.cacheRead),
    cacheWrite: num(r.cacheWrite),
    totalTokens: num(r.totalTokens),
    cost: {
      input: num(cost.input),
      output: num(cost.output),
      cacheRead: num(cost.cacheRead),
      cacheWrite: num(cost.cacheWrite),
      total: num(cost.total)
    }
  }
}

export function addUsage(a: PiUsage, b: PiUsage): PiUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total
    }
  }
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function formatCost(n: number): string {
  if (n === 0) return '$0.00'
  if (n < 0.01) return `$${n.toFixed(4)}`
  if (n < 1) return `$${n.toFixed(3)}`
  return `$${n.toFixed(2)}`
}

/**
 * Render a compact one-line status suitable for a client that only displays text.
 *
 * Example: `↓ 1.2k · ↑ 342 · cache r 8.5k / w 200 · $0.024 · ctx 3% (1M)`
 */
export function formatUsageStatus(snap: UsageSnapshot, opts?: { includeSessionTotal?: boolean }): string {
  const parts: string[] = []

  parts.push(`↓ ${formatTokens(snap.sessionInputTokens)}`)
  parts.push(`↑ ${formatTokens(snap.sessionOutputTokens)}`)

  if (snap.sessionCacheReadTokens || snap.sessionCacheWriteTokens) {
    parts.push(`cache r ${formatTokens(snap.sessionCacheReadTokens)} / w ${formatTokens(snap.sessionCacheWriteTokens)}`)
  }

  if (snap.sessionCost > 0) parts.push(formatCost(snap.sessionCost))

  if (snap.contextFillRatio !== null && snap.contextWindow) {
    const pct = Math.min(100, Math.max(0, Math.round(snap.contextFillRatio * 100)))
    parts.push(`ctx ${pct}% (${formatTokens(snap.contextWindow)})`)
  }

  if (opts?.includeSessionTotal && snap.lastTurnTokens) {
    parts.push(`turn ${formatTokens(snap.lastTurnTokens)} / ${formatCost(snap.lastTurnCost)}`)
  }

  return parts.join(' · ')
}
