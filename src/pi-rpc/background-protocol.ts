export const BACKGROUND_STATUS_KEY = 'pi-acp/background'
export const BACKGROUND_COMMAND = 'pi-acp-background'

export interface BackgroundJob {
  id: string
  title: string
  asyncDir?: string
  mode?: string
}

export type BackgroundMessage =
  | {
      version: 1
      type: 'snapshot'
      active: BackgroundJob[]
      idle: boolean
      finished?: { id: string; title: string; status: 'completed' | 'failed'; text?: string }
    }
  | { version: 1; type: 'ready' }
  | { version: 1; type: 'error'; message: string }
  | { version: 1; type: 'cancelled'; error?: string }

export function parseBackgroundMessage(text: string): BackgroundMessage {
  const value: unknown = JSON.parse(text)
  const record = (item: unknown): item is Record<string, unknown> =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
  const job = (item: unknown): item is BackgroundJob =>
    record(item) &&
    typeof item.id === 'string' &&
    item.id.length > 0 &&
    typeof item.title === 'string' &&
    (item.mode === undefined || typeof item.mode === 'string') &&
    (item.asyncDir === undefined || typeof item.asyncDir === 'string')
  if (record(value) && value.version === 1) {
    if (value.type === 'ready') return { version: 1, type: 'ready' }
    if (value.type === 'error' && typeof value.message === 'string')
      return { version: 1, type: 'error', message: value.message }
    if (value.type === 'cancelled' && (value.error === undefined || typeof value.error === 'string'))
      return value as BackgroundMessage
    if (
      value.type === 'snapshot' &&
      typeof value.idle === 'boolean' &&
      Array.isArray(value.active) &&
      value.active.every(job) &&
      (value.finished === undefined ||
        (job(value.finished) &&
          record(value.finished) &&
          ['completed', 'failed'].includes(String(value.finished.status)) &&
          (value.finished.text === undefined || typeof value.finished.text === 'string')))
    ) {
      return value as BackgroundMessage
    }
  }
  throw new Error('Invalid background lifecycle message')
}
